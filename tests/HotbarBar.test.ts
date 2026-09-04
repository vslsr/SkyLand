import assert from 'node:assert/strict';
import test from 'node:test';
import { HotbarBar } from '../src/ui/HotbarBar.ts';
import type { HotbarSlotView } from '../src/inventory/index.ts';

/**
 * 只实现快捷栏真正用到的那点 DOM。
 *
 * 重点是 `dataset` 与 `style`：一格现在是什么状态全写在 data 属性上，进度圈靠
 * 自定义属性，测试要能读回这两样。
 */
class FakeElement extends EventTarget {
  public className = '';
  public hidden = false;
  public type = '';
  public textContent = '';
  public innerHTML = '';
  public id = '';
  public readonly dataset: Record<string, string | undefined> = {};
  public readonly style: Record<string, string> & {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  public children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();

  public constructor(public readonly tagName: string) {
    super();
    const properties: Record<string, string> = {};
    this.style = Object.assign(properties, {
      setProperty: (name: string, value: string) => { properties[name] = value; },
      removeProperty: (name: string) => { delete properties[name]; },
    }) as typeof this.style;
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  public remove(): void {
    // 这些测试只造一棵树，不需要真的从父节点上摘下来。
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public collect(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      found.push(...child.collect(predicate));
    }
    return found;
  }
}

class FakeDocument {
  public readonly body = new FakeElement('body');
  private readonly byId = new Map<string, FakeElement>();

  public createElement(tagName: string): HTMLElement {
    return new FakeElement(tagName) as unknown as HTMLElement;
  }

  public createElementNS(_namespace: string, tagName: string): SVGElement {
    const element = new FakeElement(tagName);
    Object.defineProperty(element, 'id', {
      get: () => this.ids.get(element) ?? '',
      set: (value: string) => { this.ids.set(element, value); this.byId.set(value, element); },
      configurable: true,
    });
    return element as unknown as SVGElement;
  }

  public getElementById(id: string): HTMLElement | null {
    return (this.byId.get(id) ?? null) as unknown as HTMLElement | null;
  }

  private readonly ids = new WeakMap<FakeElement, string>();
}

function withFakeDocument<T>(run: () => T): T {
  const previous = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    value: new FakeDocument(),
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

function slot(index: number, overrides: Partial<HotbarSlotView> = {}): HotbarSlotView {
  return {
    index,
    quantity: 0,
    active: false,
    usable: true,
    ...overrides,
  };
}

function slotsOf(bar: HotbarBar): FakeElement[] {
  const root = bar.element as unknown as FakeElement;
  return root.collect((element) => element.className === 'hotbar__slot');
}

function plateOf(bar: HotbarBar): FakeElement {
  const root = bar.element as unknown as FakeElement;
  const plate = root.collect((element) => element.className === 'hotbar__plate')[0];
  assert.ok(plate, '没有牌子');
  return plate;
}

/** 每一格上盖着的那圈圆形倒计时。 */
function dialsOf(bar: HotbarBar): FakeElement[] {
  const root = bar.element as unknown as FakeElement;
  return root.collect((element) => element.className === 'hotbar__dial');
}

test('一格只写一种状态：空 / 有货，拿在手上的只有一格', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([
      slot(0),
      slot(1, { itemType: 'wood', displayName: '木头', quantity: 4 }),
      // 物品栏自己持有那一摞，用光的格子直接空出来，没有「配置还在货没了」这一态。
      slot(2, { itemType: 'stone', displayName: '石头', quantity: 0 }),
      slot(3, { itemType: 'torch', displayName: '火把', quantity: 2, active: true }),
    ]);

    const buttons = slotsOf(bar);
    assert.deepEqual(
      buttons.map((button) => button.dataset.state),
      ['empty', 'ready', 'empty', 'ready'],
    );
    assert.deepEqual(
      buttons.map((button) => button.dataset.held),
      ['false', 'false', 'false', 'true'],
    );
    assert.deepEqual(
      buttons.map((button) => button.getAttribute('aria-pressed')),
      ['false', 'false', 'false', 'true'],
    );
    assert.match(buttons[3].getAttribute('aria-label') ?? '', /正拿在手上/);
  });
});

test('鼠标按下不留焦点：焦点圈和「拿在手上」不会同时亮在两格上', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([slot(0, { itemType: 'wood', displayName: '木头', quantity: 1 })]);
    const button = slotsOf(bar)[0];

    const pointerDown = new Event('pointerdown', { cancelable: true });
    button.dispatchEvent(pointerDown);
    assert.equal(pointerDown.defaultPrevented, true, '按下那一下要吃掉默认的取焦');

    const picked: number[] = [];
    bar.onSelect((index) => picked.push(index));
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(picked, [0], '取焦被挡掉，点击照常报序号');
  });
});

test('牌子平时写手上拿的是什么，按住时改写这次按住', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    const plate = plateOf(bar);
    assert.equal(plate.hidden, true, '什么都没拿的时候整块收起来');

    bar.setSlots([
      slot(0, { itemType: 'wood', displayName: '木头', quantity: 4 }),
      slot(1, { itemType: 'torch', displayName: '火把', quantity: 2, active: true }),
    ]);
    assert.equal(plate.hidden, false);
    assert.equal(plate.textContent, '火把');

    bar.setProgress({ action: 'throw', mode: 'hold', ratio: 0.5, label: '投掷「火把」', onHotbar: true });
    assert.equal(plate.textContent, '投掷「火把」');
    assert.equal(plate.dataset.progress, 'true');

    bar.setProgress(undefined);
    assert.equal(plate.textContent, '火把', '松开就说回手上拿的是什么');
    assert.equal(plate.dataset.progress, '');
  });
});

test('圆形倒计时盖在手持那一格上，换手时旧格子上的圈被抹掉', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([
      slot(0, { itemType: 'wood', displayName: '木头', quantity: 4, active: true }),
      slot(1, { itemType: 'torch', displayName: '火把', quantity: 2 }),
    ]);
    bar.setProgress({ action: 'eat', mode: 'hold', ratio: 0.25, label: '吃下「果子」', onHotbar: true });

    const buttons = slotsOf(bar);
    const dials = dialsOf(bar);
    assert.equal(buttons[0].dataset.progress, 'eat');
    assert.equal(dials[0].hidden, false);
    assert.equal(dials[0].style['--hotbar-progress'], '25%');
    assert.equal(dials[1].hidden, true, '没拿在手上的那一格不画圈');
    assert.equal(buttons[1].dataset.progress, undefined);

    bar.setSlots([
      slot(0, { itemType: 'wood', displayName: '木头', quantity: 4 }),
      slot(1, { itemType: 'torch', displayName: '火把', quantity: 2, active: true }),
    ]);
    assert.equal(buttons[0].dataset.progress, undefined, '换手后旧格子上不能留着半圈');
    assert.equal(dials[0].hidden, true);
    assert.equal(dials[0].style['--hotbar-progress'], undefined);
    assert.equal(plateOf(bar).textContent, '火把');
  });
});

test('不属于物品栏的那次按住不在格子上画圈：同一件事不画两遍', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([slot(0, { itemType: 'wood', displayName: '木头', quantity: 4, active: true })]);
    // 背包里点出来的用法没有格子，它的圈在准星下方那块牌子上。
    bar.setProgress({ action: 'eat', mode: 'hold', ratio: 0.9, label: '吃下「果子」', onHotbar: false });

    assert.equal(slotsOf(bar)[0].dataset.progress, undefined);
    assert.equal(dialsOf(bar)[0].hidden, true);
    assert.equal(plateOf(bar).textContent, '木头', '牌子仍然只说手上拿的是什么');
  });
});

test('空格拿不到手上，没有圈也没有牌子', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([slot(0, { itemType: 'stone', displayName: '石头', quantity: 0, active: true })]);
    bar.setProgress({ action: 'eat', mode: 'hold', ratio: 0.9, label: '吃下「果子」', onHotbar: true });

    const button = slotsOf(bar)[0];
    assert.equal(button.dataset.state, 'empty');
    assert.equal(button.dataset.progress, undefined);
    assert.equal(dialsOf(bar)[0].hidden, true);
    assert.equal(plateOf(bar).hidden, true);
  });
});

test('换了图标就要重画：签名把画出来的每一样都算进去', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([slot(0, { itemType: 'wood', displayName: '木头', iconId: 'item-wood', quantity: 1 })]);
    const figure = (bar.element as unknown as FakeElement)
      .collect((element) => element.className === 'hotbar__figure')[0];
    const before = figure.children[0];

    bar.setSlots([slot(0, { itemType: 'wood', displayName: '木头', iconId: 'item-stone', quantity: 1 })]);
    assert.notEqual(figure.children[0], before, '图标换了却没重画');
  });
});

test('装着弹药的那一格写出还剩几发，拉满的蓄力圈自己有个记号', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    const loaded = {
      itemType: 'stone',
      quantity: 3,
      displayName: '石头',
      iconId: 'item-stone',
      tint: '#B9B4A8',
      capacity: 5,
    };
    bar.setSlots([
      slot(0, { itemType: 'slingshot', displayName: '弹弓', quantity: 1, active: true, ammo: loaded }),
      slot(1, { itemType: 'wood', displayName: '木头', quantity: 4 }),
    ]);
    const root = bar.element as unknown as FakeElement;
    const ammo = root.collect((element) => element.className === 'hotbar__ammo');
    assert.equal(ammo[0].hidden, false);
    assert.equal(ammo[0].textContent, '3');
    assert.equal(ammo[1].hidden, true, '不装弹药的格子上不画这个数');
    assert.ok(
      slotsOf(bar)[0].getAttribute('aria-label')?.includes('装着 3 发石头'),
      slotsOf(bar)[0].getAttribute('aria-label') ?? '',
    );

    // 蓄力拉满了停在满圈上等松手，所以「满了」要看得出来。
    bar.setProgress({ action: 'shoot', mode: 'charge', ratio: 0.5, label: '发射「弹弓」', onHotbar: true });
    assert.equal(dialsOf(bar)[0].dataset.charged, 'false');
    bar.setProgress({ action: 'shoot', mode: 'charge', ratio: 1, label: '发射「弹弓」', onHotbar: true });
    assert.equal(dialsOf(bar)[0].dataset.charged, 'true');

    // 打掉一发之后这一格看得见地变了：签名要认得出来，不然停在旧发数上。
    bar.setSlots([
      slot(0, { itemType: 'slingshot', displayName: '弹弓', quantity: 1, active: true, ammo: { ...loaded, quantity: 2 } }),
      slot(1, { itemType: 'wood', displayName: '木头', quantity: 4 }),
    ]);
    assert.equal(root.collect((element) => element.className === 'hotbar__ammo')[0].textContent, '2');
  });
});

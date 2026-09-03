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

test('一格只写一种状态：空 / 有货 / 用光，拿在手上的只有一格', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([
      slot(0),
      slot(1, { itemType: 'wood', displayName: '木材', quantity: 4 }),
      slot(2, { itemType: 'bandage', displayName: '绷带', quantity: 0 }),
      slot(3, { itemType: 'torch', displayName: '火把', quantity: 2, active: true }),
    ]);

    const buttons = slotsOf(bar);
    assert.deepEqual(
      buttons.map((button) => button.dataset.state),
      ['empty', 'ready', 'depleted', 'ready'],
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
    bar.setSlots([slot(0, { itemType: 'wood', displayName: '木材', quantity: 1 })]);
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
      slot(0, { itemType: 'wood', displayName: '木材', quantity: 4 }),
      slot(1, { itemType: 'torch', displayName: '火把', quantity: 2, active: true }),
    ]);
    assert.equal(plate.hidden, false);
    assert.equal(plate.textContent, '火把');

    bar.setProgress({ kind: 'charge', ratio: 0.5, label: '蓄力' });
    assert.equal(plate.textContent, '蓄力');
    assert.equal(plate.dataset.progress, 'true');

    bar.setProgress(undefined);
    assert.equal(plate.textContent, '火把', '松开就说回手上拿的是什么');
    assert.equal(plate.dataset.progress, '');
  });
});

test('进度圈画在手持那一格上，换手时旧格子上的圈被抹掉', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([
      slot(0, { itemType: 'wood', displayName: '木材', quantity: 4, active: true }),
      slot(1, { itemType: 'torch', displayName: '火把', quantity: 2 }),
    ]);
    bar.setProgress({ kind: 'stow', ratio: 0.25, label: '收回背包' });

    const buttons = slotsOf(bar);
    assert.equal(buttons[0].dataset.progress, 'stow');
    assert.equal(buttons[0].style['--hotbar-progress'], '25%');
    assert.equal(buttons[1].dataset.progress, undefined);

    bar.setSlots([
      slot(0, { itemType: 'wood', displayName: '木材', quantity: 4 }),
      slot(1, { itemType: 'torch', displayName: '火把', quantity: 2, active: true }),
    ]);
    assert.equal(buttons[0].dataset.progress, undefined, '换手后旧格子上不能留着半圈');
    assert.equal(buttons[0].style['--hotbar-progress'], undefined);
    assert.equal(plateOf(bar).textContent, '火把');
  });
});

test('货用光的那一格拿不到手上，没有圈也没有牌子', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([slot(0, { itemType: 'bandage', displayName: '绷带', quantity: 0, active: true })]);
    bar.setProgress({ kind: 'charge', ratio: 0.9, label: '蓄力' });

    const button = slotsOf(bar)[0];
    assert.equal(button.dataset.state, 'depleted');
    assert.equal(button.dataset.progress, undefined);
    assert.equal(plateOf(bar).hidden, true);
  });
});

test('换了图标就要重画：签名把画出来的每一样都算进去', () => {
  withFakeDocument(() => {
    const bar = new HotbarBar();
    bar.setSlots([slot(0, { itemType: 'wood', displayName: '木材', iconId: 'item-wood', quantity: 1 })]);
    const figure = (bar.element as unknown as FakeElement)
      .collect((element) => element.className === 'hotbar__figure')[0];
    const before = figure.children[0];

    bar.setSlots([slot(0, { itemType: 'wood', displayName: '原木', iconId: 'item-wood-log', quantity: 1 })]);
    assert.notEqual(figure.children[0], before, '图标换了却没重画');
  });
});

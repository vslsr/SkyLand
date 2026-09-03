import assert from 'node:assert/strict';
import test from 'node:test';
import { InventoryPage } from '../src/ui/pages/InventoryPage.ts';
import { buildInventoryView } from '../src/inventory/index.ts';
import { InventoryComponent } from '../shared/actor/index.mjs';
import { itemCatalog } from '../shared/items/index.mjs';

class FakeElement extends EventTarget {
  public className = '';
  public hidden = false;
  public id = '';
  public textContent = '';
  public innerHTML = '';
  public tabIndex = 0;
  public type = '';
  public readonly dataset: Record<string, string> = {};
  public children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly classes = new Set<string>();

  public constructor(public readonly tagName: string) {
    super();
  }

  /** 只实现界面真正用到的三个方法；className 与它保持同步，断言两种写法都读得到。 */
  public readonly classList = {
    add: (name: string) => { this.classes.add(name); this.syncClassName(); },
    remove: (name: string) => { this.classes.delete(name); this.syncClassName(); },
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      this.syncClassName();
    },
    contains: (name: string) => this.classes.has(name) || this.className.split(' ').includes(name),
  };

  private syncClassName(): void {
    const base = this.className.split(' ').filter((name) => name && !this.classes.has(name));
    this.className = [...base, ...this.classes].join(' ');
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** 深度优先收集子树里符合条件的元素，代替 querySelectorAll。 */
  public collect(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      found.push(...child.collect(predicate));
    }
    return found;
  }

  public get text(): string {
    return this.textContent || this.children.map((child) => child.text).join('');
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
    // sprite 注入时按 id 查重，所以这里要能查回去。
    Object.defineProperty(element, 'id', {
      get: () => this.idOf(element),
      set: (value: string) => this.register(element, value),
      configurable: true,
    });
    return element as unknown as SVGElement;
  }

  public getElementById(id: string): HTMLElement | null {
    return (this.byId.get(id) ?? null) as unknown as HTMLElement | null;
  }

  private readonly ids = new WeakMap<FakeElement, string>();

  private idOf(element: FakeElement): string {
    return this.ids.get(element) ?? '';
  }

  private register(element: FakeElement, value: string): void {
    this.ids.set(element, value);
    this.byId.set(value, element);
  }
}

function withFakeDocument<T>(run: (document: FakeDocument) => T): T {
  const previous = globalThis.document;
  const fake = new FakeDocument();
  Object.defineProperty(globalThis, 'document', {
    value: fake,
    configurable: true,
    writable: true,
  });
  try {
    return run(fake);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

function cellsOf(page: InventoryPage, className: string): FakeElement[] {
  const root = page.element as unknown as FakeElement;
  return root.collect((element) => element.className.split(' ').includes(className));
}

function inventoryView(slotCapacity: number, entries: [string, number][]) {
  const inventory = new InventoryComponent({ slotCapacity });
  for (const [itemType, quantity] of entries) inventory.add(itemType, quantity);
  return buildInventoryView(inventory as never);
}

test('还剩几格靠空格子自己说，不再另画一行读数', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 12], ['spice-bundle', 1]]));

    const cells = cellsOf(page, 'inventory__cell');
    assert.equal(cells.length, 6, '两格有货 + 四格空位');
    const empty = cellsOf(page, 'inventory__cell--empty');
    assert.equal(empty.length, 4);
    assert.equal(empty[0].getAttribute('aria-label'), '空格子');

    // 「货位 2 / 6」加一条进度条是把同一件事又说了一遍：空格本来就画成虚线方格。
    assert.equal(cellsOf(page, 'inventory__capacity').length, 0);
    assert.equal(cellsOf(page, 'inventory__meter').length, 0);
    // 剩下的那一行只说「有话要说」的事（待兑现、违禁品、满了），不报数。
    const ledger = cellsOf(page, 'inventory__ledger')[0];
    assert.ok(!ledger.textContent.includes('/'), `不该再有读数：${ledger.textContent}`);

    // 没话说的时候整行收起来，不留一条空白。
    page.setInventory(inventoryView(6, []));
    assert.equal(cellsOf(page, 'inventory__ledger')[0].hidden, true);
  });
});

test('装满了才出那一句提醒，而且说的是「满了」不是一个数', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(2, [['wood', 3], ['stone', 4]]));
    const ledger = cellsOf(page, 'inventory__ledger')[0];
    assert.equal(ledger.hidden, false);
    assert.ok(ledger.textContent.includes('背包满了'), ledger.textContent);
  });
});

test('格子带上物品分类、数量与售价，违禁品单独标记', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(8, [['crown-relic', 1], ['wood', 5]]));

    const cells = cellsOf(page, 'inventory__cell')
      .filter((cell) => cell.dataset.itemType !== undefined);
    const crown = cells.find((cell) => cell.dataset.itemType === 'crown-relic');
    assert.ok(crown);
    assert.equal(crown.dataset.category, 'valuable');
    assert.equal(crown.dataset.contraband, 'true');
    assert.ok(crown.getAttribute('aria-label')?.includes('王冠遗物'));
    // 大件才画「几格」角标；一格的东西不用占视觉。
    assert.equal(crown.text.includes('3 格'), true);
    assert.equal(crown.text.includes(`${itemCatalog.require('crown-relic').coinValue} 金币`), true);

    const wood = cells.find((cell) => cell.dataset.itemType === 'wood');
    assert.ok(wood);
    assert.equal(wood.dataset.contraband, undefined);
    assert.equal(wood.text.includes('格'), false);

    const ledger = cellsOf(page, 'inventory__ledger')[0];
    assert.ok(ledger.textContent.includes('待兑现'));
    assert.ok(ledger.textContent.includes('违禁品'));
  });
});

test('不占货位的物品和别的物品排在一起，靠标记区分而不是靠分区', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(4, [['wood', 3], ['light-ammo', 60]]));

    // 分类页签接管了分组，所以不再有第二个网格把同一堆货画两遍。
    assert.equal(cellsOf(page, 'inventory__grid--pooled')[0].children.length, 0);
    // 全部页：木材 + 弹药 + 三个空货位。弹药不吃格数，空格仍然是三个。
    assert.equal(cellsOf(page, 'inventory__cell').length, 2 + 3);

    const ammo = cellsOf(page, 'inventory__cell')
      .find((cell) => cell.dataset.itemType === 'light-ammo');
    assert.ok(ammo, '弹药出现在全部页里');
    assert.ok(ammo.text.includes('不占格'), '靠格子上的标记说明它不吃货位');
  });
});

test('分类页签第一页是全部，空分类不出现', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 3], ['light-ammo', 60]]));
    const tabs = cellsOf(page, 'inventory__tab');
    assert.deepEqual(
      cellsOf(page, 'inventory__tab-label').map((label) => label.textContent),
      ['全部', '材料', '弹药'],
      '只有身上真有的分类才给页签',
    );
    // 数量是独立的一个附注元素，不再拼进标签文字里——「全部 0」读起来像一个词。
    assert.deepEqual(
      cellsOf(page, 'inventory__tab-count').map((count) => count.textContent),
      ['2', '1', '1'],
    );
    assert.ok(tabs[0].className.includes('is-active'), '默认停在全部页');
  });
});

test('可手持的格子点一下就交出物品种类，拿不到手上的不响应', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    const held: string[] = [];
    page.onHold((itemType) => held.push(itemType));
    page.setInventory(inventoryView(6, [['wood', 3], ['light-ammo', 60]]));

    for (const cell of cellsOf(page, 'inventory__cell')) {
      cell.dispatchEvent(new Event('click'));
    }
    assert.deepEqual(held, ['wood'], '弹药拿不到手上，点了不该有反应');
  });
});

test('没有权威数据时显示空态，关闭提示跟着按键走', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    const notice = cellsOf(page, 'inventory__empty-notice')[0];
    assert.equal(notice.hidden, false, '构造完还没有数据，先显示空态');

    page.setInventory(inventoryView(4, [['stone', 1]]));
    assert.equal(notice.hidden, true);

    page.setInventory(undefined);
    assert.equal(notice.hidden, false);
    assert.equal(cellsOf(page, 'inventory__cell').length, 0);
    assert.equal(cellsOf(page, 'inventory__tab').length, 0);

    const hint = cellsOf(page, 'inventory__hint')[0];
    assert.equal(hint.textContent, 'Esc 关闭');
    page.setCloseHint('B');
    assert.equal(hint.textContent, 'Esc 或 B 关闭');
  });
});

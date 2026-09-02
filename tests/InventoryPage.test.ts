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
  public readonly dataset: Record<string, string> = {};
  public children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();

  public constructor(public readonly tagName: string) {
    super();
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

test('背包界面把空货位也画成格子，货位统计跟着内容走', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 12], ['spice-bundle', 1]]));

    const cells = cellsOf(page, 'inventory__cell');
    assert.equal(cells.length, 6, '两格有货 + 四格空位');
    const empty = cellsOf(page, 'inventory__cell--empty');
    assert.equal(empty.length, 4);
    assert.equal(empty[0].getAttribute('aria-label'), '空货位');

    const capacity = cellsOf(page, 'inventory__capacity')[0];
    assert.equal(capacity.textContent, '货位 2 / 6');
    const meter = cellsOf(page, 'inventory__meter-fill')[0];
    assert.equal(meter.getAttribute('style'), 'width:33%');
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

test('不占货位的物品单独分区，没有时整段收起来', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(4, [['wood', 3]]));
    const pooledGrid = cellsOf(page, 'inventory__grid--pooled')[0];
    assert.equal(pooledGrid.children.length, 0);

    page.setInventory(inventoryView(4, [['wood', 3], ['light-ammo', 60]]));
    assert.equal(pooledGrid.children.length, 1);
    assert.equal(pooledGrid.children[0].dataset.itemType, 'light-ammo');
    // 弹药不占货位，所以随身格子还是「一格有货 + 三格空」。
    assert.equal(cellsOf(page, 'inventory__cell').length, 4 + 1);
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
    assert.equal(cellsOf(page, 'inventory__capacity')[0].textContent, '货位 —');
    assert.equal(cellsOf(page, 'inventory__cell').length, 0);

    const hint = cellsOf(page, 'inventory__hint')[0];
    assert.equal(hint.textContent, 'Esc 关闭');
    page.setCloseHint('B');
    assert.equal(hint.textContent, 'Esc 或 B 关闭');
  });
});

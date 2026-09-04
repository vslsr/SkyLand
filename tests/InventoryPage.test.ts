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
  public disabled = false;
  /** 拖拽用：界面给拖得动的格子写 true，测试要读得回来。 */
  public draggable = false;
  /** 菜单摆位会写 left/top；没有排版引擎，这里只要写得进去。 */
  public readonly style: Record<string, string> = {};
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

  public remove(): void {
    // 这些测试只造一棵树，不需要真的从父节点上摘下来。
  }

  /** 菜单靠它判断「点的是不是自己」。 */
  public contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
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

class FakeDocument extends EventTarget {
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

/**
 * 顶掉 `document` 与 `window`。
 *
 * `window` 也要有：弹出的动作菜单会在它上面挂一个 resize 关闭监听——菜单是按当时
 * 的格子位置摆的，窗口一变它就指错地方。
 */
function withFakeDocument<T>(run: (document: FakeDocument) => T): T {
  const previousDocument = globalThis.document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const fake = new FakeDocument();
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  define('document', fake);
  define('window', new EventTarget());
  try {
    return run(fake);
  } finally {
    define('document', previousDocument);
    define('window', previousWindow);
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
    assert.equal(cellsOf(page, 'inventory__grid--pooled').length, 0);
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

function menuEntries(page: InventoryPage): FakeElement[] {
  return cellsOf(page, 'inventory-menu__entry');
}

function clickCell(page: InventoryPage, itemType: string): void {
  const cell = cellsOf(page, 'inventory__cell')
    .find((candidate) => candidate.dataset.itemType === itemType);
  assert.ok(cell, `没有 ${itemType} 这一格`);
  cell.dispatchEvent(new Event('click'));
}

test('可手持的格子点一下弹出动作菜单，拿不到手上的不响应', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 3], ['light-ammo', 60]]));
    const menu = cellsOf(page, 'inventory-menu')[0];
    assert.equal(menu.hidden, true, '没点之前菜单是收着的');

    clickCell(page, 'wood');
    assert.equal(menu.hidden, false);
    assert.deepEqual(
      menuEntries(page).map((entry) => entry.textContent),
      ['使用', '装配', '丢弃'],
    );
    assert.equal(cellsOf(page, 'inventory-menu__title')[0].textContent, '木材');

    // 弹药拿不到手上，那一格根本不是按钮。
    clickCell(page, 'light-ammo');
    assert.equal(cellsOf(page, 'inventory-menu__title')[0].textContent, '木材');
  });
});

test('可点的格子标成 CommonUI 事件接收者，点击不会被栈守卫拦掉', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 3], ['light-ammo', 60]]));
    const cells = cellsOf(page, 'inventory__cell');
    const wood = cells.find((cell) => cell.dataset.itemType === 'wood');
    const ammo = cells.find((cell) => cell.dataset.itemType === 'light-ammo');
    assert.ok(wood && ammo);
    // 格子是 `<li role="button">`，`CommonUIManager` 只按标签名认接收者，认不出就
    // 会在捕获阶段把这次点击拦掉——玩家点了毫无反应。
    assert.equal(wood.dataset.commonUiReceiver, '');
    assert.equal(ammo.dataset.commonUiReceiver, undefined, '拿不到手上的那格本来就不响应');
  });
});

test('选中菜单里的一条就报出意图，并把菜单收起来', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    const actions: [string, string][] = [];
    page.onItemAction((action, itemType) => actions.push([action, itemType]));
    page.setInventory(inventoryView(6, [['wood', 3]]));

    clickCell(page, 'wood');
    const drop = menuEntries(page).find((entry) => entry.dataset.action === 'drop');
    assert.ok(drop);
    drop.dispatchEvent(new Event('click'));

    assert.deepEqual(actions, [['drop', 'wood']]);
    // 先收再兑现：动作会改背包，改完这一格会被重画，菜单挂着的锚点就没了。
    assert.equal(cellsOf(page, 'inventory-menu')[0].hidden, true);
  });
});

test('点别处收起菜单；再点同一格是「我不选了」', () => {
  withFakeDocument((fakeDocument) => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 3], ['stone', 1]]));
    const menu = cellsOf(page, 'inventory-menu')[0];

    clickCell(page, 'wood');
    assert.equal(menu.hidden, false);
    // 点在菜单外面：捕获阶段那道监听把它收起来。
    const elsewhere = new FakeElement('div');
    const outside = new Event('pointerdown');
    Object.defineProperty(outside, 'target', { value: elsewhere, configurable: true });
    fakeDocument.dispatchEvent(outside);
    assert.equal(menu.hidden, true);

    clickCell(page, 'wood');
    assert.equal(menu.hidden, false);
    clickCell(page, 'wood');
    assert.equal(menu.hidden, true, '同一格再点一次是收起来，而不是重画一遍');
  });
});

test('已经装配在物品栏上时，「装配」列出来但点不动', () => {
  withFakeDocument(() => {
    const inventory = new InventoryComponent({ slotCapacity: 6, hotbarCapacity: 9 });
    inventory.add('wood', 3);
    // 装配是一次转移：这之后木材整摞在物品栏上，背包里没有了，所以从物品栏那一格
    // 上点开菜单。
    inventory.assignHotbarSlot(0, 'wood');
    const page = new InventoryPage();
    const actions: string[] = [];
    page.onItemAction((action) => actions.push(action));
    page.setInventory(buildInventoryView(inventory as never));

    assert.equal(
      cellsOf(page, 'inventory__cell').some((cell) => cell.dataset.itemType === 'wood'),
      false,
      '装配之后背包里不再有它：物品栏是另一本账，不是一个引用',
    );

    // 再往包里放一些，背包那一格就回来了——这时「装配」那条应当是点不动的。
    inventory.add('wood', 2);
    page.setInventory(buildInventoryView(inventory as never));
    clickCell(page, 'wood');
    const equip = menuEntries(page).find((entry) => entry.dataset.action === 'equip');
    assert.ok(equip);
    assert.equal(equip.disabled, true);
    equip.dispatchEvent(new Event('click'));
    assert.deepEqual(actions, [], '点不动的那条不该报出意图');
  });
});

test('下方那条物品栏画的是它自己持有的那一摞，格子拖得动', () => {
  withFakeDocument(() => {
    const inventory = new InventoryComponent({ slotCapacity: 6, hotbarCapacity: 9 });
    inventory.add('wood', 120);
    inventory.assignHotbarSlot(1, 'wood');
    inventory.setActiveHotbarSlot(1);
    const page = new InventoryPage();
    page.setInventory(buildInventoryView(inventory as never));

    const slots = cellsOf(page, 'inventory-hotbar__slot');
    assert.equal(slots.length, 9, '一格一个数字键，1-9');
    assert.equal(slots[1].dataset.state, 'ready');
    assert.equal(slots[1].dataset.active, 'true', '选中的那一格标出来');
    // 一摞最多 99：装配搬走 99 个，剩下 21 个留在背包里。
    assert.equal(
      cellsOf(page, 'inventory-hotbar__quantity')[1].textContent,
      String(itemCatalog.require('wood').stackLimit),
    );
    assert.equal(slots[0].dataset.state, 'empty');
    assert.equal(slots[0].draggable, false, '空格没什么可拖的');
    assert.equal(slots[1].draggable, true);
  });
});

test('拖拽的三个方向：背包 → 物品栏、物品栏之间、物品栏 → 背包', () => {
  withFakeDocument(() => {
    const inventory = new InventoryComponent({ slotCapacity: 6, hotbarCapacity: 9 });
    inventory.add('wood', 120);
    inventory.assignHotbarSlot(0, 'wood');
    const page = new InventoryPage();
    const drops: [unknown, unknown][] = [];
    page.onDragDrop((source, target) => drops.push([source, target]));
    page.setInventory(buildInventoryView(inventory as never));

    const backpackCell = cellsOf(page, 'inventory__cell')
      .find((cell) => cell.dataset.itemType === 'wood');
    const hotbarSlots = cellsOf(page, 'inventory-hotbar__slot');
    const grid = cellsOf(page, 'inventory__grid')[0];
    assert.ok(backpackCell);

    backpackCell.dispatchEvent(new Event('dragstart'));
    hotbarSlots[2].dispatchEvent(new Event('drop'));
    assert.deepEqual(drops.at(-1), [
      { kind: 'backpack', itemType: 'wood' },
      { kind: 'hotbar', slotIndex: 2 },
    ]);

    hotbarSlots[0].dispatchEvent(new Event('dragstart'));
    hotbarSlots[3].dispatchEvent(new Event('drop'));
    assert.deepEqual(drops.at(-1), [
      { kind: 'hotbar', slotIndex: 0 },
      { kind: 'hotbar', slotIndex: 3 },
    ]);

    hotbarSlots[0].dispatchEvent(new Event('dragstart'));
    grid.dispatchEvent(new Event('drop'));
    assert.deepEqual(drops.at(-1), [{ kind: 'hotbar', slotIndex: 0 }, { kind: 'backpack' }]);

    // 拖到界面外面松手：`dragend` 清掉来源，下一次落点不该带着上一次的货。
    const before = drops.length;
    hotbarSlots[0].dispatchEvent(new Event('dragstart'));
    hotbarSlots[0].dispatchEvent(new Event('dragend'));
    grid.dispatchEvent(new Event('drop'));
    assert.equal(drops.length, before, '没有来源的那次落点什么都不报');
  });
});

test('重画与关闭都会收起菜单：锚着的那一格已经不在了', () => {
  withFakeDocument(() => {
    const page = new InventoryPage();
    page.setInventory(inventoryView(6, [['wood', 3]]));
    const menu = cellsOf(page, 'inventory-menu')[0];

    clickCell(page, 'wood');
    assert.equal(menu.hidden, false);
    page.setInventory(inventoryView(6, [['wood', 2]]));
    assert.equal(menu.hidden, true, '快照一来格子全换了，菜单不能还挂在旧的上面');

    clickCell(page, 'wood');
    assert.equal(menu.hidden, false);
    page.onClose('pop');
    assert.equal(menu.hidden, true);
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

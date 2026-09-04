import { itemCatalog } from '../../shared/items/index.mjs';

/** 物品分类，与 `config/items/item-catalog.json` 的 `category` 枚举一一对应。 */
export type ItemCategory =
  | 'material'
  | 'valuable'
  | 'throwable'
  | 'supply'
  | 'ammunition'
  | 'tool';

export const ITEM_CATEGORY_LABELS: Readonly<Record<ItemCategory, string>> = Object.freeze({
  material: '材料',
  valuable: '价值货物',
  throwable: '投掷物',
  supply: '补给品',
  ammunition: '弹药',
  tool: '工具',
});

/** 物品目录里一条定义中，界面真正会读到的部分。 */
export interface ItemDefinitionLike {
  readonly id: string;
  readonly displayName: string;
  readonly category: string;
  readonly stackLimit: number;
  readonly slotCost: number;
  readonly iconId: string;
  readonly tint: string;
  readonly summary: string;
  readonly coinValue?: number;
  readonly contraband: boolean;
  readonly pooled: boolean;
  readonly holdable?: boolean;
  /**
   * 使用配置；不写表示这件东西没有用法。见 `config/items` 的 `use`。
   *
   * 使用的兑现路径是「授予玩家一条 Ability → 按 mode 激活 → 完成后收回」，
   * `mode` 决定按一下还是按住 `holdSeconds` 秒。
   */
  readonly use?: {
    readonly action: 'tool' | 'throw';
    readonly input: 'primary';
    readonly mode: 'tap' | 'hold';
    readonly holdSeconds: number;
    readonly value: number;
  };
}

export interface ItemCatalogLike {
  get(itemType: string): ItemDefinitionLike | undefined;
  /** 目录顺序即界面里的稳定排序依据；测试可以只给 `get`，那时退化成存放顺序。 */
  list?(): readonly ItemDefinitionLike[];
}

/** 物品栏一格持有的那一摞；空格是 null。 */
export interface HotbarSlotModelLike {
  readonly itemType: string;
  readonly quantity: number;
}

/** 背包 Component 里视图关心的部分；`InventoryComponent` 天然满足这个形状。 */
export interface InventoryModelLike {
  readonly slotCapacity: number;
  readonly usedSlots: number;
  readonly revision: number;
  readonly slots: readonly { readonly itemType: string; readonly quantity: number }[];
  readonly pooled: readonly { readonly itemType: string; readonly quantity: number }[];
  /**
   * 物品栏每格实际持有的那一摞。
   *
   * 它是一条**独立的账本**，不是指向背包的引用：装配把那一摞从背包搬进来，之后
   * 背包里就查不到它了。所以数量记在格子上，界面不用回背包找。
   */
  readonly hotbar?: readonly (HotbarSlotModelLike | null)[];
  readonly activeHotbarIndex?: number;
  readonly heldItemType?: string;
  /** 交互键按住多久算「收回背包」。来自玩家原型，两端读同一份。 */
  readonly stowHoldSeconds?: number;
}

export interface InventoryStackView {
  readonly itemType: string;
  readonly displayName: string;
  readonly category: ItemCategory;
  readonly categoryLabel: string;
  readonly quantity: number;
  readonly stackLimit: number;
  /** 这堆吃掉几个货位；独立池里的恒为 0。 */
  readonly slotCost: number;
  readonly iconId: string;
  readonly tint: string;
  readonly summary: string;
  /** 已经堆到上限，同类再拾取只能另开一格。 */
  readonly full: boolean;
  readonly coinValue?: number;
  readonly contraband: boolean;
  /** 能不能装配到物品栏；界面据此决定这一格拖不拖得动。 */
  readonly holdable: boolean;
  /** 有没有用法。没有的话菜单里那条「使用」列出来但点不动。 */
  readonly usable: boolean;
  /** `tap` 点一下就结算，`hold` 要按住走完圆形倒计时。没有用法时是 undefined。 */
  readonly useMode?: 'tap' | 'hold';
  /** 长按倒计时多长，秒。`tap` 是 0。 */
  readonly holdSeconds: number;
}

/** 分类页。第一页固定是「全部」，其余按物品目录的分类顺序，空分类不出现。 */
export interface InventoryPageView {
  readonly id: 'all' | ItemCategory;
  readonly label: string;
  readonly stacks: readonly InventoryStackView[];
}

/** 物品栏一格。空格的 `itemType` 是 undefined、`quantity` 为 0。 */
export interface HotbarSlotView {
  readonly index: number;
  readonly itemType?: string;
  readonly displayName?: string;
  readonly iconId?: string;
  readonly tint?: string;
  readonly quantity: number;
  readonly active: boolean;
  /** 有没有使用方式；界面据此决定要不要提示按一下还是按住。 */
  readonly usable: boolean;
  /** `hold` 的那些要画圆形倒计时，`tap` 点一下就结算。没有用法时是 undefined。 */
  readonly useMode?: 'tap' | 'hold';
}

export interface InventoryView {
  readonly slotCapacity: number;
  readonly usedSlots: number;
  /** 还空着的货位数，界面按这个数量补空格。 */
  readonly freeSlots: number;
  readonly slots: readonly InventoryStackView[];
  /** 弹药与基础工具：有上限但不吃货位。 */
  readonly pooled: readonly InventoryStackView[];
  /** 身上价值货物运到贸易点能换的金币合计。 */
  readonly cargoValue: number;
  /** 携带中的违禁品件数；不为 0 时位置会被公开。 */
  readonly contrabandCount: number;
  /** 分类页，第一页是全部。 */
  readonly pages: readonly InventoryPageView[];
  readonly hotbar: readonly HotbarSlotView[];
  /** 真正握在手上的那一种；空手时是 undefined。 */
  readonly heldItemType?: string;
  /** 选中的是哪一格；空手时是 -1。装配时用它决定「放哪一格」的默认落点。 */
  readonly activeHotbarIndex: number;
  readonly revision: number;
}

function isItemCategory(value: string): value is ItemCategory {
  return Object.hasOwn(ITEM_CATEGORY_LABELS, value);
}

function toStackView(
  entry: { readonly itemType: string; readonly quantity: number },
  definition: ItemDefinitionLike,
): InventoryStackView {
  const category = isItemCategory(definition.category) ? definition.category : 'material';
  return {
    itemType: definition.id,
    displayName: definition.displayName,
    category,
    categoryLabel: ITEM_CATEGORY_LABELS[category],
    quantity: entry.quantity,
    stackLimit: definition.stackLimit,
    slotCost: definition.pooled ? 0 : definition.slotCost,
    iconId: definition.iconId,
    tint: definition.tint,
    summary: definition.summary,
    full: entry.quantity >= definition.stackLimit,
    coinValue: definition.coinValue,
    contraband: definition.contraband,
    // 目录没写就按可手持处理，和 ItemCatalog 的默认一致（弹药那类显式写了 false）。
    holdable: definition.holdable ?? true,
    usable: definition.use !== undefined,
    useMode: definition.use?.mode,
    holdSeconds: definition.use?.holdSeconds ?? 0,
  };
}

/**
 * 把背包 Component 摊平成界面能直接画的一份数据。
 *
 * 这是 MVC 里 Model 与 View 之间唯一的翻译层：物品参数在这里从目录查出来，
 * 所以 `InventoryPage` 不认识物品目录，`InventoryComponent` 也不认识 DOM。
 * 纯函数，没有 DOM 依赖，可以直接对着断言测。
 */
export function buildInventoryView(
  inventory: InventoryModelLike,
  catalog: ItemCatalogLike = itemCatalog as unknown as ItemCatalogLike,
): InventoryView {
  const slots: InventoryStackView[] = [];
  const pooled: InventoryStackView[] = [];
  let cargoValue = 0;
  let contrabandCount = 0;

  for (const [entries, target] of [
    [inventory.slots, slots],
    [inventory.pooled, pooled],
  ] as const) {
    for (const entry of entries) {
      const definition = catalog.get(entry.itemType);
      // 目录里没有的物品不画：它进不了权威背包，出现在这里说明配置漏了登记。
      if (!definition) continue;
      const view = toStackView(entry, definition);
      target.push(view);
      if (view.coinValue !== undefined) cargoValue += view.coinValue * view.quantity;
      if (view.contraband) contrabandCount += view.quantity;
    }
  }

  const usedSlots = slots.reduce((total, slot) => total + slot.slotCost, 0);
  return {
    slotCapacity: inventory.slotCapacity,
    usedSlots,
    freeSlots: Math.max(0, inventory.slotCapacity - usedSlots),
    slots,
    pooled,
    cargoValue,
    contrabandCount,
    pages: buildPages([...slots, ...pooled], catalog),
    hotbar: buildHotbar(inventory, catalog),
    heldItemType: inventory.heldItemType,
    activeHotbarIndex: inventory.activeHotbarIndex ?? -1,
    revision: inventory.revision,
  };
}

/**
 * 自动分类。
 *
 * 「整理」在这套设计里不是一个按钮，是没有东西需要整理：顺序既然每次都从物品目录
 * 重新推导，就不会乱。账本那一层按「谁先进来谁在前」存放并原样复制，排序只发生在
 * 这里，所以服务端不需要为了界面好看而维护任何顺序。
 */
function buildPages(
  stacks: readonly InventoryStackView[],
  catalog: ItemCatalogLike,
): InventoryPageView[] {
  const order = catalogOrder(catalog);
  const categories = Object.keys(ITEM_CATEGORY_LABELS) as ItemCategory[];
  const sorted = [...stacks].sort((left, right) => (
    categories.indexOf(left.category) - categories.indexOf(right.category)
    || (order.get(left.itemType) ?? 0) - (order.get(right.itemType) ?? 0)
  ));
  const pages: InventoryPageView[] = [{ id: 'all', label: '全部', stacks: sorted }];
  for (const category of categories) {
    const owned = sorted.filter((stack) => stack.category === category);
    // 空分类不出现：一排点不开的页签只会让人以为界面坏了。
    if (owned.length > 0) {
      pages.push({ id: category, label: ITEM_CATEGORY_LABELS[category], stacks: owned });
    }
  }
  return pages;
}

function catalogOrder(catalog: ItemCatalogLike): Map<string, number> {
  const order = new Map<string, number>();
  const definitions = catalog.list?.() ?? [];
  definitions.forEach((definition, index) => order.set(definition.id, index));
  return order;
}

/**
 * 物品栏。
 *
 * 数量直接读格子：物品栏自己持有那一摞，不需要回背包账上找，也不需要为「拿在
 * 手上那一个」补一笔——手上挂的只是一个模型，账从头到尾都在这一格上。
 */
function buildHotbar(
  inventory: InventoryModelLike,
  catalog: ItemCatalogLike,
): HotbarSlotView[] {
  const slots = inventory.hotbar ?? [];
  const activeIndex = inventory.activeHotbarIndex ?? -1;
  return slots.map((slot, index) => {
    const definition = slot ? catalog.get(slot.itemType) : undefined;
    return {
      index,
      itemType: definition?.id,
      displayName: definition?.displayName,
      iconId: definition?.iconId,
      tint: definition?.tint,
      quantity: definition ? slot?.quantity ?? 0 : 0,
      active: index === activeIndex,
      usable: Boolean(definition?.use),
      useMode: definition?.use?.mode,
    };
  });
}

/** 容器界面里的一行：同一种物品，箱内和身上的数量并排。 */
export interface ContainerRowView {
  readonly itemType: string;
  readonly displayName: string;
  readonly iconId: string;
  readonly tint: string;
  /** 身上有多少（可以存进去）。 */
  readonly carried: number;
  /** 箱内有多少（可以取出来）。 */
  readonly stored: number;
}

export interface ContainerView {
  readonly actorId: string;
  readonly label: string;
  readonly slotCapacity: number;
  readonly usedSlots: number;
  /** 除自己以外还有几个人开着这个箱子；不为 0 时东西会在眼前变化。 */
  readonly otherViewerCount: number;
  readonly rows: readonly ContainerRowView[];
  readonly revision: number;
}

/** 容器 Component 里视图关心的部分；`ContainerComponent` 天然满足这个形状。 */
export interface ContainerModelLike {
  readonly label: string;
  readonly slotCapacity: number;
  readonly usedSlots: number;
  readonly viewerCount: number;
  readonly revision: number;
  readonly slots: readonly { readonly itemType: string; readonly quantity: number }[];
  readonly pooled: readonly { readonly itemType: string; readonly quantity: number }[];
}

/**
 * 把容器和背包并成界面能直接画的一张表。
 *
 * 「身上」指的是**背包**那一本账，不含物品栏：箱子前面能存进去的只有包里那些，
 * 手上正拿着的那一摞要先收回背包才搬得动（见 `transferItems`）。把物品栏也算进这
 * 一列，玩家会按着一个搬不动的数字去点「存」。
 *
 * 一行 = 一种物品，箱内和身上并排——这是「存 / 取」两个按钮能成立的前提：玩家要
 * 决定搬哪一边，就得同时看见两边。分成两个面板再让人拖来拖去，是把这个判断拆散
 * 之后再要求玩家自己拼回去。
 *
 * 行的顺序和背包界面用的是同一套（分类序、目录序），所以同一件东西在两个界面里
 * 的相对位置一致。
 */
export function buildContainerView(
  actorId: string,
  container: ContainerModelLike,
  inventory: InventoryModelLike | undefined,
  catalog: ItemCatalogLike = itemCatalog as unknown as ItemCatalogLike,
): ContainerView {
  const order = catalogOrder(catalog);
  const categories = Object.keys(ITEM_CATEGORY_LABELS) as ItemCategory[];
  const totals = new Map<string, { carried: number; stored: number }>();
  const accumulate = (
    entries: readonly { readonly itemType: string; readonly quantity: number }[],
    key: 'carried' | 'stored',
  ): void => {
    for (const entry of entries) {
      const row = totals.get(entry.itemType) ?? { carried: 0, stored: 0 };
      row[key] += entry.quantity;
      totals.set(entry.itemType, row);
    }
  };
  accumulate(container.slots, 'stored');
  accumulate(container.pooled, 'stored');
  if (inventory) {
    accumulate(inventory.slots, 'carried');
    accumulate(inventory.pooled, 'carried');
  }

  const rows: ContainerRowView[] = [];
  for (const [itemType, counts] of totals) {
    const definition = catalog.get(itemType);
    // 目录里没有的物品不画：它进不了权威账本，出现在这里说明配置漏了登记。
    if (!definition) continue;
    rows.push({
      itemType: definition.id,
      displayName: definition.displayName,
      iconId: definition.iconId,
      tint: definition.tint,
      carried: counts.carried,
      stored: counts.stored,
    });
  }
  rows.sort((left, right) => {
    const leftCategory = catalog.get(left.itemType)?.category ?? '';
    const rightCategory = catalog.get(right.itemType)?.category ?? '';
    return categories.indexOf(leftCategory as ItemCategory)
      - categories.indexOf(rightCategory as ItemCategory)
      || (order.get(left.itemType) ?? 0) - (order.get(right.itemType) ?? 0);
  });

  return {
    actorId,
    label: container.label,
    slotCapacity: container.slotCapacity,
    usedSlots: container.usedSlots,
    // 自己也算在服务端那个计数里，所以减掉自己才是「另有几个人」。
    otherViewerCount: Math.max(0, container.viewerCount - 1),
    rows,
    revision: container.revision,
  };
}

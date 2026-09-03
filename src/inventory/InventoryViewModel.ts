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
  /** 手持交互配置；不写表示只能拿着，按键没反应。见 `config/items` 的 `use`。 */
  readonly use?: {
    readonly action: 'tool' | 'throw';
    readonly input: 'primary' | 'secondary';
    readonly mode: 'tap' | 'charge';
    readonly chargeSeconds: number;
    readonly value: number;
  };
}

export interface ItemCatalogLike {
  get(itemType: string): ItemDefinitionLike | undefined;
  /** 目录顺序即界面里的稳定排序依据；测试可以只给 `get`，那时退化成存放顺序。 */
  list?(): readonly ItemDefinitionLike[];
}

/** 背包 Component 里视图关心的部分；`InventoryComponent` 天然满足这个形状。 */
export interface InventoryModelLike {
  readonly slotCapacity: number;
  readonly usedSlots: number;
  readonly revision: number;
  readonly slots: readonly { readonly itemType: string; readonly quantity: number }[];
  readonly pooled: readonly { readonly itemType: string; readonly quantity: number }[];
  /** 快捷栏配置；旧快照没有这一段时界面只是不画那一排。 */
  readonly hotbar?: readonly (string | null)[];
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
  /** 能不能拿到手上；界面据此决定这一格点不点得动。 */
  readonly holdable: boolean;
}

/** 分类页。第一页固定是「全部」，其余按物品目录的分类顺序，空分类不出现。 */
export interface InventoryPageView {
  readonly id: 'all' | ItemCategory;
  readonly label: string;
  readonly stacks: readonly InventoryStackView[];
}

/** 快捷栏一格。配置着但没货时 `quantity` 为 0——格子还在，手上是空的。 */
export interface HotbarSlotView {
  readonly index: number;
  readonly itemType?: string;
  readonly displayName?: string;
  readonly iconId?: string;
  readonly tint?: string;
  readonly quantity: number;
  readonly active: boolean;
  /** 有没有使用方式；界面据此决定要不要提示「按住蓄力」。 */
  readonly usable: boolean;
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
  /** 真正握在手上的那一种；配置还在但货用光了时是 undefined。 */
  readonly heldItemType?: string;
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

function buildHotbar(
  inventory: InventoryModelLike,
  catalog: ItemCatalogLike,
): HotbarSlotView[] {
  const slots = inventory.hotbar ?? [];
  const activeIndex = inventory.activeHotbarIndex ?? -1;
  return slots.map((itemType, index) => {
    const definition = itemType ? catalog.get(itemType) : undefined;
    const quantity = definition
      ? quantityOf(inventory, definition.id) + (inventory.heldItemType === definition.id ? 1 : 0)
      : 0;
    return {
      index,
      itemType: definition?.id,
      displayName: definition?.displayName,
      iconId: definition?.iconId,
      tint: definition?.tint,
      quantity,
      active: index === activeIndex,
      usable: Boolean(definition?.use),
    };
  });
}

/**
 * 快捷栏上显示的数量要把「已经拿在手上那一个」算回去。
 *
 * 手持物在世界里是一个真 Actor，为了不让同一件东西同时存在于账本和世界里，账上
 * 那一个是被扣掉的。界面上不加回来的话，拿起最后一个木材时那一格会显示 0。
 */
function quantityOf(inventory: InventoryModelLike, itemType: string): number {
  let total = 0;
  for (const entry of inventory.slots) if (entry.itemType === itemType) total += entry.quantity;
  for (const entry of inventory.pooled) if (entry.itemType === itemType) total += entry.quantity;
  return total;
}

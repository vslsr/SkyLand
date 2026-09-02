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
}

export interface ItemCatalogLike {
  get(itemType: string): ItemDefinitionLike | undefined;
}

/** 背包 Component 里视图关心的部分；`InventoryComponent` 天然满足这个形状。 */
export interface InventoryModelLike {
  readonly slotCapacity: number;
  readonly usedSlots: number;
  readonly revision: number;
  readonly slots: readonly { readonly itemType: string; readonly quantity: number }[];
  readonly pooled: readonly { readonly itemType: string; readonly quantity: number }[];
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
    revision: inventory.revision,
  };
}

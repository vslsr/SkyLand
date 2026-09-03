import { ActorComponent } from '../ActorComponent.mjs';
import { itemCatalog } from '../../items/index.mjs';

export const INVENTORY_COMPONENT = 'inventory';

/** 原型没写 slotCapacity 时的货位数。设计稿 §6.5：角色背包容量小，够带回一次岛上收获。 */
export const DEFAULT_SLOT_CAPACITY = 8;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function requestedQuantity(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * 角色背包。
 *
 * 按设计稿的携带规则记账，而不是一张无限的 itemType -> quantity 表：
 *
 * - 占货位的物品（材料、价值货物、投掷物、补给品）分格存放，装满就拿不动，
 *   §6.5「大宗资源必须存入船舱」靠的就是这个上限；
 * - 大件货物按 §6.7.2 占 2–3 个货位，高价值因此天然更难连着带走；
 * - 弹药和基础工具的 slotCost 为 0，按 §9.5.5「不通过背包格数挤压武器选择」
 *   走各自上限的独立池，不吃格数。
 *
 * 权威数据只在房间服务端变化。客户端挂同一个 Component，靠 `applySnapshot`
 * 跟随快照，不做本地预测——拿没拿到由服务端说了算。
 */
export class InventoryComponent extends ActorComponent {
  constructor(definition = {}, catalog = itemCatalog) {
    super(INVENTORY_COMPONENT);
    this.catalog = catalog;
    this.slotCapacity = positiveInteger(definition.slotCapacity, DEFAULT_SLOT_CAPACITY);
    /** 占货位的堆叠，按放入顺序排列；顺序即界面里的格子顺序。 */
    this.slots = [];
    /** 不占货位的堆叠（弹药、基础工具），每种最多一条。 */
    this.pooled = [];
    this.revision = 0;
  }

  /** 已经占掉的货位数。大件一条堆叠就吃掉 2–3 格。 */
  get usedSlots() {
    return this.slots.reduce((total, slot) => total + slot.slotCost, 0);
  }

  get freeSlots() {
    return Math.max(0, this.slotCapacity - this.usedSlots);
  }

  get isFull() {
    return this.freeSlots === 0;
  }

  quantityOf(itemType) {
    let total = 0;
    for (const slot of this.slots) if (slot.itemType === itemType) total += slot.quantity;
    for (const entry of this.pooled) if (entry.itemType === itemType) total += entry.quantity;
    return total;
  }

  /**
   * 尽量收下 quantity 个物品。
   *
   * @returns 实际收下的数量。收不下的部分留在世界里，对应 §9.5.5「满额时不拾取」。
   */
  add(itemType, quantity) {
    const definition = this.catalog.get(itemType);
    let remaining = requestedQuantity(quantity);
    if (!definition || remaining === 0) return 0;

    const entries = definition.pooled ? this.pooled : this.slots;
    let accepted = 0;
    // 先填没满的堆叠：同类物品不该因为身上已经有一格就另开一格。
    for (const entry of entries) {
      if (remaining === 0) break;
      if (entry.itemType !== itemType) continue;
      const taken = Math.min(remaining, definition.stackLimit - entry.quantity);
      if (taken <= 0) continue;
      entry.quantity += taken;
      remaining -= taken;
      accepted += taken;
    }
    // 再开新堆叠：不占货位的物品每种只有一条，占货位的要先付得起 slotCost。
    while (remaining > 0) {
      if (definition.pooled) {
        if (this.pooled.some((entry) => entry.itemType === itemType)) break;
      } else if (this.freeSlots < definition.slotCost) break;
      const taken = Math.min(remaining, definition.stackLimit);
      entries.push({
        itemType,
        quantity: taken,
        slotCost: definition.pooled ? 0 : definition.slotCost,
      });
      remaining -= taken;
      accepted += taken;
    }

    if (accepted > 0) this.revision += 1;
    return accepted;
  }

  /**
   * 取出 quantity 个物品，先掏最后放进来的那堆。
   *
   * @returns 实际取出的数量。
   */
  remove(itemType, quantity) {
    let remaining = requestedQuantity(quantity);
    if (remaining === 0) return 0;
    let removed = 0;
    for (const entries of [this.slots, this.pooled]) {
      for (let index = entries.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const entry = entries[index];
        if (entry.itemType !== itemType) continue;
        const taken = Math.min(remaining, entry.quantity);
        entry.quantity -= taken;
        remaining -= taken;
        removed += taken;
        if (entry.quantity === 0) entries.splice(index, 1);
      }
    }
    if (removed > 0) this.revision += 1;
    return removed;
  }

  clear() {
    if (this.slots.length === 0 && this.pooled.length === 0) return false;
    this.slots.length = 0;
    this.pooled.length = 0;
    this.revision += 1;
    return true;
  }

  /**
   * 复制用的紧凑形态：一格一条，货位在前、独立池在后。
   *
   * 格子顺序本身就是信息（玩家记得东西放在哪一格），所以按存放顺序发，
   * 不做排序；slotCost 与分类两端都能从物品目录查到，不进快照。
   */
  snapshot() {
    return [...this.slots, ...this.pooled].map(({ itemType, quantity }) => ({
      itemType,
      quantity,
    }));
  }

  /**
   * 客户端镜像：按快照重建内容。
   *
   * @returns 内容或 revision 是否真的变了，供界面决定要不要重画。
   */
  applySnapshot(entries, revision = this.revision) {
    const nextRevision = Math.max(0, Math.trunc(Number(revision) || 0));
    const source = Array.isArray(entries) ? entries : [];
    const slots = [];
    const pooled = [];
    for (const entry of source) {
      const definition = this.catalog.get(entry?.itemType);
      const quantity = requestedQuantity(entry?.quantity);
      if (!definition || quantity === 0) continue;
      const stack = {
        itemType: definition.id,
        quantity,
        slotCost: definition.pooled ? 0 : definition.slotCost,
      };
      (definition.pooled ? pooled : slots).push(stack);
    }
    const changed = nextRevision !== this.revision || !this.matches(slots, pooled);
    this.slots = slots;
    this.pooled = pooled;
    this.revision = nextRevision;
    return changed;
  }

  matches(slots, pooled) {
    const same = (left, right) => (
      left.length === right.length
      && left.every((entry, index) => (
        entry.itemType === right[index].itemType && entry.quantity === right[index].quantity
      ))
    );
    return same(this.slots, slots) && same(this.pooled, pooled);
  }
}

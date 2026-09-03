import { itemCatalog } from '../items/index.mjs';

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
 * 一份按货位记账的物品清单。
 *
 * 背包和容器（箱子、船舱）装的是同一种东西、守的是同一套规则，区别只有容量和
 * 归谁所有，所以记账逻辑抽在这里由两者共用：改一次堆叠规则，两边同时生效。
 *
 * 按设计稿的携带规则记账，而不是一张无限的 itemType -> quantity 表：
 *
 * - 占货位的物品（材料、价值货物、投掷物、补给品）分格存放，装满就拿不动，
 *   §6.5「大宗资源必须存入船舱」靠的就是这个上限；
 * - 大件货物按 §6.7.2 占 2–3 个货位，高价值因此天然更难连着带走；
 * - 弹药和基础工具的 slotCost 为 0，按 §9.5.5「不通过背包格数挤压武器选择」
 *   走各自上限的独立池，不吃格数。
 *
 * 权威数据只在房间服务端变化。客户端挂同一份账本，靠 `applySnapshot` 跟随快照，
 * 不做本地预测——拿没拿到由服务端说了算。
 */
export class ItemLedger {
  constructor(slotCapacity = DEFAULT_SLOT_CAPACITY, catalog = itemCatalog) {
    this.catalog = catalog;
    this.slotCapacity = positiveInteger(slotCapacity, DEFAULT_SLOT_CAPACITY);
    /** 占货位的堆叠，按放入顺序排列。 */
    this.slots = [];
    /** 不占货位的堆叠（弹药、基础工具），每种最多一条。 */
    this.pooled = [];
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

  get isEmpty() {
    return this.slots.length === 0 && this.pooled.length === 0;
  }

  quantityOf(itemType) {
    let total = 0;
    for (const slot of this.slots) if (slot.itemType === itemType) total += slot.quantity;
    for (const entry of this.pooled) if (entry.itemType === itemType) total += entry.quantity;
    return total;
  }

  /** 身上有哪些种类，按存放顺序；界面分类和快捷栏候选都读它。 */
  itemTypes() {
    const seen = new Set();
    for (const entry of [...this.slots, ...this.pooled]) seen.add(entry.itemType);
    return Array.from(seen);
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

    return accepted;
  }

  /**
   * 取出 quantity 个物品，先掏最后放进来的那堆。
   *
   * @returns 实际取出的数量。少于请求量说明账上本来就没那么多——两个人同时掏
   * 同一个箱子时，后到的那次在这里被截断，而不是靠锁。
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
    return removed;
  }

  clear() {
    if (this.isEmpty) return false;
    this.slots.length = 0;
    this.pooled.length = 0;
    return true;
  }

  /**
   * 复制用的紧凑形态：一格一条，货位在前、独立池在后。
   *
   * 存放顺序原样发出，不做排序：排序是界面的事（`buildInventoryView` 按物品目录
   * 稳定排一次），账本这一层保持「谁先进来谁在前」，服务端重启前后一致。
   * slotCost 与分类两端都能从物品目录查到，不进快照。
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
   * @returns 内容是否真的变了，供界面决定要不要重画。
   */
  applySnapshot(entries) {
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
    const changed = !this.matches(slots, pooled);
    this.slots = slots;
    this.pooled = pooled;
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

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
      // 装着弹药的那一条不收新的同类：它已经不是「一把普通的弹弓」了，并进来之后
      // 那几发弹药就说不清归哪一件。
      if (entry.ammo) continue;
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

  /**
   * 整条取走一摞，**连同它装着的弹药**。
   *
   * 和 `remove` 的区别只在带弹药的那一条：`remove` 按数量扣，扣到一半那几发弹药
   * 就不知道该跟着哪一半走，所以带弹药的条目只能整条搬。装配到物品栏、从箱子里
   * 取出来走的都是这条，「弹药跟着那一格走」因此不需要每个调用点各写一遍。
   *
   * @param {number} [quantity] 最多取几个；带弹药的那一条只在装得下整条时才被取走。
   * @returns {{ itemType: string, quantity: number, ammo?: { itemType: string,
   *   quantity: number } } | undefined} 一个都取不到时是 undefined。
   */
  takeEntry(itemType, quantity = Number.POSITIVE_INFINITY) {
    const wanted = Number.isFinite(quantity) ? requestedQuantity(quantity) : Number.MAX_SAFE_INTEGER;
    if (wanted === 0) return undefined;
    for (const entries of [this.pooled, this.slots]) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.itemType !== itemType || !entry.ammo || entry.quantity > wanted) continue;
        entries.splice(index, 1);
        return { itemType, quantity: entry.quantity, ammo: entry.ammo };
      }
    }
    const taken = this.remove(itemType, wanted);
    return taken > 0 ? { itemType, quantity: taken } : undefined;
  }

  /**
   * 把一整条放回来，**连同它装着的弹药**。全有或全无。
   *
   * 不带弹药的那些照旧并进已有的堆叠；带弹药的那一条自成一条，理由同 `add`。
   *
   * @returns 放没放进去。放不下时账本原样不动——一半留在手里、一半进包，
   *   等于凭空销毁另一半。
   */
  putEntry(entry) {
    const definition = this.catalog.get(entry?.itemType);
    const quantity = requestedQuantity(entry?.quantity);
    if (!definition || quantity === 0) return false;
    if (!entry.ammo) {
      const accepted = this.add(definition.id, quantity);
      if (accepted === quantity) return true;
      this.remove(definition.id, accepted);
      return false;
    }
    if (quantity > definition.stackLimit) return false;
    if (definition.pooled) {
      if (this.pooled.some((existing) => existing.itemType === definition.id)) return false;
    } else if (this.freeSlots < definition.slotCost) return false;
    (definition.pooled ? this.pooled : this.slots).push({
      itemType: definition.id,
      quantity,
      slotCost: definition.pooled ? 0 : definition.slotCost,
      ammo: { ...entry.ammo },
    });
    return true;
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
    return [...this.slots, ...this.pooled].map(({ itemType, quantity, ammo }) => ({
      itemType,
      quantity,
      ...(ammo ? { ammo: { ...ammo } } : {}),
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
      const ammo = sanitizeAmmo(entry?.ammo, definition, this.catalog);
      if (ammo) stack.ammo = ammo;
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
        entry.itemType === right[index].itemType
        && entry.quantity === right[index].quantity
        && sameAmmo(entry.ammo, right[index].ammo)
      ))
    );
    return same(this.slots, slots) && same(this.pooled, pooled);
  }
}

/**
 * 弹药位的清洗：目录说得通才留着。
 *
 * 客户端镜像和快照都过这一关：这件东西不吃弹药、装的不是它收的那一种、发数越界，
 * 一律当成没装。客户端只画服务端说的，但它不该因为一条脏数据画出一个不存在的弹药框。
 */
export function sanitizeAmmo(raw, definition, catalog) {
  const slot = definition?.ammo;
  if (!raw || !slot) return undefined;
  const ammoType = catalog.get(raw.itemType)?.id;
  if (!ammoType || !slot.accepts.includes(ammoType)) return undefined;
  const quantity = Math.min(requestedQuantity(raw.quantity), slot.capacity);
  return quantity > 0 ? { itemType: ammoType, quantity } : undefined;
}

/** 两个弹药位一不一样。都没装也算一样。 */
export function sameAmmo(left, right) {
  if (!left || !right) return !left && !right;
  return left.itemType === right.itemType && left.quantity === right.quantity;
}

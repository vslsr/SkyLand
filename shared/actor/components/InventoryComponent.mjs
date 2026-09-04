import { ActorComponent } from '../ActorComponent.mjs';
import { itemCatalog } from '../../items/index.mjs';
import { DEFAULT_SLOT_CAPACITY, ItemLedger } from '../ItemLedger.mjs';

export const INVENTORY_COMPONENT = 'inventory';

export { DEFAULT_SLOT_CAPACITY };

/** 物品栏格数。原型没写时的默认值；数字键 1-9 一格一个，所以上限是 9。 */
export const DEFAULT_HOTBAR_CAPACITY = 9;

/** 数字键能寻址的最大格数。再多的格子没有键可以切过去，配置也就没有意义。 */
export const MAXIMUM_HOTBAR_CAPACITY = 9;

/** 空手。`activeHotbarIndex` 取这个值时嘴上不挂任何手持物。 */
export const NO_HOTBAR_SLOT = -1;

/** 交互键按住多久算「收回背包」而不是「放下」。原型没写时的默认值。 */
export const DEFAULT_STOW_HOLD_SECONDS = 0.6;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function requestedQuantity(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * 角色随身携带的两样东西：**背包**和**物品栏**。
 *
 * 两者装的是同一种东西、守的是同一套堆叠规则，区别只有「谁拿得出来用」：
 *
 * - 背包（`ledger`）按货位记账，是收纳；
 * - 物品栏（`hotbar`）是一条**特殊的背包**：固定格数、一格一摞、数字键直接寻址，
 *   拿在手上的永远是其中一格。
 *
 * 配置物品栏因此是一次**转移**，不是一个引用：`assignHotbarSlot` 把那一摞从背包
 * 里搬进物品栏那一格，背包里就不再有它了。做成引用（物品栏只记 itemType、数量
 * 仍算在背包账上）省一次搬运，代价是两个地方画同一摞货、数量同步变化，玩家没法
 * 理解那是一件东西；把「装进物品栏」和「放回背包」写成两次真实的转移之后，界面
 * 上看到几个就是几个。
 *
 * 权威数据只在房间服务端变化，客户端靠 `applySnapshot` 跟随。
 */
export class InventoryComponent extends ActorComponent {
  constructor(definition = {}, catalog = itemCatalog) {
    super(INVENTORY_COMPONENT);
    this.catalog = catalog;
    this.ledger = new ItemLedger(
      positiveInteger(definition.slotCapacity, DEFAULT_SLOT_CAPACITY),
      catalog,
    );
    this.hotbarCapacity = Math.min(
      MAXIMUM_HOTBAR_CAPACITY,
      positiveInteger(definition.hotbarCapacity, DEFAULT_HOTBAR_CAPACITY),
    );
    /**
     * 交互键短按是放下、长按是收回背包，这里是两者的分界。
     *
     * 它来自原型配置而不是常量：客户端画的那圈倒计时和服务端判定用的是同一个数，
     * 圈满那一刻就是服务端认定长按那一刻。两端各写一个数就会出现「圈满了
     * 但东西掉在了地上」。
     */
    this.stowHoldSeconds = Number.isFinite(Number(definition.stowHoldSeconds))
      && Number(definition.stowHoldSeconds) > 0
      ? Number(definition.stowHoldSeconds)
      : DEFAULT_STOW_HOLD_SECONDS;
    /**
     * @type {({ itemType: string, quantity: number } | null)[]}
     * 物品栏每格实际持有的那一摞；null 是空格。
     */
    this.hotbar = new Array(this.hotbarCapacity).fill(null);
    this.activeHotbarIndex = NO_HOTBAR_SLOT;
    this.revision = 0;
  }

  get slotCapacity() { return this.ledger.slotCapacity; }

  get slots() { return this.ledger.slots; }

  get pooled() { return this.ledger.pooled; }

  get usedSlots() { return this.ledger.usedSlots; }

  get freeSlots() { return this.ledger.freeSlots; }

  get isFull() { return this.ledger.isFull; }

  /**
   * 当前握在手上的物品种类；空手时是 undefined。
   *
   * 手持就是「物品栏选中格里那一摞」——不再需要「配置还在但货用光了」这种中间
   * 态：一摞用光，那一格就空了，物品栏是账本而不是一张配置表。
   */
  get heldItemType() {
    return this.hotbar[this.activeHotbarIndex]?.itemType;
  }

  /** 手上那一摞还剩几个；空手时是 0。 */
  get heldQuantity() {
    return this.hotbar[this.activeHotbarIndex]?.quantity ?? 0;
  }

  /** 背包里有多少。物品栏里的那些不算在内，它们已经不在背包里了。 */
  quantityOf(itemType) { return this.ledger.quantityOf(itemType); }

  /** 物品栏里有多少（所有格子合计）。 */
  hotbarQuantityOf(itemType) {
    let total = 0;
    for (const slot of this.hotbar) if (slot?.itemType === itemType) total += slot.quantity;
    return total;
  }

  /** 身上一共有多少：背包 + 物品栏。界面上「我还有几个」问的是这个数。 */
  totalQuantityOf(itemType) {
    return this.quantityOf(itemType) + this.hotbarQuantityOf(itemType);
  }

  /** 收进背包。拾取、容器取出、物品栏放回都走这条。 */
  add(itemType, quantity) {
    const accepted = this.ledger.add(itemType, quantity);
    if (accepted > 0) this.revision += 1;
    return accepted;
  }

  /** 从背包里取出。物品栏那几格不受影响，见 `consumeHotbarSlot`。 */
  remove(itemType, quantity) {
    const removed = this.ledger.remove(itemType, quantity);
    if (removed > 0) this.revision += 1;
    return removed;
  }

  clear() {
    const hadHotbar = this.hotbar.some((slot) => slot !== null);
    const cleared = this.ledger.clear();
    if (!cleared && !hadHotbar) return false;
    this.hotbar.fill(null);
    this.activeHotbarIndex = NO_HOTBAR_SLOT;
    this.revision += 1;
    return true;
  }

  /** 序号落在物品栏里才算数；越界的数字键什么都不做，而不是绕回第一格。 */
  isHotbarSlot(slotIndex) {
    return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < this.hotbarCapacity;
  }

  /**
   * 把背包里的一种物品装配到物品栏某格；`itemType` 为 null 时把那一格收回背包。
   *
   * 这是一次真实的转移，所以顺序很重要：**先把目标格原有的那一摞放回背包**，
   * 放不下就整件事不做——放不下还硬装，那一摞就凭空消失了。
   *
   * 同一种物品只占一格：它已经在别的格子上时，直接把那一格整摞挪过来，而不是
   * 再从背包里抽一摞出来（背包里可能根本没有了）。
   *
   * @returns 物品栏是否真的变了。
   */
  assignHotbarSlot(slotIndex, itemType) {
    if (!this.isHotbarSlot(slotIndex)) return false;
    const next = typeof itemType === 'string' && this.catalog.has(itemType) ? itemType : null;
    if (next === null) return this.clearHotbarSlot(slotIndex);

    const sourceIndex = this.hotbar.findIndex((slot) => slot?.itemType === next);
    if (sourceIndex === slotIndex) return false;
    if (sourceIndex >= 0) return this.swapHotbarSlots(sourceIndex, slotIndex);

    const definition = this.catalog.get(next);
    const available = Math.min(this.ledger.quantityOf(next), definition.stackLimit);
    if (available === 0) return false;
    // 腾格子：原有那一摞先回背包，回不去就放弃这次装配。
    if (!this.clearHotbarSlot(slotIndex, { allowEmpty: true })) return false;
    const moved = this.ledger.remove(next, available);
    if (moved === 0) return false;
    this.hotbar[slotIndex] = { itemType: next, quantity: moved };
    this.revision += 1;
    return true;
  }

  /**
   * 把物品栏某格整摞放回背包。
   *
   * 背包收不下就原样留在物品栏：这时把它删掉等于凭空销毁，留着让玩家自己腾地方
   * 才是能理解的结果。
   *
   * @param {{ allowEmpty?: boolean }} [options] `allowEmpty` 时空格也算成功，
   *   供 `assignHotbarSlot` 用「腾出这一格」这一个语义调用。
   * @returns 那一格现在是不是空的（或者说这次收回成没成）。
   */
  clearHotbarSlot(slotIndex, { allowEmpty = false } = {}) {
    if (!this.isHotbarSlot(slotIndex)) return false;
    const slot = this.hotbar[slotIndex];
    if (!slot) return allowEmpty;
    const accepted = this.ledger.add(slot.itemType, slot.quantity);
    if (accepted !== slot.quantity) {
      // 整摞放不回去就一个都不放：先撤销刚刚塞进去的那些，那一摞原样留在物品栏。
      this.ledger.remove(slot.itemType, accepted);
      return false;
    }
    this.hotbar[slotIndex] = null;
    this.revision += 1;
    return true;
  }

  /** 两格对调（拖拽时把一格拖到另一格上）。 */
  swapHotbarSlots(fromIndex, toIndex) {
    if (!this.isHotbarSlot(fromIndex) || !this.isHotbarSlot(toIndex)) return false;
    if (fromIndex === toIndex) return false;
    const from = this.hotbar[fromIndex];
    const to = this.hotbar[toIndex];
    if (!from && !to) return false;
    this.hotbar[fromIndex] = to;
    this.hotbar[toIndex] = from;
    this.revision += 1;
    return true;
  }

  /**
   * 从物品栏某格扣掉几个；扣空的格子直接空出来。
   *
   * 使用一次投掷物、把手上那件丢到地上，走的都是这条：物品栏是账本，手上那件
   * 不额外记一份，所以「用掉一个」就是这一格减一。
   *
   * @returns 实际扣掉的数量。
   */
  consumeHotbarSlot(slotIndex, quantity = 1) {
    if (!this.isHotbarSlot(slotIndex)) return 0;
    const slot = this.hotbar[slotIndex];
    const wanted = requestedQuantity(quantity);
    if (!slot || wanted === 0) return 0;
    const taken = Math.min(wanted, slot.quantity);
    slot.quantity -= taken;
    if (slot.quantity === 0) this.hotbar[slotIndex] = null;
    this.revision += 1;
    return taken;
  }

  /** 手上那一摞扣掉几个。空手时什么都不做。 */
  consumeHeldItem(quantity = 1) {
    return this.consumeHotbarSlot(this.activeHotbarIndex, quantity);
  }

  /**
   * 切到物品栏某一格；再按一次当前格，或传 `NO_HOTBAR_SLOT`，都是收手。
   *
   * @returns 手持是否真的变了。
   */
  setActiveHotbarSlot(slotIndex) {
    const next = this.isHotbarSlot(slotIndex) && slotIndex !== this.activeHotbarIndex
      ? slotIndex
      : NO_HOTBAR_SLOT;
    if (next === this.activeHotbarIndex) return false;
    this.activeHotbarIndex = next;
    this.revision += 1;
    return true;
  }

  /** 物品栏往前/往后挪一格（手柄 LB/RB）。空栏时什么都不做。 */
  cycleActiveHotbarSlot(direction) {
    const step = direction < 0 ? -1 : 1;
    if (this.hotbarCapacity === 0) return false;
    const from = this.activeHotbarIndex === NO_HOTBAR_SLOT ? -step : this.activeHotbarIndex;
    const next = ((from + step) % this.hotbarCapacity + this.hotbarCapacity) % this.hotbarCapacity;
    if (next === this.activeHotbarIndex) return false;
    this.activeHotbarIndex = next;
    this.revision += 1;
    return true;
  }

  snapshot() { return this.ledger.snapshot(); }

  /**
   * 物品栏内容与选中格；和背包一起下发，只发给物主。
   *
   * 每格带上数量，因为物品栏现在自己持有那一摞——只发 itemType 的话，客户端要
   * 去背包账上找数量，而那里已经没有它了。
   */
  hotbarSnapshot() {
    return {
      slots: this.hotbar.map((slot) => (slot ? { ...slot } : null)),
      activeIndex: this.activeHotbarIndex,
    };
  }

  /**
   * 客户端镜像：按快照重建背包与物品栏。
   *
   * @param {Array<{itemType: string, quantity: number}>} entries 背包内容
   * @param {number} [revision]
   * @param {{slots: Array<{itemType: string, quantity: number}|null>, activeIndex: number}} [hotbar]
   *   没有这一段时保持本地物品栏不动，只更新背包。
   * @returns {boolean} 内容或 revision 是否真的变了，供界面决定要不要重画。
   */
  applySnapshot(entries, revision = this.revision, hotbar = undefined) {
    const nextRevision = Math.max(0, Math.trunc(Number(revision) || 0));
    let changed = this.ledger.applySnapshot(entries) || nextRevision !== this.revision;
    if (hotbar) {
      const slots = Array.isArray(hotbar.slots) ? hotbar.slots : [];
      const next = new Array(this.hotbarCapacity).fill(null);
      for (let index = 0; index < this.hotbarCapacity; index += 1) {
        next[index] = this.sanitizeHotbarSlot(slots[index]);
      }
      const activeIndex = this.isHotbarSlot(hotbar.activeIndex)
        ? hotbar.activeIndex
        : NO_HOTBAR_SLOT;
      changed = changed
        || activeIndex !== this.activeHotbarIndex
        || next.some((slot, index) => !sameHotbarSlot(slot, this.hotbar[index]));
      this.hotbar = next;
      this.activeHotbarIndex = activeIndex;
    }
    this.revision = nextRevision;
    return changed;
  }

  /** 快照里没登记的物品、数量为 0 的格子一律当成空格，不写坏本地物品栏。 */
  sanitizeHotbarSlot(raw) {
    const definition = raw ? this.catalog.get(raw.itemType) : undefined;
    const quantity = requestedQuantity(raw?.quantity);
    if (!definition || quantity === 0) return null;
    return { itemType: definition.id, quantity: Math.min(quantity, definition.stackLimit) };
  }

  matches(slots, pooled) { return this.ledger.matches(slots, pooled); }
}

function sameHotbarSlot(left, right) {
  if (!left || !right) return left === right;
  return left.itemType === right.itemType && left.quantity === right.quantity;
}

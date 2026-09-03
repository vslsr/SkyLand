import { ActorComponent } from '../ActorComponent.mjs';
import { itemCatalog } from '../../items/index.mjs';
import { DEFAULT_SLOT_CAPACITY, ItemLedger } from '../ItemLedger.mjs';

export const INVENTORY_COMPONENT = 'inventory';

export { DEFAULT_SLOT_CAPACITY };

/** 快捷栏格数。原型没写时的默认值，界面按这个数画底部那一排圈。 */
export const DEFAULT_HOTBAR_CAPACITY = 4;

/** 空手。`activeHotbarIndex` 取这个值时嘴上不挂任何手持物。 */
export const NO_HOTBAR_SLOT = -1;

/** 交互键按住多久算「收回背包」而不是「放下」。原型没写时的默认值。 */
export const DEFAULT_STOW_HOLD_SECONDS = 0.6;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * 角色背包与快捷栏。
 *
 * 内容记在 `ItemLedger` 上（和容器共用同一套堆叠与货位规则）；这里额外owns
 * 一件容器没有的东西——**快捷栏**。
 *
 * 快捷栏格子里存的是 `itemType` 而不是某一堆的下标：
 *
 * - 界面是自动分类排序的，没有稳定的「第几格」可以引用；
 * - 两个玩家同时掏同一个箱子时，下标会错位，itemType 不会；
 * - 一种物品用光之后配置仍然留在格子上，补货回来就还在原位。
 *
 * 手上到底有没有东西，由「这一格配置的物品在账本里还有没有」决定，
 * 见 `heldItemType`。权威数据只在房间服务端变化，客户端靠 `applySnapshot` 跟随。
 */
export class InventoryComponent extends ActorComponent {
  constructor(definition = {}, catalog = itemCatalog) {
    super(INVENTORY_COMPONENT);
    this.catalog = catalog;
    this.ledger = new ItemLedger(
      positiveInteger(definition.slotCapacity, DEFAULT_SLOT_CAPACITY),
      catalog,
    );
    this.hotbarCapacity = positiveInteger(definition.hotbarCapacity, DEFAULT_HOTBAR_CAPACITY);
    /**
     * 交互键短按是放下、长按是收回背包，这里是两者的分界。
     *
     * 它来自原型配置而不是常量：客户端画的那圈进度和服务端判定用的是同一个数，
     * 转盘转满那一刻就是服务端认定长按那一刻。两端各写一个数就会出现「转盘满了
     * 但东西掉在了地上」。
     */
    this.stowHoldSeconds = Number.isFinite(Number(definition.stowHoldSeconds))
      && Number(definition.stowHoldSeconds) > 0
      ? Number(definition.stowHoldSeconds)
      : DEFAULT_STOW_HOLD_SECONDS;
    /** @type {(string | null)[]} 每格配置的物品种类；null 是没配置过的空格。 */
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
   * 当前真正握在手上的物品种类。
   *
   * 配置还在、货已经用光时是 undefined：那一格在界面上仍然记着这件东西，
   * 但手上是空的，补货回来自动恢复，不需要玩家再配一次。
   */
  get heldItemType() {
    const itemType = this.hotbar[this.activeHotbarIndex] ?? null;
    if (!itemType || this.quantityOf(itemType) === 0) return undefined;
    return itemType;
  }

  quantityOf(itemType) { return this.ledger.quantityOf(itemType); }

  add(itemType, quantity) {
    const accepted = this.ledger.add(itemType, quantity);
    if (accepted > 0) this.revision += 1;
    return accepted;
  }

  remove(itemType, quantity) {
    const removed = this.ledger.remove(itemType, quantity);
    if (removed > 0) this.revision += 1;
    return removed;
  }

  clear() {
    if (!this.ledger.clear()) return false;
    this.revision += 1;
    return true;
  }

  /**
   * 把一种物品配置到快捷栏某格；`itemType` 为 null 时清空该格。
   *
   * 同一种物品只允许占一格：配置到新格时先把旧格清掉，否则两格画的是同一堆货，
   * 数量还会同步变化，玩家没法理解那是一件东西。
   *
   * @returns 配置是否真的变了。
   */
  assignHotbarSlot(slotIndex, itemType) {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.hotbarCapacity) {
      return false;
    }
    const next = typeof itemType === 'string' && this.catalog.has(itemType) ? itemType : null;
    const previousIndex = next ? this.hotbar.indexOf(next) : -1;
    if (previousIndex === slotIndex && this.hotbar[slotIndex] === next) return false;
    if (previousIndex >= 0) this.hotbar[previousIndex] = null;
    this.hotbar[slotIndex] = next;
    this.revision += 1;
    return true;
  }

  /**
   * 切到快捷栏某一格；再按一次当前格，或传 `NO_HOTBAR_SLOT`，都是收手。
   *
   * @returns 手持是否真的变了。
   */
  setActiveHotbarSlot(slotIndex) {
    const next = Number.isInteger(slotIndex)
      && slotIndex >= 0
      && slotIndex < this.hotbarCapacity
      && slotIndex !== this.activeHotbarIndex
      ? slotIndex
      : NO_HOTBAR_SLOT;
    if (next === this.activeHotbarIndex) return false;
    this.activeHotbarIndex = next;
    this.revision += 1;
    return true;
  }

  /** 把一种物品放上快捷栏并立刻握在手上；界面里点一下格子走的就是这条。 */
  holdItemType(itemType) {
    if (!this.catalog.has(itemType)) return false;
    // 已经在栏上就直接切过去；没有就占用第一个空格，全满时覆盖当前手持那一格。
    const firstEmpty = this.hotbar.indexOf(null);
    const slotIndex = this.hotbar.indexOf(itemType) >= 0
      ? this.hotbar.indexOf(itemType)
      : (firstEmpty >= 0 ? firstEmpty : Math.max(0, this.activeHotbarIndex));
    const assigned = this.assignHotbarSlot(slotIndex, itemType);
    if (this.activeHotbarIndex === slotIndex) return assigned;
    this.activeHotbarIndex = slotIndex;
    if (!assigned) this.revision += 1;
    return true;
  }

  /** 快捷栏往前/往后挪一格（手柄 LB/RB）。空栏时什么都不做。 */
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

  /** 快捷栏配置与选中格；和内容一起下发，只发给物主。 */
  hotbarSnapshot() {
    return { slots: [...this.hotbar], activeIndex: this.activeHotbarIndex };
  }

  /**
   * 客户端镜像：按快照重建内容与快捷栏。
   *
   * @returns 内容或 revision 是否真的变了，供界面决定要不要重画。
   */
  applySnapshot(entries, revision = this.revision, hotbar = undefined) {
    const nextRevision = Math.max(0, Math.trunc(Number(revision) || 0));
    let changed = this.ledger.applySnapshot(entries) || nextRevision !== this.revision;
    if (hotbar) {
      const slots = Array.isArray(hotbar.slots) ? hotbar.slots : [];
      const next = new Array(this.hotbarCapacity).fill(null);
      for (let index = 0; index < this.hotbarCapacity; index += 1) {
        const itemType = slots[index];
        next[index] = typeof itemType === 'string' && this.catalog.has(itemType) ? itemType : null;
      }
      const activeIndex = Number.isInteger(hotbar.activeIndex)
        && hotbar.activeIndex >= 0
        && hotbar.activeIndex < this.hotbarCapacity
        ? hotbar.activeIndex
        : NO_HOTBAR_SLOT;
      changed = changed
        || activeIndex !== this.activeHotbarIndex
        || next.some((itemType, index) => itemType !== this.hotbar[index]);
      this.hotbar = next;
      this.activeHotbarIndex = activeIndex;
    }
    this.revision = nextRevision;
    return changed;
  }

  matches(slots, pooled) { return this.ledger.matches(slots, pooled); }
}

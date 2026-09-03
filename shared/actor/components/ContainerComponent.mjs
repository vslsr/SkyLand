import { ActorComponent } from '../ActorComponent.mjs';
import { itemCatalog } from '../../items/index.mjs';
import { ItemLedger } from '../ItemLedger.mjs';

export const CONTAINER_COMPONENT = 'container';

/** 原型没写 slotCapacity 时的箱子容量：明显大于随身货位，才值得跑一趟回来存。 */
export const DEFAULT_CONTAINER_CAPACITY = 24;

/** 离开这个距离，服务端替玩家关掉容器界面；和拾取距离同量级。 */
export const DEFAULT_CONTAINER_REACH = 3.2;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * 可存取的容器：箱子、船舱。
 *
 * 和背包装的是同一种东西、守的是同一套堆叠规则，所以内容同样记在 `ItemLedger`
 * 上，区别只有两条：
 *
 * - **容量更大**，这是「大宗资源存进船舱」这条循环成立的理由；
 * - **归世界所有，不归某个玩家所有**，因此同一个箱子可以同时被几个人翻。
 *
 * 多人共享靠的是权威顺序而不是锁：所有存取都在房间 DS 的同一条 tick 线上依次
 * 执行，`ItemLedger.remove` 按账上实际有的数量截断，所以两个人同时取最后一摞，
 * 先到的拿走，后到的拿到 0 并原样收到下一帧快照。`viewerPlayerIds` 只决定
 * 内容发给谁，不构成任何独占。
 */
export class ContainerComponent extends ActorComponent {
  constructor(definition = {}, catalog = itemCatalog) {
    super(CONTAINER_COMPONENT);
    this.ledger = new ItemLedger(definition.slotCapacity ?? DEFAULT_CONTAINER_CAPACITY, catalog);
    this.label = typeof definition.label === 'string' && definition.label.length > 0
      ? definition.label
      : '储物箱';
    this.reach = positiveNumber(definition.reach, DEFAULT_CONTAINER_REACH);
    /** 正开着这个容器的玩家；内容只发给他们，走远由服务端移出。 */
    this.viewerPlayerIds = new Set();
    this.revision = 0;
  }

  get slotCapacity() { return this.ledger.slotCapacity; }

  get usedSlots() { return this.ledger.usedSlots; }

  get freeSlots() { return this.ledger.freeSlots; }

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

  openFor(playerId) {
    if (!playerId || this.viewerPlayerIds.has(playerId)) return false;
    this.viewerPlayerIds.add(playerId);
    this.revision += 1;
    return true;
  }

  closeFor(playerId) {
    if (!this.viewerPlayerIds.delete(playerId)) return false;
    this.revision += 1;
    return true;
  }

  isOpenFor(playerId) { return this.viewerPlayerIds.has(playerId); }

  /**
   * 复制形态。内容只发给正开着它的人：没开箱子的玩家不需要知道里面有什么，
   * 一屋子箱子也不会每帧把全部库存推给所有人。
   */
  snapshot(viewerPlayerId) {
    const open = Boolean(viewerPlayerId) && this.viewerPlayerIds.has(viewerPlayerId);
    return {
      label: this.label,
      slotCapacity: this.slotCapacity,
      usedSlots: this.usedSlots,
      viewerCount: this.viewerPlayerIds.size,
      open,
      ...(open ? { entries: this.ledger.snapshot() } : {}),
      revision: this.revision,
    };
  }
}

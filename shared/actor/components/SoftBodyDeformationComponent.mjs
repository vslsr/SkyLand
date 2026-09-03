import { ActorComponent } from '../ActorComponent.mjs';
import { MAX_SOFT_BODY_HOLDERS } from '../../softBodyDeformation.mjs';

export const SOFT_BODY_DEFORMATION_COMPONENT = 'softBodyDeformation';

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 一块可被外力捏变形的软体外壳。
 *
 * 两类来源，各占一半，形状完全不同：
 * - **外壳主人自己上报的鼠标拖拽**。服务端不模拟它，只净化、超时与转发，所以
 *   命中点、位移、抓取计数这几个数只为它存在；
 * - **场景里别的 Actor 抓着**——今天是别人的嘴，之后可以是地上的倒刺、抓手、
 *   吸盘。这一半**不带任何形状**，只记「谁抓着、绳有多长、拉断没有」，而且
 *   **可以同时有好几个**：每多一张嘴，画面上就多一个尖。
 *
 * 被抓成什么样是纯表现，而且**不过网络**：快照里只有「谁咬着谁」这些离散关系
 * （`bitingPlayerId`），两边的位置本来就是权威复制过来的，所以每个客户端自己按
 * 位置算那些突起向量（见 `src/player/slimeBiteTip.ts`），一张嘴一个，求解器把
 * 它们的位移加起来。算的是当前渲染帧的插值位置，尖因此始终贴着嘴。
 *
 * 它只描述抓握，不描述玩法：不掉血、不减速；被抓者被拖走是缰绳干的，不是这里。
 */
export class SoftBodyDeformationComponent extends ActorComponent {
  /** sourceId → 那一次抓握的绳长、锚点与速度。最多 `MAX_SOFT_BODY_HOLDERS` 个。 */
  #holders = new Map();

  constructor(definition = {}) {
    super(SOFT_BODY_DEFORMATION_COMPONENT);
    /** 外力把外壳拉出这么远就自动脱手，免得有人把别人一路拽过整张地图。 */
    this.breakDistance = Math.max(0, finiteOr(definition.breakDistance, 1));
    /** 自己上报的拖拽多久没续期就作废（毫秒）。 */
    this.selfReportTimeoutMs = Math.max(0, finiteOr(definition.selfReportTimeoutMs, 600));
    /** 自己上报的那一份拖拽还在不在。外力那一半在 `#holders` 里。 */
    this.selfReported = false;
    this.contactX = 0;
    this.contactY = 0;
    this.contactZ = 0;
    this.pullX = 0;
    this.pullY = 0;
    this.pullZ = 0;
    /**
     * 抓取计数。换一次抓取就加一，接收端据此重建影响权重而不是继续拉旧的那块蒙皮。
     * 只有自己上报的拖拽用得上它：外力那一半的形状是各客户端当场算的，没有
     * 「同一次抓取」这件事要跨帧对齐。
     */
    this.revision = 0;
    this.expiresAt = undefined;
  }

  get active() {
    return this.selfReported || this.#holders.size > 0;
  }

  /** 正被别的 Actor 抓着；这时主人自己的拖拽不参与。 */
  get heldExternally() {
    return this.#holders.size > 0;
  }

  /** 现在有几张嘴咬着。 */
  get holderCount() {
    return this.#holders.size;
  }

  isHeldBy(sourceId) {
    return this.#holders.has(sourceId);
  }

  /**
   * 外力抓住这块外壳。它只记录「谁抓着、绳有多长」——形变一个数都不在这里。
   *
   * 同一个来源不能抓两次；到了 `MAX_SOFT_BODY_HOLDERS` 就抓不上——参数段是定长的，
   * 而且三个尖之后画面上也分不出来了。
   */
  grab(sourceId, options = {}) {
    if (!sourceId || this.#holders.has(sourceId)) return false;
    if (this.#holders.size >= MAX_SOFT_BODY_HOLDERS) return false;
    this.#holders.set(sourceId, {
      grabDistance: Math.max(0, finiteOr(options.grabDistance)),
      leashSlack: Math.max(0, finiteOr(options.leashSlack)),
      leashStiffness: Math.max(0, finiteOr(options.leashStiffness)),
      leashDamping: Math.max(0, finiteOr(options.leashDamping)),
      leashCarry: Math.max(0, finiteOr(options.leashCarry)),
      anchorX: 0,
      anchorZ: 0,
      anchorVelocityX: 0,
      anchorVelocityZ: 0,
      overshoot: 0,
    });
    // 外力压过主人自己的鼠标：自报的那一份到此为止。
    this.selfReported = false;
    this.expiresAt = undefined;
    this.pullX = 0;
    this.pullY = 0;
    this.pullZ = 0;
    return true;
  }

  /**
   * 每 tick 给出施力方这一刻的位置：更新缰绳锚点，并回答这次抓握还成不成立。
   *
   * 返回 false 表示两边已经分开超过 `breakDistance`，调用方应当脱手。拉断看的是
   * 位置，和外形无关——外形是客户端按同样这两个位置自己算的。
   */
  updateHold(sourceId, pose, sourcePosition, sourceVelocity) {
    const holder = this.#holders.get(sourceId);
    if (!holder) return false;
    holder.anchorX = finiteOr(sourcePosition.x);
    holder.anchorZ = finiteOr(sourcePosition.z);
    // 不动的外力（地上的倒刺）不传速度，于是拖带项自然是 0：它只会拴住人，
    // 不会把人拖走。
    holder.anchorVelocityX = finiteOr(sourceVelocity?.vx);
    holder.anchorVelocityZ = finiteOr(sourceVelocity?.vz);
    const separationX = holder.anchorX - finiteOr(pose.x);
    const separationY = finiteOr(sourcePosition.y) - finiteOr(pose.y);
    const separationZ = holder.anchorZ - finiteOr(pose.z);
    const distance = Math.hypot(separationX, separationY, separationZ);
    // 绳绷得多紧：`tautestHold` 按它挑。
    holder.overshoot = distance - (holder.grabDistance + holder.leashSlack);
    return distance - holder.grabDistance <= this.breakDistance;
  }

  /**
   * 这一帧真正在拉人的那根绳，没有就返回 undefined。
   *
   * 几张嘴咬着就有几根绳，可共享固定步只吃一根。松着的绳本来就不出力（绳子就是
   * 这样），所以取**绷得最紧**的那根：它把人拉回去之后自己就松了，另一根随之成为
   * 最紧的，于是被咬者会停在几张嘴共同够得着的那块地方。
   */
  tautestHold() {
    let tautest;
    for (const holder of this.#holders.values()) {
      if (holder.leashStiffness <= 0) continue;
      if (!tautest || holder.overshoot > tautest.overshoot) tautest = holder;
    }
    return tautest;
  }

  /**
   * 外壳主人自己上报的鼠标拖拽。它让位于任何外力，并且必须持续续期：
   * 客户端掉线或漏发松手时，形变不能永远留在快照里。
   */
  applySelfReported(state, now, regrab) {
    if (this.heldExternally) return false;
    if (!this.selfReported || regrab) this.revision += 1;
    this.selfReported = true;
    this.contactX = state.contactX;
    this.contactY = state.contactY;
    this.contactZ = state.contactZ;
    this.pullX = state.pullX;
    this.pullY = state.pullY;
    this.pullZ = state.pullZ;
    this.expiresAt = now + this.selfReportTimeoutMs;
    return true;
  }

  /** 只有当前来源能松手；别人松不了别人的。`null` 是主人自己那一份。 */
  release(sourceId) {
    if (sourceId === null || sourceId === undefined) {
      if (!this.selfReported) return false;
      this.selfReported = false;
      this.expiresAt = undefined;
      this.pullX = 0;
      this.pullY = 0;
      this.pullZ = 0;
      return true;
    }
    return this.#holders.delete(sourceId);
  }

  /** 自己上报的那一份到期就作废；外力不会过期，它由来源自己松手。 */
  expire(now) {
    if (this.expiresAt === undefined || now <= this.expiresAt) return false;
    return this.release(null);
  }

  /**
   * 会被复制出去的公共状态：只有**外壳主人自己上报的鼠标拖拽**。
   *
   * 被别的 Actor 抓着的时候这里什么都不发——那些形变由各客户端按位置自己算。
   */
  snapshot() {
    if (!this.selfReported) return undefined;
    return {
      revision: this.revision,
      contactX: this.contactX,
      contactY: this.contactY,
      contactZ: this.contactZ,
      pullX: this.pullX,
      pullY: this.pullY,
      pullZ: this.pullZ,
    };
  }
}

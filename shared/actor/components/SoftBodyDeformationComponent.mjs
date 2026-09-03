import { ActorComponent } from '../ActorComponent.mjs';

export const SOFT_BODY_DEFORMATION_COMPONENT = 'softBodyDeformation';

/**
 * 形变来源的优先级。外力压过玩家自己的鼠标：一块外壳只有一个形变来源，
 * 被咬住、被倒刺钩住的时候，自己那点拖拽说了不算。
 */
const SELF_REPORTED_SOURCE = null;

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 一块可被外力捏变形的软体外壳。
 *
 * 谁在捏由 `sourceId` 决定，同一时刻只有一个：
 * - `null` 是外壳主人自己上报的鼠标拖拽。服务端不模拟它，只净化、超时与转发，
 *   所以命中点、位移、抓取计数这几个数只为它存在；
 * - 其它值是场景里另一个 Actor 抓着——今天是别人的嘴，之后可以是地上的倒刺、
 *   抓手、吸盘。这一半**不带任何形状**：这里只记「谁抓着、绳有多长、拉断没有」。
 *
 * 被抓成什么样是纯表现，而且**不过网络**：快照里只有「谁咬着谁」这一个离散状态
 * （`bitingPlayerId`），两边的位置本来就是权威复制过来的，所以每个客户端自己按
 * 位置算那个突起向量（见 `src/player/slimeBiteTip.ts`）。算的是当前渲染帧的插值
 * 位置，尖因此始终贴着嘴，而不是比位置慢一个快照。
 *
 * 它只描述抓握，不描述玩法：不掉血、不减速；被抓者被拖走是缰绳干的，不是这里。
 */
export class SoftBodyDeformationComponent extends ActorComponent {
  constructor(definition = {}) {
    super(SOFT_BODY_DEFORMATION_COMPONENT);
    /** 外力把外壳拉出这么远就自动脱手，免得有人把别人一路拽过整张地图。 */
    this.breakDistance = Math.max(0, finiteOr(definition.breakDistance, 1));
    /** 自己上报的拖拽多久没续期就作废（毫秒）。 */
    this.selfReportTimeoutMs = Math.max(0, finiteOr(definition.selfReportTimeoutMs, 600));
    this.sourceId = undefined;
    this.contactX = 0;
    this.contactY = 0;
    this.contactZ = 0;
    this.pullX = 0;
    this.pullY = 0;
    this.pullZ = 0;
    /**
     * 抓取计数。换一次抓取就加一，接收端据此重建影响权重而不是继续拉旧的那块蒙皮。
     * 所有来源共用同一个计数器：分开计数会让「先被咬、松口后再自己拖」复用同一个
     * 号，接收端就不会重新拾取。
     */
    this.revision = 0;
    this.expiresAt = undefined;
    /** 抓住那一刻两者的距离。缰绳的绳长与拉断距离都从这里起算。 */
    this.grabDistance = 0;
    /** 施力方最后一次的世界位置，缰绳的锚点就是它。 */
    this.anchorX = 0;
    this.anchorZ = 0;
    /** 施力方自己的速度。绳绷紧时被拖者直接按它走，所以拖拽赢过被拖者的驱动。 */
    this.anchorVelocityX = 0;
    this.anchorVelocityZ = 0;
    this.leashSlack = 0;
    this.leashStiffness = 0;
    this.leashDamping = 0;
    this.leashCarry = 0;
  }

  get active() {
    return this.sourceId !== undefined;
  }

  /** 正被别的 Actor 施加外力；这时主人自己的拖拽不参与。 */
  get heldExternally() {
    return this.active && this.sourceId !== SELF_REPORTED_SOURCE;
  }

  /**
   * 外力抓住这块外壳。它只记录「谁抓着、绳有多长」——形变一个数都不在这里。
   *
   * 被咬成什么形状是纯表现：快照里只有「谁咬着谁」这一个离散状态，两边的位置
   * 本来就是权威复制过来的，所以每个客户端自己按位置算那个突起向量。服务端算
   * 一遍再下发六个数，既多占带宽，画面上还比位置慢一个快照。
   */
  grab(sourceId, options = {}) {
    if (!sourceId || this.heldExternally) return false;
    this.sourceId = sourceId;
    this.grabDistance = Math.max(0, finiteOr(options.grabDistance));
    this.leashSlack = Math.max(0, finiteOr(options.leashSlack));
    this.leashStiffness = Math.max(0, finiteOr(options.leashStiffness));
    this.leashDamping = Math.max(0, finiteOr(options.leashDamping));
    this.leashCarry = Math.max(0, finiteOr(options.leashCarry));
    this.revision += 1;
    this.expiresAt = undefined;
    return true;
  }

  /**
   * 每 tick 给出施力方这一刻的位置：更新缰绳锚点，并回答这次抓握还成不成立。
   *
   * 返回 false 表示两边已经分开超过 `breakDistance`，调用方应当脱手。拉断看的是
   * 位置，和外形无关——外形是客户端按同样这两个位置自己算的。
   */
  updateHold(sourceId, pose, sourcePosition, sourceVelocity) {
    if (this.sourceId !== sourceId || !this.heldExternally) return false;
    this.anchorX = finiteOr(sourcePosition.x);
    this.anchorZ = finiteOr(sourcePosition.z);
    // 不动的外力（地上的倒刺）不传速度，于是拖带项自然是 0：它只会拴住人，
    // 不会把人拖走。
    this.anchorVelocityX = finiteOr(sourceVelocity?.vx);
    this.anchorVelocityZ = finiteOr(sourceVelocity?.vz);
    const separationX = this.anchorX - finiteOr(pose.x);
    const separationY = finiteOr(sourcePosition.y) - finiteOr(pose.y);
    const separationZ = this.anchorZ - finiteOr(pose.z);
    const stretch = Math.hypot(separationX, separationY, separationZ) - this.grabDistance;
    return stretch <= this.breakDistance;
  }

  /**
   * 外壳主人自己上报的鼠标拖拽。它让位于任何外力，并且必须持续续期：
   * 客户端掉线或漏发松手时，形变不能永远留在快照里。
   */
  applySelfReported(state, now, regrab) {
    if (this.heldExternally) return false;
    if (this.sourceId !== SELF_REPORTED_SOURCE || regrab) this.revision += 1;
    this.sourceId = SELF_REPORTED_SOURCE;
    this.contactX = state.contactX;
    this.contactY = state.contactY;
    this.contactZ = state.contactZ;
    this.pullX = state.pullX;
    this.pullY = state.pullY;
    this.pullZ = state.pullZ;
    this.expiresAt = now + this.selfReportTimeoutMs;
    return true;
  }

  /** 只有当前来源能松手；别人松不了别人的。 */
  release(sourceId) {
    if (this.sourceId !== sourceId) return false;
    this.sourceId = undefined;
    this.expiresAt = undefined;
    this.pullX = 0;
    this.pullY = 0;
    this.pullZ = 0;
    return true;
  }

  /** 自己上报的那一份到期就作废；外力不会过期，它由来源自己松手。 */
  expire(now) {
    if (this.expiresAt === undefined || now <= this.expiresAt) return false;
    return this.release(this.sourceId);
  }

  /**
   * 会被复制出去的公共状态：只有**外壳主人自己上报的鼠标拖拽**。
   *
   * 被别的 Actor 抓着的时候这里什么都不发——那份形变由各客户端按两边位置自己算。
   */
  snapshot() {
    if (!this.active || this.heldExternally) return undefined;
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

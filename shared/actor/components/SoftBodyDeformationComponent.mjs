import { ActorComponent } from '../ActorComponent.mjs';
import { actorWorldVectorToLocal } from '../../softBodyDeformation.mjs';

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
 * - `null` 是外壳主人自己上报的鼠标拖拽，带超时，掉线就自己过期；
 * - 其它值是场景里另一个 Actor 施加的外力——今天是别人的嘴，之后可以是地上的
 *   倒刺、抓手、吸盘。外力来源只需要每 tick 给出一个世界锚点，其余（命中点固定、
 *   抓取计数、拉断距离）都在这里。
 *
 * 它只描述形变，不描述玩法：不掉血、不减速、也不移动被捏的那个 Actor。求解与
 * 渲染在客户端，这里只有会被复制出去的那七个数。
 */
export class SoftBodyDeformationComponent extends ActorComponent {
  /** 每 tick 复用的换算缓冲，避免热路径分配。 */
  #localPull = { x: 0, y: 0, z: 0 };

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
     * 这一次抓取有多「尖」。0 是外壳主人自己的鼠标拖拽——影响圈很大、整团跟着走；
     * 1 是牙齿之类的外力——影响圈收窄、命中处拔出一个尖。由施力方给出，因为
     * 同一块外壳被鼠标拖和被咬，形状本来就该不一样。
     */
    this.pinch = 0;
    /**
     * 抓取计数。换一次抓取就加一，接收端据此重建影响权重而不是继续拉旧的那块蒙皮。
     * 所有来源共用同一个计数器：分开计数会让「先被咬、松口后再自己拖」复用同一个
     * 号，接收端就不会重新拾取。
     */
    this.revision = 0;
    this.expiresAt = undefined;
    /** 抓住那一刻两者的距离；形变长度从这里起算，所以咬住的瞬间不变形。 */
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
   * 外力抓住一处外壳。命中点固定在抓住那一刻的那块皮上，之后 Actor 转身时
   * 它跟着一起转，所以只在这里写一次。
   */
  grab(sourceId, contact, options = {}) {
    if (!sourceId || this.heldExternally) return false;
    this.sourceId = sourceId;
    this.contactX = finiteOr(contact.x);
    this.contactY = finiteOr(contact.y);
    this.contactZ = finiteOr(contact.z);
    this.pullX = 0;
    this.pullY = 0;
    this.pullZ = 0;
    this.pinch = Math.max(0, Math.min(1, finiteOr(options.pinch, 1)));
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
   * 每 tick 给出施力方的世界位置，兑现成这一帧的形变位移。
   *
   * 方向取**被捏者指向施力方**，长度是抓住之后两者多分开的距离。不能拿「锚点
   * 减命中点」当位移：咬住的距离很近，嘴往往就落在外壳附近甚至内侧，那个差向量
   * 会指进身体里，画面上是个凹包而不是被扯出来的尖。
   *
   * 返回 false 表示已经拉断，调用方应当脱手。
   */
  pullToward(sourceId, pose, sourcePosition, sourceVelocity) {
    if (this.sourceId !== sourceId || !this.heldExternally) return false;
    this.anchorX = finiteOr(sourcePosition.x);
    this.anchorZ = finiteOr(sourcePosition.z);
    // 不动的外力（地上的倒刺）不传速度，于是拖带项自然是 0：它只会拴住人，
    // 不会把人拖走。
    this.anchorVelocityX = finiteOr(sourceVelocity?.vx);
    this.anchorVelocityZ = finiteOr(sourceVelocity?.vz);
    const deltaX = this.anchorX - finiteOr(pose.x);
    const deltaY = finiteOr(sourcePosition.y) - finiteOr(pose.y);
    const deltaZ = this.anchorZ - finiteOr(pose.z);
    const distance = Math.hypot(deltaX, deltaY, deltaZ);
    const stretch = distance - this.grabDistance;
    if (!(stretch > 0) || distance <= 1e-6) {
      this.pullX = 0;
      this.pullY = 0;
      this.pullZ = 0;
      return true;
    }
    const scale = stretch / distance;
    const local = actorWorldVectorToLocal(
      finiteOr(pose.yaw),
      deltaX * scale,
      deltaY * scale,
      deltaZ * scale,
      this.#localPull,
    );
    this.pullX = local.x;
    this.pullY = local.y;
    this.pullZ = local.z;
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
    // 主人自己拖自己：整团跟着走，不拔尖。客户端无从选择，也就不多一个可伪造项。
    this.pinch = 0;
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

  /** 会被复制出去的公共状态；没有形变时不下发。 */
  snapshot() {
    if (!this.active) return undefined;
    return {
      revision: this.revision,
      contactX: this.contactX,
      contactY: this.contactY,
      contactZ: this.contactZ,
      pullX: this.pullX,
      pullY: this.pullY,
      pullZ: this.pullZ,
      pinch: this.pinch,
    };
  }
}

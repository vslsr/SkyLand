import { ActorComponent } from '../ActorComponent.mjs';
import { worldToShellOffset } from '../../softBodyDeformation.mjs';

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
  #localGrip = { x: 0, y: 0, z: 0 };

  #gripWorld = { x: 0, y: 0, z: 0 };

  #poseOrigin = { x: 0, y: 0, z: 0 };

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
    /**
     * 命中处的朝外法线，被捏者的外壳坐标，抓住那一刻定下来。
     *
     * 它只有一个用途：判断外力是把这块皮**往外扯**还是**往身体里压**。往里压出来
     * 的是个凹包，不是被咬住，所以那一半会被抬回法线方向上。
     */
    this.normalX = 0;
    this.normalY = 0;
    this.normalZ = 1;
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
    /** 抓住那一刻两者的距离。缰绳的绳长与拉断距离都从这里起算。 */
    this.grabDistance = 0;
    /**
     * 抓握深度（米）：即使施力方贴着外壳、甚至埋进外壳里，也至少沿法线拔出这么多。
     *
     * 没有它，「咬住」在最常见的贴身距离上是看不见的：外壳半径 0.95 m 而角色碰撞
     * 半径只有 0.52 m，两只史莱姆挨在一起时外壳本来就互相穿插，嘴落在被咬者的皮
     * 里面，纯几何算出来的位移是零甚至朝里。牙齿咬住本来就会**捏起一块皮**，
     * 深度是牙的属性，不是两人间距的属性。
     */
    this.gripDepth = 0;
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
   * 外力抓住一处外壳。命中点固定在抓住那一刻的那块皮上，所以只在这里写一次。
   *
   * 坐标是**外壳坐标**（`worldToShellOffset`：Actor 原点 + 世界轴向）。外壳本来
   * 就不跟着 Actor 转身，命中点也就不该跟着转——按 Actor 本地坐标存，形变会整体
   * 偏掉一个 yaw。
   */
  grab(sourceId, contact, options = {}) {
    if (!sourceId || this.heldExternally) return false;
    this.sourceId = sourceId;
    this.contactX = finiteOr(contact.x);
    this.contactY = finiteOr(contact.y);
    this.contactZ = finiteOr(contact.z);
    // 法线由 `resolveSurfaceContact` 一起给出；万一来源没给，退回命中点自身的方向，
    // 那也是外壳上的朝外方向，只是没有被身体中心的高度修正过。
    const normalLength = Math.hypot(
      finiteOr(contact.normalX),
      finiteOr(contact.normalY),
      finiteOr(contact.normalZ),
    );
    const fallbackLength = Math.hypot(this.contactX, this.contactY, this.contactZ);
    if (normalLength > 1e-6) {
      this.normalX = finiteOr(contact.normalX) / normalLength;
      this.normalY = finiteOr(contact.normalY) / normalLength;
      this.normalZ = finiteOr(contact.normalZ) / normalLength;
    } else if (fallbackLength > 1e-6) {
      this.normalX = this.contactX / fallbackLength;
      this.normalY = this.contactY / fallbackLength;
      this.normalZ = this.contactZ / fallbackLength;
    } else {
      this.normalX = 0;
      this.normalY = 0;
      this.normalZ = 1;
    }
    this.pullX = 0;
    this.pullY = 0;
    this.pullZ = 0;
    this.pinch = Math.max(0, Math.min(1, finiteOr(options.pinch, 1)));
    this.grabDistance = Math.max(0, finiteOr(options.grabDistance));
    this.gripDepth = Math.max(0, finiteOr(options.gripDepth));
    this.leashSlack = Math.max(0, finiteOr(options.leashSlack));
    this.leashStiffness = Math.max(0, finiteOr(options.leashStiffness));
    this.leashDamping = Math.max(0, finiteOr(options.leashDamping));
    this.leashCarry = Math.max(0, finiteOr(options.leashCarry));
    this.revision += 1;
    this.expiresAt = undefined;
    return true;
  }

  /**
   * 每 tick 给出施力方这一刻的位置，兑现成这一帧的形变位移。
   *
   * 被抓住的那块皮**就在抓握点上**（牙齿的话就是嘴），所以位移是
   * 「抓握点 − 那块皮现在在哪儿」，两边都落到外壳坐标里算。咬住的当下就该看得见
   * 一个尖，而不是等两个人走开之后才慢慢有——「按住不动就什么也没有」正是之前
   * 那版的毛病。
   *
   * 两处修正，缺一个就会画错：
   * - **不能往身体里压**。嘴挂在施力方身前 0.42 m，贴身咬的时候常常落在被咬者的
   *   外壳里面，这时的差向量指向身体内部，画出来是个凹包。所以差向量沿法线的分量
   *   低于 `gripDepth` 时，把它抬回 `gripDepth`：牙齿咬住本来就会捏起一块皮。
   * - **缰绳锚点用的是施力方的身体，不是抓握点**。用嘴当锚点等于把绳长凭空缩短
   *   半米，被咬者会被拽得贴到脸上。
   *
   * 返回 false 表示已经拉断，调用方应当脱手。拉断看的仍然是两边**位置**分开了
   * 多少：形变是表现，脱口是玩法，不该被外形的调参牵着走。
   */
  pullToward(sourceId, pose, sourcePosition, sourceVelocity, gripWorld = sourcePosition) {
    if (this.sourceId !== sourceId || !this.heldExternally) return false;
    this.anchorX = finiteOr(sourcePosition.x);
    this.anchorZ = finiteOr(sourcePosition.z);
    // 不动的外力（地上的倒刺）不传速度，于是拖带项自然是 0：它只会拴住人，
    // 不会把人拖走。
    this.anchorVelocityX = finiteOr(sourceVelocity?.vx);
    this.anchorVelocityZ = finiteOr(sourceVelocity?.vz);

    this.#poseOrigin.x = finiteOr(pose.x);
    this.#poseOrigin.y = finiteOr(pose.y);
    this.#poseOrigin.z = finiteOr(pose.z);
    this.#gripWorld.x = finiteOr(gripWorld.x);
    this.#gripWorld.y = finiteOr(gripWorld.y);
    this.#gripWorld.z = finiteOr(gripWorld.z);
    const grip = worldToShellOffset(this.#poseOrigin, this.#gripWorld, this.#localGrip);
    let pullX = grip.x - this.contactX;
    let pullY = grip.y - this.contactY;
    let pullZ = grip.z - this.contactZ;
    const reach = pullX * this.normalX + pullY * this.normalY + pullZ * this.normalZ;
    if (reach < this.gripDepth) {
      const lift = this.gripDepth - reach;
      pullX += this.normalX * lift;
      pullY += this.normalY * lift;
      pullZ += this.normalZ * lift;
    }
    // 形变不必比拉断距离更长：再长接收端也会夹到求解器的可见量程里，
    // 过网络的却是个越界的数。
    const pullLength = Math.hypot(pullX, pullY, pullZ);
    const limit = this.breakDistance;
    const scale = pullLength > limit && pullLength > 1e-6 ? limit / pullLength : 1;
    this.pullX = pullX * scale;
    this.pullY = pullY * scale;
    this.pullZ = pullZ * scale;

    const separationX = this.anchorX - this.#poseOrigin.x;
    const separationY = finiteOr(sourcePosition.y) - this.#poseOrigin.y;
    const separationZ = this.anchorZ - this.#poseOrigin.z;
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

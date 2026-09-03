import * as THREE from 'three';
import type { LeggedSlimeRenderDefinition } from '../../models/actors/createLeggedSlimeModel';
import type { SlimeLegVisualRig } from '../../models/actors/ActorVisualModel';
import type { RenderTransform } from '../RenderTransformBuffer';
import { leggedSlimeBodyCenterY } from '../../../shared/actor/leggedSlimeShape.mjs';
import { sampleSlimeGroundProbe, type SlimeGroundProbeParams } from '../RenderSlimeLegs';
import type { SlimeMotionParams } from '../RenderSlimeMotion';

/** 迈步时把落脚点往速度方向提前放多少：走得越快，步子跨得越靠前。 */
const STRIDE_LEAD_SECONDS = 0.55;
/** 身体跟随落脚点高度的响应速度，1/s。太快会让身体在碎石地上抖。 */
const BODY_FOLLOW_RESPONSE = 9;
/** 离地时脚收起来的长度，占总腿长的比例。比站姿短，看上去是把腿收了起来。 */
const AIRBORNE_DANGLE_RATIO = 0.72;
/** 两节骨头共线时 IK 的分母会炸，留一点余量让膝盖永远有个弯。 */
const IK_REACH_SAFETY = 0.998;
/** 拉到总腿长的这个比例就必须迈步，早于 IK 开始收脚的那一刻。 */
const OVERSTRETCH_RATIO = 0.94;
const UP = new THREE.Vector3(0, 1, 0);
const RING_AXIS = new THREE.Vector3(0, 0, 1);

interface LegGaitState {
  /** 落脚点的**世界**坐标。世界而不是局部：身体每帧都在动，踩住的地面不动。 */
  footX: number;
  footY: number;
  footZ: number;
  /** 这只脚接触地面的高度。抬腿时它留在地上，影子画在这里。 */
  contactY: number;
  stepping: boolean;
  stepProgress: number;
  stepFromX: number;
  stepFromY: number;
  stepFromZ: number;
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * 骨骼腿的步态与两节 IK，住在渲染世界里。
 *
 * **它解决的问题**：草图里那三层——身体、骨骼、地面采样点——只有中间那层是纯
 * 表现。地面采样是玩法侧的地形查询（`LegGroundProbeComponent` 每帧采五个点写进
 * 参数段），身体是 `line-art-player-slime` 那套软体，而「脚该落在哪里、什么时候
 * 抬起来」既不是权威状态也不影响任何玩法：它是一段看着走路的动画，所以整段解算
 * 都在这里，玩法侧一个字节都不知道。
 *
 * **落脚点存世界坐标**。存局部坐标的话，身体每移动一帧都要把每只踩住的脚反向
 * 平移回去——那正是「脚在地上打滑」这类 bug 的来源。世界坐标只在画之前换算一次。
 *
 * 每帧的工作量与腿数成正比、与世界尺寸无关；`sampleSlimeGroundProbe` 把窗口外的
 * 偏移夹回边界，所以远离采样窗口的地方不会被外推出一个凭空的高度。
 */
export class ThreeSlimeLegVisual {
  private readonly legs: LegGaitState[];
  private readonly totalLegLength: number;
  private readonly overstretchedLegLength: number;
  private readonly maximumConcurrentSteps: number;
  /** 身体相对髋高的上下浮动，跟着落脚点的平均高度走。 */
  private bodyLift = 0;
  private hasPose = false;
  // 逐帧复用，避免每条腿每帧分配四个向量。
  private readonly hip = new THREE.Vector3();
  private readonly footLocal = new THREE.Vector3();
  private readonly knee = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly segment = new THREE.Vector3();

  public constructor(
    private readonly rig: SlimeLegVisualRig,
    private readonly definition: LeggedSlimeRenderDefinition,
  ) {
    this.legs = rig.legs.map(() => ({
      footX: 0,
      footY: 0,
      footZ: 0,
      contactY: 0,
      stepping: false,
      stepProgress: 0,
      stepFromX: 0,
      stepFromY: 0,
      stepFromZ: 0,
    }));
    this.totalLegLength = definition.thighLength + definition.shinLength;
    this.overstretchedLegLength = this.totalLegLength * OVERSTRETCH_RATIO;
    // 双足时永远只有一只脚离地，多足时最多抬一半——剩下的一半撑住身体。
    this.maximumConcurrentSteps = Math.max(1, Math.floor(rig.legs.length / 2));
  }

  public update(
    deltaSeconds: number,
    world: RenderTransform,
    motion: SlimeMotionParams,
    probe: SlimeGroundProbeParams,
  ): void {
    // 参数段是 f32，正常路径下永远有限；NaN 会一次性污染所有落脚点，之后每帧
    // 都是 NaN，所以这一帧直接不驱动。
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y) || !Number.isFinite(world.z)) return;
    if (!Number.isFinite(world.yaw)) return;
    const frameSeconds = clamp(deltaSeconds, 0, 0.1);
    const sinYaw = Math.sin(world.yaw);
    const cosYaw = Math.cos(world.yaw);
    const airborne = motion.airborne !== 0;

    if (!this.hasPose) {
      this.resetPose(world, sinYaw, cosYaw, probe);
      this.hasPose = true;
    }

    this.updateBodyLift(frameSeconds, world, airborne);
    const hipY = world.y + this.definition.hipHeight + this.bodyLift;
    this.advanceSteps(frameSeconds, world, sinYaw, cosYaw, motion, probe, hipY, airborne);
    this.applyPose(world, sinYaw, cosYaw, hipY);
  }

  /** 首帧把脚直接摆到理想位置，否则整套腿会从世界原点飞过来。 */
  private resetPose(
    world: RenderTransform,
    sinYaw: number,
    cosYaw: number,
    probe: SlimeGroundProbeParams,
  ): void {
    for (const [index, leg] of this.rig.legs.entries()) {
      const state = this.legs[index];
      // 沿朝向按相位岔开一点，两条腿才不会从第一帧起就同手同脚。
      const phaseOffset = (leg.phase - 0.5) * this.definition.stepLength;
      const localX = leg.hipLocalX;
      const localZ = leg.hipLocalZ + phaseOffset;
      state.footX = world.x + cosYaw * localX + sinYaw * localZ;
      state.footZ = world.z - sinYaw * localX + cosYaw * localZ;
      state.contactY = this.groundAt(world, probe, state.footX, state.footZ);
      state.footY = state.contactY;
      state.stepping = false;
      state.stepProgress = 0;
    }
    this.bodyLift = 0;
  }

  /**
   * 身体跟着落脚点的平均高度浮动，指数逼近而不是直接赋值——碎石地上每帧跳动的
   * 采样值会让身体抖成一团。
   *
   * **悬空时目标固定为 0**。空中脚是垂在髋点下方的，而髋点又由身体高度决定：
   * 再让身体去追这些脚就成了一条正反馈，身体每帧往下掉一截，直到撞上夹取边界。
   */
  private updateBodyLift(
    frameSeconds: number,
    world: RenderTransform,
    airborne: boolean,
  ): void {
    let total = 0;
    for (const state of this.legs) total += state.contactY;
    const target = airborne ? 0 : clamp(
      total / this.legs.length - world.y,
      -this.definition.hipHeight * 0.5,
      this.definition.hipHeight * 0.5,
    );
    const response = 1 - Math.exp(-BODY_FOLLOW_RESPONSE * frameSeconds);
    this.bodyLift += (target - this.bodyLift) * response;
  }

  /** 先推进正在迈的腿，再决定这一帧还能让谁起步。 */
  private advanceSteps(
    frameSeconds: number,
    world: RenderTransform,
    sinYaw: number,
    cosYaw: number,
    motion: SlimeMotionParams,
    probe: SlimeGroundProbeParams,
    hipY: number,
    airborne: boolean,
  ): void {
    const { stepDuration, stepHeight, stepLength } = this.definition;
    // 离地时没有地面可踩：脚垂在髋点下方，谁也不迈步。
    const dangleY = hipY - this.totalLegLength * AIRBORNE_DANGLE_RATIO;

    let steppingCount = 0;
    for (const [index, leg] of this.rig.legs.entries()) {
      const state = this.legs[index];
      const hipX = world.x + cosYaw * leg.hipLocalX + sinYaw * leg.hipLocalZ;
      const hipZ = world.z - sinYaw * leg.hipLocalX + cosYaw * leg.hipLocalZ;

      if (airborne) {
        // 悬空：脚朝髋点正下方收回，落地那一帧再由步态接管。
        const settle = 1 - Math.exp(-10 * frameSeconds);
        state.footX += (hipX - state.footX) * settle;
        state.footZ += (hipZ - state.footZ) * settle;
        state.footY += (dangleY - state.footY) * settle;
        state.contactY = state.footY;
        state.stepping = false;
        state.stepProgress = 0;
        continue;
      }

      let targetX = hipX + motion.movementVelocityX * STRIDE_LEAD_SECONDS * stepDuration;
      let targetZ = hipZ + motion.movementVelocityZ * STRIDE_LEAD_SECONDS * stepDuration;
      // 预判不能超过一步的长度，否则高速下落脚点会跑到腿够不着的前方。
      const leadX = targetX - hipX;
      const leadZ = targetZ - hipZ;
      const leadLength = Math.hypot(leadX, leadZ);
      if (leadLength > stepLength) {
        targetX = hipX + (leadX / leadLength) * stepLength;
        targetZ = hipZ + (leadZ / leadLength) * stepLength;
      }
      const targetY = this.groundAt(world, probe, targetX, targetZ);

      if (state.stepping) {
        state.stepProgress += frameSeconds / stepDuration;
        if (state.stepProgress >= 1) {
          state.stepping = false;
          state.stepProgress = 0;
          state.footX = targetX;
          state.footZ = targetZ;
          state.contactY = targetY;
          state.footY = targetY;
          continue;
        }
        steppingCount += 1;
        // 落点每帧重算：身体还在走，落脚点得跟着往前挪，否则脚会落在身后。
        const eased = smoothStep(state.stepProgress);
        state.footX = state.stepFromX + (targetX - state.stepFromX) * eased;
        state.footZ = state.stepFromZ + (targetZ - state.stepFromZ) * eased;
        state.contactY = state.stepFromY + (targetY - state.stepFromY) * eased;
        state.footY = state.contactY + Math.sin(Math.PI * state.stepProgress) * stepHeight;
        continue;
      }

      // 踩住的脚不动，但高度跟着采样窗口走：身体走过去时窗口对同一点的估计会
      // 变，脚不跟着走就会浮在地面上方或陷进去。
      state.contactY = this.groundAt(world, probe, state.footX, state.footZ);
      state.footY = state.contactY;
    }

    if (airborne) return;
    this.startSteps(world, sinYaw, cosYaw, motion, hipY, steppingCount);
  }

  /**
   * 谁离理想落点最远谁先迈。
   *
   * 每轮只挑一条腿，挑完再重算——腿数很少（2 到 6），一次线性扫描比排序便宜，
   * 也不需要分配临时数组。
   */
  private startSteps(
    world: RenderTransform,
    sinYaw: number,
    cosYaw: number,
    motion: SlimeMotionParams,
    hipY: number,
    activeSteps: number,
  ): void {
    const { stepLength, stepDuration } = this.definition;
    let stepping = activeSteps;

    // 已经拉到腿长极限的先迈，而且**不受同时迈步数的限制**。
    //
    // 等下去的代价不是难看一点：IK 会把够不到的落脚点收回可达距离，画面上就是
    // 那只脚离地飘着被拖走。宁可两只脚同时离地一瞬，也不要一只脚穿地拖行。
    for (const [index, leg] of this.rig.legs.entries()) {
      const state = this.legs[index];
      if (state.stepping) continue;
      const hipX = world.x + cosYaw * leg.hipLocalX + sinYaw * leg.hipLocalZ;
      const hipZ = world.z - sinYaw * leg.hipLocalX + cosYaw * leg.hipLocalZ;
      const stretch = Math.hypot(state.footX - hipX, state.footY - hipY, state.footZ - hipZ);
      if (stretch < this.overstretchedLegLength) continue;
      this.beginStep(state);
      stepping += 1;
    }

    while (stepping < this.maximumConcurrentSteps) {
      let bestIndex = -1;
      let bestError = stepLength;
      for (const [index, leg] of this.rig.legs.entries()) {
        const state = this.legs[index];
        if (state.stepping) continue;
        const hipX = world.x + cosYaw * leg.hipLocalX + sinYaw * leg.hipLocalZ;
        const hipZ = world.z - sinYaw * leg.hipLocalX + cosYaw * leg.hipLocalZ;
        const targetX = hipX + motion.movementVelocityX * STRIDE_LEAD_SECONDS * stepDuration;
        const targetZ = hipZ + motion.movementVelocityZ * STRIDE_LEAD_SECONDS * stepDuration;
        const error = Math.hypot(targetX - state.footX, targetZ - state.footZ);
        if (error <= bestError) continue;
        bestError = error;
        bestIndex = index;
      }
      if (bestIndex < 0) return;
      this.beginStep(this.legs[bestIndex]);
      stepping += 1;
    }
  }

  /** 从当前落脚点起步。落点不在这里定——它每帧重算，脚才不会落在身后。 */
  private beginStep(state: LegGaitState): void {
    state.stepping = true;
    state.stepProgress = 0;
    state.stepFromX = state.footX;
    state.stepFromY = state.contactY;
    state.stepFromZ = state.footZ;
  }

  /** 采样窗口给的是世界高度；没有窗口（radius 为 0）时退回 Actor 自己的脚底平面。 */
  private groundAt(
    world: RenderTransform,
    probe: SlimeGroundProbeParams,
    x: number,
    z: number,
  ): number {
    if (!(probe.radius > 0)) return world.y;
    return sampleSlimeGroundProbe(probe, x - world.x, z - world.z);
  }

  /** 把世界落脚点换算进 rig 的局部空间，解一次两节 IK，然后摆好五个节点。 */
  private applyPose(
    world: RenderTransform,
    sinYaw: number,
    cosYaw: number,
    hipY: number,
  ): void {
    this.rig.bodyRoot.position.y = leggedSlimeBodyCenterY(
      this.definition.hipHeight,
      this.definition.radius,
    ) + this.bodyLift;
    const { thighLength, shinLength, stepHeight } = this.definition;
    for (const [index, leg] of this.rig.legs.entries()) {
      const state = this.legs[index];
      this.hip.set(leg.hipLocalX, hipY - world.y, leg.hipLocalZ);
      const deltaX = state.footX - world.x;
      const deltaZ = state.footZ - world.z;
      this.footLocal.set(
        cosYaw * deltaX - sinYaw * deltaZ,
        state.footY - world.y,
        sinYaw * deltaX + cosYaw * deltaZ,
      );
      const contactLocalY = state.contactY - world.y;
      this.solveKnee(thighLength, shinLength);
      this.placeBone(leg.thigh, this.hip, this.knee);
      this.placeBone(leg.shin, this.knee, this.footLocal);

      // 膝环套在大腿上：环的轴对齐骨头方向，看上去就是箍在腿上的一圈。
      this.segment.subVectors(this.knee, this.hip);
      if (this.segment.lengthSq() > 1e-10) {
        this.segment.normalize();
        leg.knee.quaternion.setFromUnitVectors(RING_AXIS, this.segment);
      }
      leg.knee.position.copy(this.knee);
      leg.foot.position.copy(this.footLocal);

      // 影子留在接触点上，不跟着抬起来的脚走；抬得越高越淡越小。
      const lift = Math.max(0, this.footLocal.y - contactLocalY);
      const liftRatio = stepHeight > 0 ? clamp(lift / stepHeight, 0, 1) : 0;
      leg.shadow.position.set(this.footLocal.x, contactLocalY + 0.014, this.footLocal.z);
      const shadowScale = 1 - liftRatio * 0.45;
      leg.shadow.scale.set(shadowScale, shadowScale, 1);
      leg.shadow.material.setOpacity(0.3 * (1 - liftRatio * 0.7));
    }
  }

  /**
   * 两节 IK：膝盖落在以髋点和落脚点为焦点的那个圆上，往身体正前方弯。
   *
   * 够不到时把**落脚点自己**收回到可达距离，而不是把腿拉长——腿是两根定长骨头，
   * 拉长它等于把「有关节」这件事画没了。收回后脚环、影子和骨头仍然对得上。
   */
  private solveKnee(thighLength: number, shinLength: number): void {
    this.axis.subVectors(this.footLocal, this.hip);
    let distance = this.axis.length();
    const maximum = (thighLength + shinLength) * IK_REACH_SAFETY;
    const minimum = Math.abs(thighLength - shinLength) + 1e-4;
    if (distance < 1e-5) {
      // 脚和髋点重合：给一个朝下的方向，免得后面除以零。
      this.axis.set(0, -1, 0);
      distance = minimum;
    } else {
      this.axis.divideScalar(distance);
    }
    const clamped = clamp(distance, minimum, maximum);
    if (clamped !== distance) {
      this.footLocal.copy(this.axis).multiplyScalar(clamped).add(this.hip);
      distance = clamped;
    }

    const alongLeg = (
      thighLength * thighLength - shinLength * shinLength + distance * distance
    ) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, thighLength * thighLength - alongLeg * alongLeg));

    // 膝盖往身体正前方弯。rig 的局部空间里 +Z 就是朝向，所以极向量取 +Z 去掉
    // 沿腿的分量；腿正好水平朝前时退回 +Y，膝盖朝上弯。
    this.pole.set(0, 0, 1).addScaledVector(this.axis, -this.axis.z);
    if (this.pole.lengthSq() < 1e-8) this.pole.set(0, 1, 0).addScaledVector(this.axis, -this.axis.y);
    if (this.pole.lengthSq() < 1e-8) this.pole.set(1, 0, 0);
    this.pole.normalize();

    this.knee.copy(this.hip)
      .addScaledVector(this.axis, alongLeg)
      .addScaledVector(this.pole, bend);
  }

  /** 把一根「粗线」摆成从 from 指到 to：几何沿 +Y 长 1，所以缩放 Y 就是骨长。 */
  private placeBone(
    bone: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>,
    from: THREE.Vector3,
    to: THREE.Vector3,
  ): void {
    this.segment.subVectors(to, from);
    const length = this.segment.length();
    bone.position.copy(from);
    if (length < 1e-6) {
      bone.scale.set(1, 1e-6, 1);
      return;
    }
    this.segment.divideScalar(length);
    bone.quaternion.setFromUnitVectors(UP, this.segment);
    bone.scale.set(1, length, 1);
  }
}

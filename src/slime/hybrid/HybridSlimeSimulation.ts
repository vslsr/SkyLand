import {
  HYBRID_SLIME_CENTER_HEIGHT_RATIO,
  HYBRID_SLIME_PLANAR_RADIUS_RATIO,
  hybridSlimeFloorY,
  hybridSlimeRestY,
} from './HybridSlimeRestShape';
import { HybridSlimeVolumeFlow } from './HybridSlimeVolumeFlow';

export interface HybridSlimeSimulationOptions {
  readonly radius: number;
  readonly surfaceDirections: Float32Array;
  readonly surfaceNeighbors: readonly Uint16Array[];
  readonly coreStiffness: number;
  readonly skinStiffness: number;
  readonly skinDamping: number;
  readonly neighborStiffness: number;
}

export interface HybridSlimeSimulationStats {
  readonly vertexCount: number;
  readonly active: boolean;
  readonly maximumSkinError: number;
  readonly kineticEnergy: number;
  readonly airborneAmount: number;
  readonly shapeVerticalVelocity: number;
  readonly takeoffPulse: number;
  readonly surfaceDragActive: boolean;
  readonly surfaceDragExtensionRatio: number;
  readonly surfaceDragForceScale: number;
  /** 蒙皮相对静止体积的缺口比例；正数表示外壳里还有正在被填充的空隙。 */
  readonly surfaceVolumeError: number;
}

export interface HybridSlimeSurfaceDragOptions {
  readonly maximumDistance: number;
  readonly pullForce: number;
  readonly falloffExponent: number;
  readonly influenceRadius: number;
  /**
   * 这一次抓取有多「尖」。
   *
   * 0 是鼠标拖拽那一套：影响圈很大、整团都跟着走，手感像捏着一坨软泥挪。
   * 1 是被牙齿咬住：影响圈收窄、权重profile 变陡、质心完全不动，于是命中处
   * 拔出一个尖，而不是整只史莱姆鼓成一个圆包。
   *
   * 它是**每次抓取**的属性而不是原型参数：同一只史莱姆被鼠标拖和被咬，形状
   * 本来就该不一样。
   */
  readonly pinch?: number;
}

const FIXED_STEP_SECONDS = 1 / 120;
const MAX_FRAME_SECONDS = 0.1;
const MAX_BODY_LAG_RADIUS_RATIO = 0.22;
const BODY_LAG_SECONDS = 0.06;
const COLLISION_RESPONSE_SECONDS = 0.85;
const FULL_INWARD_FORCE_SPEED = 3.2;
const MAX_MOVEMENT_INWARD_RATIO = 0.12;
const MAX_MOVEMENT_FORCE_BIAS_RADIUS_RATIO = 0.16;
/** 约 0.27 秒到达目标的 90%，避免转向时内部核心瞬间跳到另一侧。 */
const FORCE_CENTER_FOLLOW_RATE = 8.5;
const MAX_TEARDROP_FRONT_STRETCH = 0.14;
const MAX_TEARDROP_REAR_CONTRACTION = 0.04;
const MAX_TEARDROP_TIP_NARROWING = 0.18;
const AIRBORNE_FOLLOW_RATE = 14;
/** 跳跃形变比物理速度多保留一拍，模拟黏性质量追不上 Actor 根的惯性。 */
const AIRBORNE_VERTICAL_SHAPE_FOLLOW_RATE = 5.5;
const GROUNDED_VERTICAL_SHAPE_FOLLOW_RATE = 16;
const TAKEOFF_PULSE_DECAY_PER_SECOND = 2.2;
const TAKEOFF_DIRECT_SKIN_FOLLOW_RATE = 24;
const TAKEOFF_INITIAL_AIRBORNE_AMOUNT = 0.72;
const AIRBORNE_PLANAR_CONTRACTION = 0.18;
const AIRBORNE_REST_VERTICAL_RADIUS_RATIO = 0.58;
const MAX_VERTICAL_BODY_LAG_RADIUS_RATIO = 0.22;
const MAX_AIRBORNE_FORCE_BIAS_RADIUS_RATIO = 0.18;
const MAX_AIRBORNE_TAIL_STRETCH = 0.72;
const MAX_AIRBORNE_HEAD_STRETCH = 0.18;
const MAX_AIRBORNE_TAIL_NARROWING = 0.76;
const MAX_AIRBORNE_HEAD_BULGE = 0.26;
const MAX_TAKEOFF_SAG_RADIUS_RATIO = 0.14;
const MAX_AIRBORNE_FLOOR_RELEASE_RATIO = 1.1;
const REFERENCE_JUMP_SPEED = 7;
/**
 * 拖拽权重的全局下限。命中邻域仍然最强，但影响圈之外的整层蒙皮也会一起跟随，
 * 于是鼠标拖的是「一整团软体」而不是只在表面鼓出一个孤立的包。
 */
const SURFACE_DRAG_BODY_FOLLOW_WEIGHT = 0.45;
/** 质心跟随拖拽位移的比例：静止形状本身会朝指针方向整体倾斜。 */
const SURFACE_DRAG_BODY_OFFSET_RATIO = 0.5;
/** 质心跟随的硬上限，按半径缩放，形变量不随世界尺度增长。 */
const MAX_SURFACE_DRAG_BODY_OFFSET_RADIUS_RATIO = 0.42;
/** 约 0.25 秒到达目标的 90%，让整团跟随有黏性延迟而不是硬跟指针。 */
const SURFACE_DRAG_BODY_FOLLOW_RATE = 14;
/** 底面被地面黏住，只保留一部分整体跟随，避免拖拽时整只史莱姆像刚体滑走。 */
const SURFACE_DRAG_BOTTOM_ADHESION = 0.45;
/** pinch = 1 时影响圈收掉这么多：尖是「只有命中点附近动」才尖。 */
const PINCH_INFLUENCE_NARROWING = 0.74;
/**
 * pinch = 1 时权重指数加到 1 + 这个值。
 *
 * 光把影响圈收窄只会得到一个小一号的圆包。真正让它变尖的是权重profile：指数
 * 越高，命中点与它周围几圈的落差越大，拔出来的就是锥而不是丘。
 */
const PINCH_WEIGHT_EXPONENT = 3;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampPlanarMagnitude(
  x: number,
  z: number,
  maximum: number,
): readonly [number, number] {
  const length = Math.hypot(x, z);
  if (length <= maximum || length <= 1e-8) return [x, z];
  const scale = maximum / length;
  return [x * scale, z * scale];
}

/**
 * 客户端混合软体：一个胡克弹簧驱动的球形核心，加一层逐顶点弹簧蒙皮。
 * 预算只与固定的外壳顶点/邻域数量相关，不随世界尺寸增长。
 */
export class HybridSlimeSimulation {
  public readonly positions: Float32Array;
  public readonly velocities: Float32Array;
  public readonly center: Float32Array;
  /** 蒙皮胡克弹簧的速度偏置吸引点，也是渲染球形核心的位置。 */
  public readonly forceCenter: Float32Array;
  public readonly coreScale = new Float32Array([1, 1, 1]);
  public readonly vertexCount: number;
  public coreYaw = 0;
  public isActive = false;

  private readonly anchors: Float32Array;
  private readonly accelerations: Float32Array;
  private readonly surfaceDragWeights: Float32Array;
  private readonly surfaceDragStartPositions: Float32Array;
  private readonly volumeFlow: HybridSlimeVolumeFlow;
  private readonly floorY: number;
  private readonly centerY: number;
  private readonly maximumBodyLag: number;
  private readonly maximumVerticalBodyLag: number;
  private targetCoreX = 0;
  private targetCoreY = 0;
  private targetCoreZ = 0;
  private coreX = 0;
  private coreY = 0;
  private coreZ = 0;
  private coreVelocityX = 0;
  private coreVelocityY = 0;
  private coreVelocityZ = 0;
  private targetForceCenterX = 0;
  private targetForceCenterY = 0;
  private targetForceCenterZ = 0;
  private driveVelocityX = 0;
  private driveVelocityZ = 0;
  private driveDirectionX = 0;
  private driveDirectionZ = 1;
  private driveSpeed = 0;
  private targetAirborneAmount = 0;
  private airborneAmount = 0;
  private verticalVelocity = 0;
  private shapeVerticalVelocity = 0;
  private takeoffPulse = 0;
  private deformationDirectionX = 0;
  private deformationDirectionZ = 1;
  private collisionCompression = 0;
  private collisionActiveSeconds = 0;
  private stableSeconds = 0;
  private maximumSkinError = 0;
  private kineticEnergy = 0;
  private surfaceDragActive = false;
  private surfaceDragVertexOffset = 0;
  private surfaceDragMaximumDistance = 0;
  private surfaceDragPullForce = 0;
  private surfaceDragFalloffExponent = 1;
  private surfaceDragPullX = 0;
  private surfaceDragPullY = 0;
  private surfaceDragPullZ = 0;
  private surfaceDragExtensionRatio = 0;
  private surfaceDragForceScale = 0;
  private surfaceDragPinch = 0;
  private surfaceDragBodyX = 0;
  private surfaceDragBodyY = 0;
  private surfaceDragBodyZ = 0;

  public constructor(private readonly options: HybridSlimeSimulationOptions) {
    this.vertexCount = options.surfaceDirections.length / 3;
    if (!Number.isInteger(this.vertexCount) || this.vertexCount <= 0) {
      throw new Error('混合史莱姆需要非空的三维蒙皮方向');
    }
    if (options.surfaceNeighbors.length !== this.vertexCount) {
      throw new Error('混合史莱姆的蒙皮邻域数量与顶点数量不一致');
    }
    this.positions = new Float32Array(options.surfaceDirections.length);
    this.velocities = new Float32Array(options.surfaceDirections.length);
    this.anchors = new Float32Array(options.surfaceDirections.length);
    this.accelerations = new Float32Array(options.surfaceDirections.length);
    this.surfaceDragWeights = new Float32Array(this.vertexCount);
    this.surfaceDragStartPositions = new Float32Array(options.surfaceDirections.length);
    this.centerY = options.radius * HYBRID_SLIME_CENTER_HEIGHT_RATIO;
    this.floorY = hybridSlimeFloorY(options.radius);
    this.maximumBodyLag = options.radius * MAX_BODY_LAG_RADIUS_RATIO;
    this.maximumVerticalBodyLag = options.radius * MAX_VERTICAL_BODY_LAG_RADIUS_RATIO;
    this.targetForceCenterY = this.centerY;
    this.center = new Float32Array([0, this.centerY, 0]);
    this.forceCenter = new Float32Array([0, this.centerY, 0]);
    this.volumeFlow = new HybridSlimeVolumeFlow(options.surfaceDirections, {
      radius: options.radius,
      floorY: this.floorY,
    });
    this.rebuildAnchors(0);
    this.positions.set(this.anchors);
  }

  /**
   * 锁定命中点附近的一块蒙皮。权重只在按下时计算一次，拖动期间不会因顶点移动而跳点。
   */
  public beginSurfaceDrag(
    contactX: number,
    contactY: number,
    contactZ: number,
    options: HybridSlimeSurfaceDragOptions,
  ): boolean {
    if (![contactX, contactY, contactZ].every(Number.isFinite)) return false;
    if (
      !Number.isFinite(options.maximumDistance)
      || !Number.isFinite(options.pullForce)
      || !Number.isFinite(options.falloffExponent)
      || !Number.isFinite(options.influenceRadius)
      || options.maximumDistance <= 0
      || options.pullForce <= 0
      || options.falloffExponent < 1
      || options.influenceRadius <= 0
    ) return false;

    let nearestOffset = 0;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < this.positions.length; offset += 3) {
      const deltaX = this.positions[offset] - contactX;
      const deltaY = this.positions[offset + 1] - contactY;
      const deltaZ = this.positions[offset + 2] - contactZ;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      if (distanceSquared >= nearestDistanceSquared) continue;
      nearestDistanceSquared = distanceSquared;
      nearestOffset = offset;
    }

    const pinch = clamp(options.pinch ?? 0, 0, 1);
    const influenceRadius = options.influenceRadius * (1 - PINCH_INFLUENCE_NARROWING * pinch);
    const weightExponent = 1 + PINCH_WEIGHT_EXPONENT * pinch;
    this.surfaceDragPinch = pinch;
    this.surfaceDragStartPositions.set(this.positions);
    this.surfaceDragVertexOffset = nearestOffset;
    this.surfaceDragMaximumDistance = options.maximumDistance;
    this.surfaceDragPullForce = options.pullForce;
    this.surfaceDragFalloffExponent = options.falloffExponent;
    this.surfaceDragPullX = 0;
    this.surfaceDragPullY = 0;
    this.surfaceDragPullZ = 0;
    this.surfaceDragExtensionRatio = 0;
    this.surfaceDragForceScale = 1;
    const centerX = this.positions[nearestOffset];
    const centerY = this.positions[nearestOffset + 1];
    const centerZ = this.positions[nearestOffset + 2];
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const distance = Math.hypot(
        this.positions[offset] - centerX,
        this.positions[offset + 1] - centerY,
        this.positions[offset + 2] - centerZ,
      );
      const linearWeight = clamp(1 - distance / influenceRadius, 0, 1);
      // smoothstep 避免影响圈边缘出现折线，同时保持命中顶点权重为 1。
      // 再按 pinch 抬指数：咬住时落差更陡，命中处因此收成一个尖。
      const smoothWeight = linearWeight * linearWeight * (3 - 2 * linearWeight);
      const localWeight = pinch > 0 ? Math.pow(smoothWeight, weightExponent) : smoothWeight;
      // 底部离地越近跟随越弱，模拟黏地；其余顶点都保留全局下限，
      // 因此影响圈之外的背面同样会被带动，只是幅度小于命中邻域。
      const groundAdhesion = clamp(
        (this.positions[offset + 1] - this.floorY) / Math.max(1e-6, this.options.radius * 0.55),
        0,
        1,
      );
      // 咬住时整团不跟随：跟随权重就是那个把尖抹成圆包的东西。
      const bodyWeight = SURFACE_DRAG_BODY_FOLLOW_WEIGHT * (1 - pinch) * (
        SURFACE_DRAG_BOTTOM_ADHESION + (1 - SURFACE_DRAG_BOTTOM_ADHESION) * groundAdhesion
      );
      this.surfaceDragWeights[vertex] = bodyWeight + (1 - bodyWeight) * localWeight;
    }
    this.surfaceDragActive = true;
    this.isActive = true;
    this.stableSeconds = 0;
    return true;
  }

  /** 目标位移首先被硬截断；求解器随后再按当前伸长比例衰减实际拉力。 */
  public setSurfaceDragPull(pullX: number, pullY: number, pullZ: number): void {
    if (!this.surfaceDragActive || ![pullX, pullY, pullZ].every(Number.isFinite)) return;
    const length = Math.hypot(pullX, pullY, pullZ);
    const scale = length > this.surfaceDragMaximumDistance && length > 1e-8
      ? this.surfaceDragMaximumDistance / length
      : 1;
    this.surfaceDragPullX = pullX * scale;
    this.surfaceDragPullY = pullY * scale;
    this.surfaceDragPullZ = pullZ * scale;
    this.isActive = true;
    this.stableSeconds = 0;
  }

  public endSurfaceDrag(): void {
    if (!this.surfaceDragActive) return;
    this.surfaceDragActive = false;
    this.surfaceDragPullX = 0;
    this.surfaceDragPullY = 0;
    this.surfaceDragPullZ = 0;
    this.surfaceDragExtensionRatio = 0;
    this.surfaceDragForceScale = 0;
    this.surfaceDragPinch = 0;
    this.surfaceDragWeights.fill(0);
    // 继续唤醒一段时间，让现有胡克蒙皮把拉出的表面平滑带回锚点。
    this.isActive = true;
    this.stableSeconds = 0;
  }

  public setDriveVelocity(velocityX: number, velocityZ: number): void {
    const safeX = Number.isFinite(velocityX) ? velocityX : 0;
    const safeZ = Number.isFinite(velocityZ) ? velocityZ : 0;
    this.driveVelocityX = safeX;
    this.driveVelocityZ = safeZ;
    const [targetX, targetZ] = clampPlanarMagnitude(
      -safeX * BODY_LAG_SECONDS,
      -safeZ * BODY_LAG_SECONDS,
      this.maximumBodyLag,
    );
    const targetChanged = Math.hypot(
      targetX - this.targetCoreX,
      targetZ - this.targetCoreZ,
    ) > this.options.radius * 1e-5;
    this.targetCoreX = targetX;
    this.targetCoreZ = targetZ;
    this.driveSpeed = Math.hypot(safeX, safeZ);
    if (this.driveSpeed > 1e-5) {
      this.driveDirectionX = safeX / this.driveSpeed;
      this.driveDirectionZ = safeZ / this.driveSpeed;
      if (this.collisionActiveSeconds <= 0) {
        this.deformationDirectionX = this.driveDirectionX;
        this.deformationDirectionZ = this.driveDirectionZ;
      }
    }
    if (targetChanged) {
      this.isActive = true;
      this.stableSeconds = 0;
    }
  }

  /**
   * 竖直速度驱动质量核心的反向惯性：起跳时核心先向下滞后，下落时反向。
   * 蒙皮同时用水平速度与竖直速度的三维合成轴形成水滴，且只影响客户端表现。
   */
  public setAirborneMotion(verticalVelocity: number, grounded: boolean): void {
    const nextAirborne = grounded ? 0 : 1;
    const nextVelocity = Number.isFinite(verticalVelocity) ? verticalVelocity : 0;
    const justTookOff = nextAirborne > 0 && this.targetAirborneAmount <= 0;
    const nextTargetCoreY = nextAirborne > 0
      ? clamp(
        -nextVelocity * BODY_LAG_SECONDS,
        -this.maximumVerticalBodyLag,
        this.maximumVerticalBodyLag,
      )
      : 0;
    const changed = nextAirborne !== this.targetAirborneAmount
      || Math.abs(nextVelocity - this.verticalVelocity) > 0.02
      || Math.abs(nextTargetCoreY - this.targetCoreY) > this.options.radius * 1e-5;
    this.targetAirborneAmount = nextAirborne;
    this.verticalVelocity = nextVelocity;
    // 起跳冲量不能等弹簧低通后才进入外壳，否则约 0.3 秒的上升阶段会被完全吃掉。
    if (justTookOff) {
      this.shapeVerticalVelocity = Math.max(0, nextVelocity);
      this.takeoffPulse = 1;
      // 参考实现按下跳跃时直接向 squash 弹簧注入速度；这里同样不能从 0 慢慢淡入，
      // 否则第一个明显轮廓会拖到最高点以后。
      this.airborneAmount = Math.max(
        this.airborneAmount,
        TAKEOFF_INITIAL_AIRBORNE_AMOUNT,
      );
    }
    this.targetCoreY = nextTargetCoreY;
    if (changed) {
      this.isActive = true;
      this.stableSeconds = 0;
    }
  }

  /**
   * collisionDisplacement 指向角色本帧试图进入的障碍方向。只压入该侧蒙皮，
   * 而不是给整团顶点同一个速度，从而产生局部环境接触凹陷。
   */
  public applyCollision(
    collisionDisplacementX: number,
    collisionDisplacementZ: number,
    deltaSeconds: number,
  ): void {
    if (!Number.isFinite(collisionDisplacementX) || !Number.isFinite(collisionDisplacementZ)) {
      return;
    }
    const displacementLength = Math.hypot(collisionDisplacementX, collisionDisplacementZ);
    if (displacementLength <= 1e-6) return;
    const normalX = collisionDisplacementX / displacementLength;
    const normalZ = collisionDisplacementZ / displacementLength;
    const collisionSpeed = displacementLength / Math.max(1 / 120, deltaSeconds);
    // 外壳半径大于内部圆柱约 0.27r；第一次核心接触必须能吸收大部分间隙，
    // 否则虽然玩法碰撞正确，画面仍会像硬壳插进障碍。
    const dentDepth = this.options.radius * (
      0.13 + Math.min(0.22, collisionSpeed * 0.065)
    );
    const directions = this.options.surfaceDirections;
    for (let offset = 0; offset < directions.length; offset += 3) {
      const alignment = directions[offset] * normalX + directions[offset + 2] * normalZ;
      if (alignment <= 0.04) continue;
      const normalizedAlignment = clamp((alignment - 0.04) / 0.96, 0, 1);
      const height = clamp((directions[offset + 1] + 1) * 0.5, 0, 1);
      const contactWeight = normalizedAlignment * normalizedAlignment * (0.7 + height * 0.3);
      const indentation = dentDepth * contactWeight;
      this.positions[offset] -= normalX * indentation;
      this.positions[offset + 1] += indentation * 0.16;
      this.positions[offset + 2] -= normalZ * indentation;
      this.velocities[offset] -= normalX * collisionSpeed * contactWeight * 0.1;
      this.velocities[offset + 1] += collisionSpeed * contactWeight * 0.025;
      this.velocities[offset + 2] -= normalZ * collisionSpeed * contactWeight * 0.1;
    }
    this.deformationDirectionX = normalX;
    this.deformationDirectionZ = normalZ;
    this.collisionCompression = Math.min(
      1,
      this.collisionCompression + 0.35 + collisionSpeed * 0.12,
    );
    this.collisionActiveSeconds = COLLISION_RESPONSE_SECONDS;
    this.isActive = true;
    this.stableSeconds = 0;
  }

  /** 返回本帧蒙皮是否发生变化，调用方据此限制法线重建成本。 */
  public update(deltaSeconds: number): boolean {
    const frameSeconds = clamp(deltaSeconds, 0, MAX_FRAME_SECONDS);
    if (frameSeconds <= 0 || !this.isActive) return false;
    const stepCount = Math.max(1, Math.ceil(frameSeconds / FIXED_STEP_SECONDS));
    const stepSeconds = frameSeconds / stepCount;
    for (let step = 0; step < stepCount; step += 1) {
      this.step(stepSeconds);
    }
    this.collisionActiveSeconds = Math.max(0, this.collisionActiveSeconds - frameSeconds);
    this.collisionCompression *= Math.exp(-5.2 * frameSeconds);
    this.evaluateSleep(frameSeconds);
    return true;
  }

  public sleep(): void {
    this.velocities.fill(0);
    this.volumeFlow.reset();
    this.coreVelocityX = 0;
    this.coreVelocityY = 0;
    this.coreVelocityZ = 0;
    this.stableSeconds = 0;
    this.isActive = false;
  }

  public stats(): HybridSlimeSimulationStats {
    return {
      vertexCount: this.vertexCount,
      active: this.isActive,
      maximumSkinError: this.maximumSkinError,
      kineticEnergy: this.kineticEnergy,
      airborneAmount: this.airborneAmount,
      shapeVerticalVelocity: this.shapeVerticalVelocity,
      takeoffPulse: this.takeoffPulse,
      surfaceDragActive: this.surfaceDragActive,
      surfaceDragExtensionRatio: this.surfaceDragExtensionRatio,
      surfaceDragForceScale: this.surfaceDragForceScale,
      surfaceVolumeError: this.volumeFlow.lastVolumeError,
    };
  }

  private step(deltaSeconds: number): void {
    const airborneFollow = 1 - Math.exp(-AIRBORNE_FOLLOW_RATE * deltaSeconds);
    this.airborneAmount += (
      this.targetAirborneAmount - this.airborneAmount
    ) * airborneFollow;
    const verticalShapeFollowRate = this.targetAirborneAmount > 0
      ? AIRBORNE_VERTICAL_SHAPE_FOLLOW_RATE
      : GROUNDED_VERTICAL_SHAPE_FOLLOW_RATE;
    const verticalShapeFollow = 1 - Math.exp(-verticalShapeFollowRate * deltaSeconds);
    this.shapeVerticalVelocity += (
      this.verticalVelocity - this.shapeVerticalVelocity
    ) * verticalShapeFollow;
    const takeoffPulseDecay = this.targetAirborneAmount > 0
      ? TAKEOFF_PULSE_DECAY_PER_SECOND
      : TAKEOFF_PULSE_DECAY_PER_SECOND * 2.5;
    this.takeoffPulse = Math.max(0, this.takeoffPulse - takeoffPulseDecay * deltaSeconds);
    const coreDamping = 2 * Math.sqrt(this.options.coreStiffness) * 0.96;
    this.coreVelocityX += (
      this.targetCoreX - this.coreX
    ) * this.options.coreStiffness * deltaSeconds;
    this.coreVelocityY += (
      this.targetCoreY - this.coreY
    ) * this.options.coreStiffness * deltaSeconds;
    this.coreVelocityZ += (
      this.targetCoreZ - this.coreZ
    ) * this.options.coreStiffness * deltaSeconds;
    const coreDampingMultiplier = Math.exp(-coreDamping * deltaSeconds);
    this.coreVelocityX *= coreDampingMultiplier;
    this.coreVelocityY *= coreDampingMultiplier;
    this.coreVelocityZ *= coreDampingMultiplier;
    this.coreX += this.coreVelocityX * deltaSeconds;
    this.coreY += this.coreVelocityY * deltaSeconds;
    this.coreZ += this.coreVelocityZ * deltaSeconds;
    this.center[0] = this.coreX;
    this.center[1] = this.centerY + this.coreY;
    this.center[2] = this.coreZ;

    this.updateSurfaceDragBody(deltaSeconds);
    this.rebuildAnchors(deltaSeconds);
    // 局部弹簧只知道自己的锚点。空隙、凹陷和被拉出的凸起都是全局的体积变化，
    // 必须先把材料重新分配到锚点上，蒙皮才会像流体一样下坠填充而不是各自回弹。
    this.volumeFlow.apply(this.anchors, this.positions, this.center, deltaSeconds);
    if (this.takeoffPulse > 0) {
      // 起跳脉冲只短暂加速蒙皮追赶，不修改权威根节点，也不长期提高弹簧刚度。
      const directFollow = 1 - Math.exp(
        -TAKEOFF_DIRECT_SKIN_FOLLOW_RATE * this.takeoffPulse * deltaSeconds,
      );
      for (let offset = 0; offset < this.positions.length; offset += 1) {
        this.positions[offset] += (this.anchors[offset] - this.positions[offset]) * directFollow;
      }
    }
    const dampingMultiplier = Math.exp(-this.options.skinDamping * deltaSeconds);
    const positions = this.positions;
    const velocities = this.velocities;
    const accelerations = this.accelerations;
    const anchors = this.anchors;
    let maximumError = 0;
    let energy = 0;

    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const displacementX = positions[offset] - anchors[offset];
      const displacementY = positions[offset + 1] - anchors[offset + 1];
      const displacementZ = positions[offset + 2] - anchors[offset + 2];
      let neighborDisplacementX = 0;
      let neighborDisplacementY = 0;
      let neighborDisplacementZ = 0;
      const neighbors = this.options.surfaceNeighbors[vertex];
      for (let index = 0; index < neighbors.length; index += 1) {
        const neighborOffset = neighbors[index] * 3;
        neighborDisplacementX += positions[neighborOffset] - anchors[neighborOffset];
        neighborDisplacementY += positions[neighborOffset + 1] - anchors[neighborOffset + 1];
        neighborDisplacementZ += positions[neighborOffset + 2] - anchors[neighborOffset + 2];
      }
      const inverseNeighborCount = neighbors.length > 0 ? 1 / neighbors.length : 0;
      accelerations[offset] = (
        -displacementX * this.options.skinStiffness
        + (neighborDisplacementX * inverseNeighborCount - displacementX)
          * this.options.neighborStiffness
      );
      accelerations[offset + 1] = (
        -displacementY * this.options.skinStiffness
        + (neighborDisplacementY * inverseNeighborCount - displacementY)
          * this.options.neighborStiffness
      );
      accelerations[offset + 2] = (
        -displacementZ * this.options.skinStiffness
        + (neighborDisplacementZ * inverseNeighborCount - displacementZ)
          * this.options.neighborStiffness
      );
      maximumError = Math.max(
        maximumError,
        Math.hypot(displacementX, displacementY, displacementZ),
      );
    }

    this.applySurfaceDragAccelerations();

    for (let offset = 0; offset < positions.length; offset += 3) {
      velocities[offset] = (
        velocities[offset] + accelerations[offset] * deltaSeconds
      ) * dampingMultiplier;
      velocities[offset + 1] = (
        velocities[offset + 1] + accelerations[offset + 1] * deltaSeconds
      ) * dampingMultiplier;
      velocities[offset + 2] = (
        velocities[offset + 2] + accelerations[offset + 2] * deltaSeconds
      ) * dampingMultiplier;
      positions[offset] += velocities[offset] * deltaSeconds;
      positions[offset + 1] += velocities[offset + 1] * deltaSeconds;
      positions[offset + 2] += velocities[offset + 2] * deltaSeconds;

      const groundWeight = (1 - this.airborneAmount) * clamp(
        1 - (anchors[offset + 1] - this.floorY) / (this.options.radius * 0.2),
        0,
        1,
      );
      if (groundWeight > 0) {
        const groundDamping = Math.exp(-12 * groundWeight * deltaSeconds);
        velocities[offset] *= groundDamping;
        velocities[offset + 2] *= groundDamping;
      }
      // 地面约束随离地权重释放，允许底部在起跳时相对 Actor 根向下拖后，
      // 但仍以固定半径上限约束，成本和形变量都不会随世界尺度增长。
      const minimumSurfaceY = this.floorY
        - this.options.radius * MAX_AIRBORNE_FLOOR_RELEASE_RATIO * this.airborneAmount;
      if (positions[offset + 1] < minimumSurfaceY) {
        positions[offset + 1] = minimumSurfaceY;
        if (velocities[offset + 1] < 0) velocities[offset + 1] = 0;
      }
      energy += (
        velocities[offset] * velocities[offset]
        + velocities[offset + 1] * velocities[offset + 1]
        + velocities[offset + 2] * velocities[offset + 2]
      );
    }
    this.constrainSurfaceDrag();
    this.maximumSkinError = maximumError;
    this.kineticEnergy = energy / this.vertexCount;
  }

  /**
   * 拖拽不只推动命中处的蒙皮，还会把静止形状的质心朝指针方向平滑带走。
   * 锚点整体偏移之后，连没被直接施力的一侧也会跟着变形，而不是原地不动。
   */
  private updateSurfaceDragBody(deltaSeconds: number): void {
    let targetX = 0;
    let targetY = 0;
    let targetZ = 0;
    if (this.surfaceDragActive) {
      // 质心跟随同样按 pinch 让位：被咬住的是一块皮，不是整只史莱姆。
      const offsetRatio = SURFACE_DRAG_BODY_OFFSET_RATIO * (1 - this.surfaceDragPinch);
      targetX = this.surfaceDragPullX * offsetRatio;
      targetY = this.surfaceDragPullY * offsetRatio;
      targetZ = this.surfaceDragPullZ * offsetRatio;
      const maximumOffset = this.options.radius * MAX_SURFACE_DRAG_BODY_OFFSET_RADIUS_RATIO;
      const length = Math.hypot(targetX, targetY, targetZ);
      if (length > maximumOffset && length > 1e-8) {
        const scale = maximumOffset / length;
        targetX *= scale;
        targetY *= scale;
        targetZ *= scale;
      }
    }
    const followRatio = deltaSeconds > 0
      ? 1 - Math.exp(-SURFACE_DRAG_BODY_FOLLOW_RATE * deltaSeconds)
      : 1;
    this.surfaceDragBodyX += (targetX - this.surfaceDragBodyX) * followRatio;
    this.surfaceDragBodyY += (targetY - this.surfaceDragBodyY) * followRatio;
    this.surfaceDragBodyZ += (targetZ - this.surfaceDragBodyZ) * followRatio;
  }

  private applySurfaceDragAccelerations(): void {
    if (!this.surfaceDragActive) return;
    const pullLength = Math.hypot(
      this.surfaceDragPullX,
      this.surfaceDragPullY,
      this.surfaceDragPullZ,
    );
    if (pullLength <= 1e-8) {
      this.surfaceDragExtensionRatio = 0;
      this.surfaceDragForceScale = 1;
      return;
    }
    const directionX = this.surfaceDragPullX / pullLength;
    const directionY = this.surfaceDragPullY / pullLength;
    const directionZ = this.surfaceDragPullZ / pullLength;
    const selectedOffset = this.surfaceDragVertexOffset;
    const selectedExtension = Math.max(0,
      (this.positions[selectedOffset] - this.surfaceDragStartPositions[selectedOffset]) * directionX
      + (this.positions[selectedOffset + 1] - this.surfaceDragStartPositions[selectedOffset + 1])
        * directionY
      + (this.positions[selectedOffset + 2] - this.surfaceDragStartPositions[selectedOffset + 2])
        * directionZ,
    );
    this.surfaceDragExtensionRatio = clamp(
      selectedExtension / this.surfaceDragMaximumDistance,
      0,
      1,
    );
    this.surfaceDragForceScale = Math.pow(
      1 - this.surfaceDragExtensionRatio,
      this.surfaceDragFalloffExponent,
    );

    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const weight = this.surfaceDragWeights[vertex];
      if (weight <= 1e-5) continue;
      const offset = vertex * 3;
      const targetX = this.surfaceDragStartPositions[offset] + this.surfaceDragPullX * weight;
      const targetY = this.surfaceDragStartPositions[offset + 1] + this.surfaceDragPullY * weight;
      const targetZ = this.surfaceDragStartPositions[offset + 2] + this.surfaceDragPullZ * weight;
      const stiffness = this.surfaceDragPullForce * weight * this.surfaceDragForceScale;
      this.accelerations[offset] += (targetX - this.positions[offset]) * stiffness;
      this.accelerations[offset + 1] += (targetY - this.positions[offset + 1]) * stiffness;
      this.accelerations[offset + 2] += (targetZ - this.positions[offset + 2]) * stiffness;
    }
  }

  /**
   * 衰减控制手感，硬约束负责安全：即使低帧率或参数调得过强，选中的表面也不能无限延伸。
   */
  private constrainSurfaceDrag(): void {
    if (!this.surfaceDragActive) return;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const weight = this.surfaceDragWeights[vertex];
      if (weight <= 1e-5) continue;
      const offset = vertex * 3;
      const displacementX = this.positions[offset] - this.surfaceDragStartPositions[offset];
      const displacementY = this.positions[offset + 1] - this.surfaceDragStartPositions[offset + 1];
      const displacementZ = this.positions[offset + 2] - this.surfaceDragStartPositions[offset + 2];
      const displacementLength = Math.hypot(displacementX, displacementY, displacementZ);
      const maximumVertexExtension = this.surfaceDragMaximumDistance * Math.max(0.2, weight);
      if (displacementLength <= maximumVertexExtension || displacementLength <= 1e-8) continue;
      const directionX = displacementX / displacementLength;
      const directionY = displacementY / displacementLength;
      const directionZ = displacementZ / displacementLength;
      this.positions[offset] = (
        this.surfaceDragStartPositions[offset] + directionX * maximumVertexExtension
      );
      this.positions[offset + 1] = (
        this.surfaceDragStartPositions[offset + 1] + directionY * maximumVertexExtension
      );
      this.positions[offset + 2] = (
        this.surfaceDragStartPositions[offset + 2] + directionZ * maximumVertexExtension
      );
      const outwardVelocity = (
        this.velocities[offset] * directionX
        + this.velocities[offset + 1] * directionY
        + this.velocities[offset + 2] * directionZ
      );
      if (outwardVelocity <= 0) continue;
      this.velocities[offset] -= directionX * outwardVelocity;
      this.velocities[offset + 1] -= directionY * outwardVelocity;
      this.velocities[offset + 2] -= directionZ * outwardVelocity;
    }
  }

  private rebuildAnchors(deltaSeconds: number): void {
    const directions = this.options.surfaceDirections;
    const lagRatio = clamp(
      Math.hypot(this.coreX, this.coreZ) / Math.max(1e-6, this.maximumBodyLag),
      0,
      1,
    );
    let deformationX = this.deformationDirectionX;
    let deformationZ = this.deformationDirectionZ;
    const deformationLength = Math.hypot(deformationX, deformationZ);
    if (deformationLength <= 1e-6) {
      deformationX = 0;
      deformationZ = 1;
    } else {
      deformationX /= deformationLength;
      deformationZ /= deformationLength;
    }
    const parallelScale = clamp(
      1 + lagRatio * 0.065 - this.collisionCompression * 0.13,
      0.78,
      1.12,
    );
    const volumeScale = 1 / Math.sqrt(parallelScale);
    const movementStrength = clamp(this.driveSpeed / FULL_INWARD_FORCE_SPEED, 0, 1);
    const groundedMovementStrength = movementStrength * (1 - this.airborneAmount);
    const movementInwardRatio = movementStrength * MAX_MOVEMENT_INWARD_RATIO;
    const airborneInwardRatio = this.airborneAmount * AIRBORNE_PLANAR_CONTRACTION;
    const compositeSpeed = Math.hypot(
      this.driveVelocityX,
      this.shapeVerticalVelocity,
      this.driveVelocityZ,
    );
    const inverseCompositeSpeed = compositeSpeed > 1e-5 ? 1 / compositeSpeed : 0;
    // 水滴头朝运动方向，尖尾朝反方向；向心力使用 motionAxis，蒙皮使用 tailAxis。
    const motionAxisX = this.driveVelocityX * inverseCompositeSpeed;
    const motionAxisY = this.shapeVerticalVelocity * inverseCompositeSpeed;
    const motionAxisZ = this.driveVelocityZ * inverseCompositeSpeed;
    const tailAxisX = -motionAxisX;
    const tailAxisY = -motionAxisY;
    const tailAxisZ = -motionAxisZ;
    const airborneMotionStrength = this.airborneAmount * Math.max(
      clamp(compositeSpeed / REFERENCE_JUMP_SPEED, 0, 1),
      this.takeoffPulse * 0.95,
    );
    const groundedForceBias = (
      this.options.radius
      * MAX_MOVEMENT_FORCE_BIAS_RADIUS_RATIO
      * groundedMovementStrength
    );
    const airborneForceBias = (
      this.options.radius
      * MAX_AIRBORNE_FORCE_BIAS_RADIUS_RATIO
      * airborneMotionStrength
    );
    this.targetForceCenterX = this.coreX
      + this.driveDirectionX * groundedForceBias
      + motionAxisX * airborneForceBias
      + this.surfaceDragBodyX;
    this.targetForceCenterY = this.centerY + this.coreY
      + motionAxisY * airborneForceBias;
    this.targetForceCenterZ = this.coreZ
      + this.driveDirectionZ * groundedForceBias
      + motionAxisZ * airborneForceBias
      + this.surfaceDragBodyZ;
    if (deltaSeconds > 0) {
      const followRatio = 1 - Math.exp(-FORCE_CENTER_FOLLOW_RATE * deltaSeconds);
      this.forceCenter[0] += (this.targetForceCenterX - this.forceCenter[0]) * followRatio;
      this.forceCenter[1] += (this.targetForceCenterY - this.forceCenter[1]) * followRatio;
      this.forceCenter[2] += (this.targetForceCenterZ - this.forceCenter[2]) * followRatio;
    }
    // 移动时把蒙皮的胡克目标径向拉向核心；底部只收一半以保留黏地软边，
    // 中上层收得更多，并用很小的高度补偿避免视觉体积突然消失。
    const movementVerticalScale = 1 + movementInwardRatio * 0.3;
    this.coreYaw = Math.atan2(deformationX, deformationZ);
    const airbornePlanarScale = 1 - airborneInwardRatio * 0.65;
    this.coreScale[0] = volumeScale * airbornePlanarScale;
    this.coreScale[1] = volumeScale * (1 + this.airborneAmount * 0.04);
    this.coreScale[2] = parallelScale * airbornePlanarScale;
    // forceCenter 里已经含有拖拽整体偏移。运动前倾的偏置只允许上半球跟随，
    // 拖拽跟随却要作用在整团，所以先把拖拽分量剔除，再单独按纬度加权。
    const smoothedForceBiasX = this.forceCenter[0] - this.coreX - this.surfaceDragBodyX;
    const smoothedForceBiasZ = this.forceCenter[2] - this.coreZ - this.surfaceDragBodyZ;
    const ascentRatio = clamp(this.shapeVerticalVelocity / REFERENCE_JUMP_SPEED, 0, 1);

    for (let offset = 0; offset < directions.length; offset += 3) {
      const directionX = directions[offset];
      const directionY = directions[offset + 1];
      const directionZ = directions[offset + 2];
      const height = clamp(directionY, 0, 1);
      const inwardScale = (
        1
        - movementInwardRatio * (0.5 + height * 0.5)
        - airborneInwardRatio * (1.05 - height * 0.35)
      );
      const baseX = (
        directionX * this.options.radius * HYBRID_SLIME_PLANAR_RADIUS_RATIO * inwardScale
      );
      const baseZ = (
        directionZ * this.options.radius * HYBRID_SLIME_PLANAR_RADIUS_RATIO * inwardScale
      );
      const parallel = baseX * deformationX + baseZ * deformationZ;
      const perpendicularX = baseX - deformationX * parallel;
      const perpendicularZ = baseZ - deformationZ * parallel;
      let shapedX = deformationX * parallel * parallelScale + perpendicularX * volumeScale;
      let shapedZ = deformationZ * parallel * parallelScale + perpendicularZ * volumeScale;

      // 向前偏移的吸引点让前端更长、更窄；后部保持圆钝并继续黏地，
      // 只使用速度与球面方向，不注入噪声，所以水滴朝向稳定且可休眠。
      const horizontalLength = Math.hypot(directionX, directionZ);
      const movementAlignment = horizontalLength > 1e-5
        ? clamp(
          (directionX * this.driveDirectionX + directionZ * this.driveDirectionZ)
            / horizontalLength,
          -1,
          1,
        )
        : 0;
      const frontWeight = Math.max(0, movementAlignment);
      const rearWeight = Math.max(0, -movementAlignment);
      const driveParallel = shapedX * this.driveDirectionX + shapedZ * this.driveDirectionZ;
      const drivePerpendicularX = shapedX - this.driveDirectionX * driveParallel;
      const drivePerpendicularZ = shapedZ - this.driveDirectionZ * driveParallel;
      const teardropParallelScale = (
        1
        + groundedMovementStrength * MAX_TEARDROP_FRONT_STRETCH * frontWeight
        - groundedMovementStrength * MAX_TEARDROP_REAR_CONTRACTION * rearWeight
      );
      const teardropPerpendicularScale = (
        1
        - groundedMovementStrength
          * MAX_TEARDROP_TIP_NARROWING
          * frontWeight
          * frontWeight
      );
      shapedX = (
        this.driveDirectionX * driveParallel * teardropParallelScale
        + drivePerpendicularX * teardropPerpendicularScale
      );
      shapedZ = (
        this.driveDirectionZ * driveParallel * teardropParallelScale
        + drivePerpendicularZ * teardropPerpendicularScale
      );
      // 所有胡克目标都以 forceCenter 为向心力中心；底层再减去一部分前移量，
      // 并保留质量中心的黏性滞后，所以软边贴地而可见核心仍准确标示吸引点。
      const adhesionFactor = 0.35 + (1 - height) * 1.0;
      const forceBiasWeight = 0.2 + height * 0.8;
      const groundedAdhesion = 1 - this.airborneAmount;
      // 拖拽跟随按纬度加权：顶部几乎完全跟手，底面被地面黏住只跟一部分，
      // 于是整只史莱姆都会朝指针方向倾倒拉长，而不是只鼓出命中处一个包。
      const dragBodyWeight = (
        SURFACE_DRAG_BOTTOM_ADHESION
        + (1 - SURFACE_DRAG_BOTTOM_ADHESION) * clamp((directionY + 1) * 0.5, 0, 1)
      );
      const dragBodyFalloff = (1 - dragBodyWeight) * groundedAdhesion;
      const baseAnchorX = (
        this.forceCenter[0]
        + shapedX
        + this.coreX * (adhesionFactor - 1) * groundedAdhesion
        - smoothedForceBiasX * (1 - forceBiasWeight) * groundedAdhesion
        - this.surfaceDragBodyX * dragBodyFalloff
      );
      const groundedAnchorY = hybridSlimeRestY(
        this.options.radius,
        directionY,
        volumeScale * movementVerticalScale,
      );
      // 地面穹顶只用于 grounded。离地后混合到完整闭合椭球，让下半球各纬度拥有
      // 不同 Y，彻底移除史莱姆自身的平底，而不是把整层底点一起上下移动。
      const airborneAnchorY = this.centerY
        + directionY
          * this.options.radius
          * AIRBORNE_REST_VERTICAL_RADIUS_RATIO
          * volumeScale;
      const baseAnchorY = groundedAnchorY
        + (airborneAnchorY - groundedAnchorY) * this.airborneAmount
        + this.surfaceDragBodyY * dragBodyWeight;
      const baseAnchorZ = (
        this.forceCenter[2]
        + shapedZ
        + this.coreZ * (adhesionFactor - 1) * groundedAdhesion
        - smoothedForceBiasZ * (1 - forceBiasWeight) * groundedAdhesion
        - this.surfaceDragBodyZ * dragBodyFalloff
      );

      // 空中水滴头沿三维合成运动方向；反向 tailAxis 拉长并收尖。
      const localX = baseAnchorX - this.coreX;
      const localY = baseAnchorY - this.centerY;
      const localZ = baseAnchorZ - this.coreZ;
      // 权重必须来自未压扁的球面方向。若使用贴地穹顶的 localY，绝大多数上半球
      // 会被误判成“赤道”，结果只有纵向拉高而没有肉眼可见的水滴尖端。
      const tailAlignment = compositeSpeed > 1e-5
        ? clamp(
          directionX * tailAxisX
            + directionY * tailAxisY
            + directionZ * tailAxisZ,
          -1,
          1,
        )
        : 0;
      const tailWeight = Math.max(0, tailAlignment);
      const headWeight = Math.max(0, -tailAlignment);
      const tailParallel = (
        localX * tailAxisX
        + localY * tailAxisY
        + localZ * tailAxisZ
      );
      const tailPerpendicularX = localX - tailAxisX * tailParallel;
      const tailPerpendicularY = localY - tailAxisY * tailParallel;
      const tailPerpendicularZ = localZ - tailAxisZ * tailParallel;
      const airborneParallelScale = (
        1
        + airborneMotionStrength
          * MAX_AIRBORNE_TAIL_STRETCH
          * tailWeight
        + airborneMotionStrength
          * MAX_AIRBORNE_HEAD_STRETCH
          * headWeight
      );
      const airbornePerpendicularScale = (
        1
        - airborneMotionStrength
          * MAX_AIRBORNE_TAIL_NARROWING
          * tailWeight
          * tailWeight
        + airborneMotionStrength
          * MAX_AIRBORNE_HEAD_BULGE
          * headWeight
          * headWeight
      );
      const takeoffSag = (
        this.options.radius
        * MAX_TAKEOFF_SAG_RADIUS_RATIO
        * this.airborneAmount
        * ascentRatio
        * (0.35 + Math.pow(1 - height, 1.4) * 0.65)
      );
      this.anchors[offset] = this.coreX
        + tailAxisX * tailParallel * airborneParallelScale
        + tailPerpendicularX * airbornePerpendicularScale;
      this.anchors[offset + 1] = this.centerY + this.coreY
        + tailAxisY * tailParallel * airborneParallelScale
        + tailPerpendicularY * airbornePerpendicularScale
        - takeoffSag;
      this.anchors[offset + 2] = this.coreZ
        + tailAxisZ * tailParallel * airborneParallelScale
        + tailPerpendicularZ * airbornePerpendicularScale;
    }
  }

  private evaluateSleep(deltaSeconds: number): void {
    const coreError = Math.hypot(
      this.targetCoreX - this.coreX,
      this.targetCoreY - this.coreY,
      this.targetCoreZ - this.coreZ,
    );
    const coreSpeed = Math.hypot(
      this.coreVelocityX,
      this.coreVelocityY,
      this.coreVelocityZ,
    );
    const forceCenterError = Math.hypot(
      this.targetForceCenterX - this.forceCenter[0],
      this.targetForceCenterY - this.forceCenter[1],
      this.targetForceCenterZ - this.forceCenter[2],
    );
    const airborneError = Math.abs(this.targetAirborneAmount - this.airborneAmount);
    const verticalShapeError = Math.abs(
      this.verticalVelocity - this.shapeVerticalVelocity,
    );
    const surfaceDragBodyOffset = Math.hypot(
      this.surfaceDragBodyX,
      this.surfaceDragBodyY,
      this.surfaceDragBodyZ,
    );
    const stable = (
      this.collisionActiveSeconds <= 0
      && !this.surfaceDragActive
      && surfaceDragBodyOffset < this.options.radius * 0.002
      && this.maximumSkinError < this.options.radius * 0.0015
      && this.kineticEnergy < this.options.radius * this.options.radius * 0.000025
      && coreError < this.options.radius * 0.001
      && coreSpeed < this.options.radius * 0.004
      && forceCenterError < this.options.radius * 0.001
      && airborneError < 0.001
      && verticalShapeError < 0.002
    );
    this.stableSeconds = stable ? this.stableSeconds + deltaSeconds : 0;
    if (this.stableSeconds < 0.08) return;
    this.collisionCompression = 0;
    if (this.driveSpeed > 1e-5) {
      this.deformationDirectionX = this.driveDirectionX;
      this.deformationDirectionZ = this.driveDirectionZ;
    }
    this.forceCenter[0] = this.targetForceCenterX;
    this.forceCenter[1] = this.targetForceCenterY;
    this.forceCenter[2] = this.targetForceCenterZ;
    this.rebuildAnchors(0);
    this.positions.set(this.anchors);
    this.maximumSkinError = 0;
    this.kineticEnergy = 0;
    if (this.targetAirborneAmount <= 0) this.shapeVerticalVelocity = 0;
    this.sleep();
  }
}

import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { PbfSlimeRenderDefinition } from '../../models/actors/createPbfSlimeModel';
import type { PbfSlimeVisualRig } from '../../models/actors/ActorVisualModel';
import { PbfSlimeSimulation } from '../../slime/pbf/PbfSlimeSimulation';

export const PBF_SLIME_VISUAL_COMPONENT = 'pbf-slime-visual';
const SURFACE_UPDATE_SECONDS = 1 / 30;
const SURFACE_FOLLOW_RATE = 2.8;
const REFERENCE_FACE_TURN_RESPONSE = 5.27;
const INITIAL_SETTLE_SECONDS = 0;
const COLLISION_ADAPT_SECONDS = 0.85;
const COLLISION_CONTACT_GRACE_SECONDS = 0.1;
const COLLISION_VELOCITY_TRANSFER = 0.22;
const BODY_LAG_SECONDS = 0.07;
const BODY_LAG_FOLLOW_RATE = 3.4;
const MAX_BODY_LAG_RADIUS_RATIO = 0.26;

export interface PbfSlimeMotionPresentation {
  /** Actor 根节点上的权威/预测 yaw。外壳会抵消它，脸部再单独滞后追随。 */
  authorityYaw: number;
  movementSpeed: number;
  /** 可选的真实平面移动方向；缺省时按 authorityYaw 向前移动。 */
  movementVelocityX?: number;
  movementVelocityZ?: number;
  /** 控制器本帧被物理碰撞阻挡的位移；只有它会重新唤醒 PBF 结构。 */
  collisionDisplacementX?: number;
  collisionDisplacementZ?: number;
}

function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function lerpAngle(from: number, to: number, amount: number): number {
  return normalizeAngle(from + normalizeAngle(to - from) * amount);
}

function stableSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 客户端表现 Component：PBF 与外壳重建不会写回 Actor 的权威根 Transform。 */
export class PbfSlimeVisualComponent extends ActorComponent {
  public readonly simulation: PbfSlimeSimulation;
  private surfaceAccumulator = SURFACE_UPDATE_SECONDS;
  private simulationActiveSeconds = INITIAL_SETTLE_SECONDS;
  private collisionContactSeconds = 0;
  private fluidFacingYaw = 0;
  private bodyLagWorldX = 0;
  private bodyLagWorldZ = 0;
  private hasMotionPresentation = false;
  private readonly reconstructedParticles: Float32Array;
  private readonly targetSurfaceRadii: Float32Array;
  private readonly blurredSurfaceRadii: Float32Array;
  private readonly targetSurfacePositions: Float32Array;
  private readonly displayCenter = new Float32Array(3);

  public constructor(
    actorId: string,
    public readonly rig: PbfSlimeVisualRig,
    private readonly definition: PbfSlimeRenderDefinition,
  ) {
    super(PBF_SLIME_VISUAL_COMPONENT);
    this.simulation = new PbfSlimeSimulation({
      particleCount: definition.particleCount,
      radius: definition.radius,
      gravity: definition.gravity,
      centerForce: definition.centerForce,
      viscosity: definition.viscosity,
      constraintIterations: definition.constraintIterations,
      seed: stableSeed(actorId),
    });
    this.reconstructedParticles = new Float32Array(this.simulation.positions.length);
    const surfaceVertexCount = rig.surfaceDirections.length / 3;
    this.targetSurfaceRadii = new Float32Array(surfaceVertexCount);
    this.blurredSurfaceRadii = new Float32Array(surfaceVertexCount);
    this.targetSurfacePositions = new Float32Array(rig.surfaceDirections.length);
    this.displayCenter.set(this.simulation.center);
    this.reconstructSurfaceTarget();
    this.applySurfaceTarget(1);
    this.updateContents(0);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    motion?: PbfSlimeMotionPresentation,
  ): void {
    const frameSeconds = Math.max(0, Math.min(deltaSeconds, 0.1));
    this.collisionContactSeconds = Math.max(0, this.collisionContactSeconds - frameSeconds);
    if (motion) this.updateMotionPresentation(frameSeconds, motion);
    if (frameSeconds > 0 && this.simulationActiveSeconds > 0) {
      this.simulation.update(frameSeconds);
      this.simulationActiveSeconds = Math.max(0, this.simulationActiveSeconds - frameSeconds);
      if (this.simulationActiveSeconds === 0) this.simulation.sleep();
      this.surfaceAccumulator += frameSeconds;
      if (this.surfaceAccumulator >= SURFACE_UPDATE_SECONDS) {
        this.reconstructSurfaceTarget();
        this.surfaceAccumulator %= SURFACE_UPDATE_SECONDS;
      }
    } else {
      // 冻结期保留一次立即重建额度；下一次真实碰撞能在首帧刷新目标。
      this.surfaceAccumulator = SURFACE_UPDATE_SECONDS;
    }
    this.applySurfaceTarget(1 - Math.exp(-SURFACE_FOLLOW_RATE * frameSeconds));
    this.updateContents(elapsedSeconds);
    this.rig.root.userData.pbfStats = this.simulation.stats();
    this.rig.root.userData.pbfSimulationActive = this.simulationActiveSeconds > 0;
  }

  /** 复刻参考项目：外壳不随控制器硬转，脸部向目标方向做约 0.1/FixedUpdate 的滞后。 */
  private updateMotionPresentation(
    deltaSeconds: number,
    motion: PbfSlimeMotionPresentation,
  ): void {
    if (!Number.isFinite(motion.authorityYaw) || !Number.isFinite(motion.movementSpeed)) return;
    const authorityYaw = normalizeAngle(motion.authorityYaw);
    const speed = Math.max(0, motion.movementSpeed);
    const driveVelocityX = Number.isFinite(motion.movementVelocityX)
      ? motion.movementVelocityX as number
      : Math.sin(authorityYaw) * speed;
    const driveVelocityZ = Number.isFinite(motion.movementVelocityZ)
      ? motion.movementVelocityZ as number
      : Math.cos(authorityYaw) * speed;
    if (!this.hasMotionPresentation) {
      this.fluidFacingYaw = authorityYaw;
      this.hasMotionPresentation = true;
    } else {
      const turnAmount = 1 - Math.exp(
        -REFERENCE_FACE_TURN_RESPONSE * Math.max(0, Math.min(deltaSeconds, 0.1)),
      );
      this.fluidFacingYaw = lerpAngle(this.fluidFacingYaw, authorityYaw, turnAmount);
    }

    const maximumLag = this.rig.radius * MAX_BODY_LAG_RADIUS_RATIO;
    const targetLength = Math.hypot(driveVelocityX, driveVelocityZ) * BODY_LAG_SECONDS;
    const targetScale = targetLength > maximumLag && targetLength > 1e-8
      ? maximumLag / targetLength
      : 1;
    const targetLagX = -driveVelocityX * BODY_LAG_SECONDS * targetScale;
    const targetLagZ = -driveVelocityZ * BODY_LAG_SECONDS * targetScale;
    const lagAmount = 1 - Math.exp(-BODY_LAG_FOLLOW_RATE * deltaSeconds);
    this.bodyLagWorldX += (targetLagX - this.bodyLagWorldX) * lagAmount;
    this.bodyLagWorldZ += (targetLagZ - this.bodyLagWorldZ) * lagAmount;

    const collisionX = Number.isFinite(motion.collisionDisplacementX)
      ? motion.collisionDisplacementX as number
      : 0;
    const collisionZ = Number.isFinite(motion.collisionDisplacementZ)
      ? motion.collisionDisplacementZ as number
      : 0;
    if (Math.hypot(collisionX, collisionZ) > 1e-6) {
      const isNewContact = this.collisionContactSeconds <= 0;
      this.collisionContactSeconds = COLLISION_CONTACT_GRACE_SECONDS;
      if (isNewContact) {
        const collisionStep = Math.max(1 / 120, deltaSeconds);
        this.simulation.applyCollisionImpulse(
          collisionX / collisionStep * COLLISION_VELOCITY_TRANSFER,
          collisionZ / collisionStep * COLLISION_VELOCITY_TRANSFER,
        );
        this.simulationActiveSeconds = Math.max(
          this.simulationActiveSeconds,
          COLLISION_ADAPT_SECONDS,
        );
      }
    }

    // 根节点 yaw 仍服务于权威朝向、碰撞和同步；PBF 外壳在 visualRoot 下抵消刚体旋转。
    this.rig.root.rotation.y = -authorityYaw;
    // 子节点平移先经过 Actor yaw；转回父局部坐标后，世界空间只保留一半拖后。
    // 外壳顶点的高度剪切补上另一半，并让接地点保持在阴影中心。
    const halfLagX = this.bodyLagWorldX * 0.5;
    const halfLagZ = this.bodyLagWorldZ * 0.5;
    const cosine = Math.cos(authorityYaw);
    const sine = Math.sin(authorityYaw);
    this.rig.root.position.x = cosine * halfLagX - sine * halfLagZ;
    this.rig.root.position.z = sine * halfLagX + cosine * halfLagZ;
  }

  private reconstructSurfaceTarget(): void {
    this.computeMeanParticlePositions();
    const positions = this.reconstructedParticles;
    const center = this.simulation.center;
    const shellRadius = this.simulation.particleShellRadius;
    const shellRadiusSquared = shellRadius * shellRadius;
    const directions = this.rig.surfaceDirections;
    const minimumRadius = this.rig.radius * 0.46;
    const maximumRadius = this.rig.radius * 1.02;
    const softMaximumWidth = this.rig.radius * 0.075;
    for (let offset = 0; offset < directions.length; offset += 3) {
      const directionX = directions[offset];
      const directionY = directions[offset + 1];
      const directionZ = directions[offset + 2];
      let maximumCandidate = minimumRadius;
      let weightSum = 0;
      let weightedRadius = 0;
      for (let particleOffset = 0; particleOffset < positions.length; particleOffset += 3) {
        const deltaX = positions[particleOffset] - center[0];
        const deltaY = positions[particleOffset + 1] - center[1];
        const deltaZ = positions[particleOffset + 2] - center[2];
        const along = deltaX * directionX + deltaY * directionY + deltaZ * directionZ;
        const perpendicularSquared = Math.max(
          0,
          deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ - along * along,
        );
        if (perpendicularSquared >= shellRadiusSquared) continue;
        const candidate = along + Math.sqrt(shellRadiusSquared - perpendicularSquared);
        const kernel = 1 - perpendicularSquared / shellRadiusSquared;
        const kernelWeight = Math.max(0.02, kernel * kernel * kernel);
        if (candidate > maximumCandidate) {
          const rescale = Math.exp((maximumCandidate - candidate) / softMaximumWidth);
          weightSum *= rescale;
          weightedRadius *= rescale;
          maximumCandidate = candidate;
        }
        const weight = kernelWeight * Math.exp((candidate - maximumCandidate) / softMaximumWidth);
        weightSum += weight;
        weightedRadius += candidate * weight;
      }
      const surfaceRadius = Math.max(
        minimumRadius,
        Math.min(maximumRadius, weightSum > 1e-6 ? weightedRadius / weightSum : minimumRadius),
      );
      this.targetSurfaceRadii[offset / 3] = surfaceRadius;
    }

    // 参考项目在 DensityProjection 后执行一次 3×3×3 GridBlur；固定拓扑上用球面邻域低通等价实现。
    for (let vertex = 0; vertex < this.targetSurfaceRadii.length; vertex += 1) {
      const neighbors = this.rig.surfaceNeighbors[vertex];
      let neighborSum = 0;
      for (const neighbor of neighbors) neighborSum += this.targetSurfaceRadii[neighbor];
      const neighborAverage = neighbors.length > 0
        ? neighborSum / neighbors.length
        : this.targetSurfaceRadii[vertex];
      this.blurredSurfaceRadii[vertex] = (
        this.targetSurfaceRadii[vertex] * 0.44 + neighborAverage * 0.56
      );
    }

    for (let offset = 0; offset < directions.length; offset += 3) {
      const directionX = directions[offset];
      const directionY = directions[offset + 1];
      const directionZ = directions[offset + 2];
      const surfaceRadius = this.blurredSurfaceRadii[offset / 3];
      const targetX = center[0] + directionX * surfaceRadius;
      const targetY = Math.max(0.018, center[1] + directionY * surfaceRadius);
      const targetZ = center[2] + directionZ * surfaceRadius;
      this.targetSurfacePositions[offset] = targetX;
      this.targetSurfacePositions[offset + 1] = targetY;
      this.targetSurfacePositions[offset + 2] = targetZ;
    }
  }

  /**
   * 密度投影维持 30 Hz 固定预算，渲染顶点则每帧追随目标，避免外壳隔帧跳变。
   * 这相当于参考 GridBlur 后的显示插值，不会反向影响 PBF 粒子或权威 Transform。
   */
  private applySurfaceTarget(smoothing: number): void {
    const output = this.rig.surfacePosition.array as Float32Array;
    const inverseHeight = 1 / Math.max(1e-5, this.rig.radius * 1.05);
    for (let offset = 0; offset < output.length; offset += 3) {
      const heightWeight = Math.max(
        0,
        Math.min(1, this.targetSurfacePositions[offset + 1] * inverseHeight),
      );
      // 上层跟随 Actor，接触层留在后方：与整团拖后相加后，顶部接近根节点，底部完整滞留。
      const adhesionWeight = 0.5 - heightWeight;
      const targetX = this.targetSurfacePositions[offset] + this.bodyLagWorldX * adhesionWeight;
      const targetZ = this.targetSurfacePositions[offset + 2] + this.bodyLagWorldZ * adhesionWeight;
      output[offset] += (targetX - output[offset]) * smoothing;
      output[offset + 1] += (
        this.targetSurfacePositions[offset + 1] - output[offset + 1]
      ) * smoothing;
      output[offset + 2] += (targetZ - output[offset + 2]) * smoothing;
    }
    this.displayCenter[0] += (this.simulation.center[0] - this.displayCenter[0]) * smoothing;
    this.displayCenter[1] += (this.simulation.center[1] - this.displayCenter[1]) * smoothing;
    this.displayCenter[2] += (this.simulation.center[2] - this.displayCenter[2]) * smoothing;
    this.rig.surfacePosition.needsUpdate = true;
    this.rig.surfaceGeometry.computeVertexNormals();
  }

  /** 参考 ComputeMeanPosJob：Poly6 邻域均值先消除单个边缘粒子的高频位置噪声。 */
  private computeMeanParticlePositions(): void {
    const positions = this.simulation.positions;
    const output = this.reconstructedParticles;
    const kernelRadius = this.simulation.surfaceKernelRadius;
    const kernelRadiusSquared = kernelRadius * kernelRadius;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      let weightSum = 0;
      let meanX = 0;
      let meanY = 0;
      let meanZ = 0;
      for (let neighborOffset = 0; neighborOffset < positions.length; neighborOffset += 3) {
        const deltaX = x - positions[neighborOffset];
        const deltaY = y - positions[neighborOffset + 1];
        const deltaZ = z - positions[neighborOffset + 2];
        const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
        if (distanceSquared >= kernelRadiusSquared) continue;
        const normalized = 1 - distanceSquared / kernelRadiusSquared;
        const weight = normalized * normalized * normalized;
        weightSum += weight;
        meanX += positions[neighborOffset] * weight;
        meanY += positions[neighborOffset + 1] * weight;
        meanZ += positions[neighborOffset + 2] * weight;
      }
      const inverseWeight = weightSum > 1e-6 ? 1 / weightSum : 0;
      output[offset] = weightSum > 1e-6 ? meanX * inverseWeight : x;
      output[offset + 1] = weightSum > 1e-6 ? meanY * inverseWeight : y;
      output[offset + 2] = weightSum > 1e-6 ? meanZ * inverseWeight : z;
    }
  }

  private updateContents(elapsedSeconds: number): void {
    const center = this.displayCenter;
    const positions = this.simulation.positions;
    const radius = this.rig.radius;
    this.rig.core.position.set(center[0], center[1], center[2]);
    this.rig.core.rotation.y = elapsedSeconds * 0.18;
    this.rig.core.rotation.z = 0;
    this.rig.core.scale.setScalar(1);

    for (const bubble of this.rig.bubbles) {
      const particleOffset = bubble.particleIndex * 3;
      const progress = (elapsedSeconds * this.definition.bubbleSpeed + bubble.phase) % 1;
      const fadeScale = Math.max(0.08, Math.sin(progress * Math.PI));
      bubble.mesh.position.set(
        center[0] * 0.35 + positions[particleOffset] * 0.44,
        Math.max(radius * 0.22, center[1] - radius * 0.48 + progress * radius * 0.96),
        center[2] * 0.35 + positions[particleOffset + 2] * 0.44,
      );
      bubble.mesh.scale.setScalar(fadeScale);
    }

    const faceYaw = this.hasMotionPresentation ? this.fluidFacingYaw : 0;
    const faceDirectionX = Math.sin(faceYaw);
    const faceDirectionZ = Math.cos(faceYaw);
    const frontRadius = this.measureSurfaceRadius(faceDirectionX, 0, faceDirectionZ);
    this.rig.faceRoot.position.set(
      center[0] + faceDirectionX * frontRadius * 0.94 - this.bodyLagWorldX * 0.5,
      center[1],
      center[2] + faceDirectionZ * frontRadius * 0.94 - this.bodyLagWorldZ * 0.5,
    );
    this.rig.faceRoot.rotation.y = faceYaw;
    this.rig.faceRoot.rotation.z = 0;
    const horizontalExtent = Math.max(
      this.measureSurfaceRadius(1, 0, 0),
      this.measureSurfaceRadius(-1, 0, 0),
    );
    const shadowScale = Math.max(0.72, horizontalExtent / radius);
    const lagLength = Math.hypot(this.bodyLagWorldX, this.bodyLagWorldZ);
    const lagRatio = lagLength / Math.max(1e-5, radius);
    const localLagX = this.rig.root.position.x * 2;
    const localLagZ = this.rig.root.position.z * 2;
    this.rig.shadowRoot.position.x = this.rig.root.position.x;
    this.rig.shadowRoot.position.z = this.rig.root.position.z;
    this.rig.shadowRoot.rotation.y = lagLength > 1e-5
      ? Math.atan2(localLagX, localLagZ)
      : 0;
    const adhesionStretch = 1 + Math.min(0.72, lagRatio * 2.5);
    const adhesionWidth = 1 - Math.min(0.16, lagRatio * 0.55);
    this.rig.shadow.scale.set(
      shadowScale * adhesionWidth,
      shadowScale * adhesionStretch,
      1,
    );
    this.rig.shadow.material.opacity = Math.min(
      0.28,
      0.1 + 0.07 / Math.max(0.65, shadowScale) + lagRatio * 0.34,
    );
  }

  private measureSurfaceRadius(directionX: number, directionY: number, directionZ: number): number {
    const positions = this.rig.surfacePosition.array as Float32Array;
    const directions = this.rig.surfaceDirections;
    const center = this.displayCenter;
    let weightedRadius = 0;
    let weightSum = 0;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const alignment = (
        directions[offset] * directionX
        + directions[offset + 1] * directionY
        + directions[offset + 2] * directionZ
      );
      if (alignment < 0.94) continue;
      const projection = (
        (positions[offset] - center[0]) * directionX
        + (positions[offset + 1] - center[1]) * directionY
        + (positions[offset + 2] - center[2]) * directionZ
      );
      const weight = (alignment - 0.94) ** 2;
      weightedRadius += projection * weight;
      weightSum += weight;
    }
    return Math.max(
      this.rig.radius * 0.46,
      Math.min(this.rig.radius * 1.02, weightSum > 1e-8 ? weightedRadius / weightSum : 0),
    );
  }
}

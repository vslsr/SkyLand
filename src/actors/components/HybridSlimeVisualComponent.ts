import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { PbfSlimeRenderDefinition } from '../../models/actors/createPbfSlimeModel';
import type { PbfSlimeVisualRig } from '../../models/actors/ActorVisualModel';
import { HybridSlimeSimulation } from '../../slime/hybrid/HybridSlimeSimulation';

export const HYBRID_SLIME_VISUAL_COMPONENT = 'hybrid-slime-visual';
const REFERENCE_FACE_TURN_RESPONSE = 5.27;
const COLLISION_CONTACT_GRACE_SECONDS = 0.1;

export interface HybridSlimeMotionPresentation {
  /** Actor 根节点上的权威/预测 yaw；外壳抵消它，脸部单独柔和转向。 */
  authorityYaw: number;
  movementSpeed: number;
  movementVelocityX?: number;
  movementVelocityZ?: number;
  /** 跳跃表现输入；由同一运动演示对象携带，当前软体驱动可按需消费。 */
  verticalVelocity?: number;
  grounded?: boolean;
  /** 控制器被环境圆柱碰撞阻挡的位移，只在新接触时注入蒙皮。 */
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

/**
 * 单球核心 + 胡克弹簧蒙皮。所有状态仅存在于客户端 visualRoot，
 * 不改写 Actor 权威 Transform，也不进入网络快照。
 */
export class HybridSlimeVisualComponent extends ActorComponent {
  public readonly simulation: HybridSlimeSimulation;
  private collisionContactSeconds = 0;
  private fluidFacingYaw = 0;
  private hasMotionPresentation = false;

  public constructor(
    public readonly rig: PbfSlimeVisualRig,
    private readonly definition: PbfSlimeRenderDefinition,
  ) {
    super(HYBRID_SLIME_VISUAL_COMPONENT);
    this.simulation = new HybridSlimeSimulation({
      radius: definition.radius,
      surfaceDirections: rig.surfaceDirections,
      surfaceNeighbors: rig.surfaceNeighbors,
      coreStiffness: Math.max(18, definition.centerForce * 2.4),
      skinStiffness: Math.max(28, definition.centerForce * 2.8),
      skinDamping: Math.max(8, definition.viscosity * 1.4),
      neighborStiffness: Math.max(7, definition.centerForce * 0.9),
    });
    this.applySimulationSurface();
    this.updateContents(0, 0);
    this.updateDebugState();
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    motion?: HybridSlimeMotionPresentation,
  ): void {
    const frameSeconds = Math.max(0, Math.min(deltaSeconds, 0.1));
    this.collisionContactSeconds = Math.max(0, this.collisionContactSeconds - frameSeconds);
    if (motion) this.updateMotionPresentation(frameSeconds, motion);
    else {
      this.simulation.setDriveVelocity(0, 0);
      this.simulation.setAirborneMotion(0, true);
    }
    if (this.simulation.update(frameSeconds)) this.applySimulationSurface();
    this.updateContents(elapsedSeconds, motion?.authorityYaw ?? 0);
    this.updateDebugState();
  }

  private updateMotionPresentation(
    deltaSeconds: number,
    motion: HybridSlimeMotionPresentation,
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
    this.simulation.setDriveVelocity(driveVelocityX, driveVelocityZ);
    this.simulation.setAirborneMotion(
      Number.isFinite(motion.verticalVelocity) ? motion.verticalVelocity as number : 0,
      motion.grounded !== false,
    );

    if (!this.hasMotionPresentation) {
      this.fluidFacingYaw = authorityYaw;
      this.hasMotionPresentation = true;
    } else {
      const turnAmount = 1 - Math.exp(-REFERENCE_FACE_TURN_RESPONSE * deltaSeconds);
      this.fluidFacingYaw = lerpAngle(this.fluidFacingYaw, authorityYaw, turnAmount);
    }

    const collisionX = Number.isFinite(motion.collisionDisplacementX)
      ? motion.collisionDisplacementX as number
      : 0;
    const collisionZ = Number.isFinite(motion.collisionDisplacementZ)
      ? motion.collisionDisplacementZ as number
      : 0;
    if (Math.hypot(collisionX, collisionZ) > 1e-6) {
      const isNewContact = this.collisionContactSeconds <= 0;
      this.collisionContactSeconds = COLLISION_CONTACT_GRACE_SECONDS;
      if (isNewContact) this.simulation.applyCollision(collisionX, collisionZ, deltaSeconds);
    }

    // 外壳的弹簧坐标保持世界朝向，避免 Actor yaw 把软体当作刚体瞬间旋转。
    this.rig.root.rotation.y = -authorityYaw;
  }

  private applySimulationSurface(): void {
    const output = this.rig.surfacePosition.array as Float32Array;
    output.set(this.simulation.positions);
    this.rig.surfacePosition.needsUpdate = true;
    this.rig.surfaceGeometry.computeVertexNormals();
    this.applyShadowFootprint();
  }

  /** 阴影边界逐点复制赤道贴地环，因此碰撞凹陷、拖尾和水滴轮廓不会与本体分离。 */
  private applyShadowFootprint(): void {
    const surface = this.simulation.positions;
    const shadow = this.rig.shadowPosition;
    const boundary = this.rig.shadowBoundaryVertices;
    let centerX = 0;
    let centerZ = 0;
    for (let ringVertex = 0; ringVertex < boundary.length; ringVertex += 1) {
      const surfaceOffset = boundary[ringVertex] * 3;
      const x = surface[surfaceOffset];
      const z = surface[surfaceOffset + 2];
      shadow.setXYZ(ringVertex + 1, x, -z, 0);
      // 末尾是与首点重合的闭环顶点，不重复计入扇形中心。
      if (ringVertex === boundary.length - 1) continue;
      centerX += x;
      centerZ += z;
    }
    const uniqueBoundaryCount = Math.max(1, boundary.length - 1);
    shadow.setXYZ(0, centerX / uniqueBoundaryCount, -centerZ / uniqueBoundaryCount, 0);
    shadow.needsUpdate = true;
  }

  private updateContents(elapsedSeconds: number, authorityYaw: number): void {
    const center = this.simulation.center;
    const forceCenter = this.simulation.forceCenter;
    const radius = this.rig.radius;
    this.rig.core.position.set(forceCenter[0], forceCenter[1], forceCenter[2]);
    this.rig.core.rotation.set(0, this.simulation.coreYaw, 0);
    this.rig.core.scale.set(
      this.simulation.coreScale[0],
      this.simulation.coreScale[1],
      this.simulation.coreScale[2],
    );

    for (const bubble of this.rig.bubbles) {
      const progress = (elapsedSeconds * this.definition.bubbleSpeed + bubble.phase) % 1;
      const fadeScale = Math.max(0.08, Math.sin(progress * Math.PI));
      // 气泡只在核心附近上浮。旧实现从外壳顶点取位置，受形变后可能穿出蒙皮，
      // 看起来像史莱姆本体长出随机凸块。
      const angle = bubble.particleIndex * 2.399963229728653 + progress * 0.7;
      const orbitRadius = radius * 0.15 * (1 - progress * 0.28);
      bubble.mesh.position.set(
        center[0] * 0.72 + Math.cos(angle) * orbitRadius,
        Math.max(radius * 0.18, center[1] - radius * 0.25 + progress * radius * 0.42),
        center[2] * 0.72 + Math.sin(angle) * orbitRadius,
      );
      bubble.mesh.scale.setScalar(fadeScale);
    }

    const faceYaw = this.hasMotionPresentation ? this.fluidFacingYaw : 0;
    const faceDirectionX = Math.sin(faceYaw);
    const faceDirectionZ = Math.cos(faceYaw);
    const faceSurface = this.measureFaceSurface(faceDirectionX, faceDirectionZ);
    this.rig.faceRoot.position.set(
      center[0] + faceDirectionX * faceSurface.radius * 0.7,
      faceSurface.y,
      center[2] + faceDirectionZ * faceSurface.radius * 0.7,
    );
    this.rig.faceRoot.rotation.set(0, faceYaw, 0);

    const lagLength = Math.hypot(center[0], center[2]);
    const lagRatio = lagLength / Math.max(1e-5, radius);
    this.rig.shadowRoot.position.set(0, 0, 0);
    this.rig.shadowRoot.rotation.y = -authorityYaw;
    this.rig.shadow.scale.set(1, 1, 1);
    this.rig.shadow.material.setOpacity(Math.min(0.25, 0.16 + lagRatio * 0.24));
  }

  /** 贴地穹顶的最大半径位于地面，脸部必须采样中上层而不能继续放在赤道外沿。 */
  private measureFaceSurface(
    directionX: number,
    directionZ: number,
  ): { radius: number; y: number } {
    const positions = this.simulation.positions;
    const directions = this.rig.surfaceDirections;
    const center = this.simulation.center;
    const targetDirectionY = 0.55;
    let weightedRadius = 0;
    let weightedY = 0;
    let weightSum = 0;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const heightDistance = Math.abs(directions[offset + 1] - targetDirectionY);
      if (heightDistance > 0.14) continue;
      const horizontalLength = Math.hypot(directions[offset], directions[offset + 2]);
      if (horizontalLength < 1e-5) continue;
      const alignment = (
        directions[offset] * directionX + directions[offset + 2] * directionZ
      ) / horizontalLength;
      if (alignment < 0.9) continue;
      const weight = (alignment - 0.9) * (0.14 - heightDistance);
      weightedRadius += (
        (positions[offset] - center[0]) * directionX
        + (positions[offset + 2] - center[2]) * directionZ
      ) * weight;
      weightedY += positions[offset + 1] * weight;
      weightSum += weight;
    }
    if (weightSum <= 1e-8) {
      return { radius: this.rig.radius * 0.62, y: center[1] };
    }
    return {
      radius: Math.max(this.rig.radius * 0.42, weightedRadius / weightSum),
      y: weightedY / weightSum,
    };
  }

  private updateDebugState(): void {
    this.rig.root.userData.hybridStats = this.simulation.stats();
    this.rig.root.userData.hybridSimulationActive = this.simulation.isActive;
  }
}

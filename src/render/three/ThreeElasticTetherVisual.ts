import * as THREE from 'three';
import type { ElasticTetherVisualRig } from '../../models/actors/ActorVisualModel';
import type { ProxyId } from '../RenderScene';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';
import {
  PARAM_ELASTIC_DETACH_LENGTH,
  PARAM_ELASTIC_DETACHED,
  PARAM_ELASTIC_HELD,
  PARAM_ELASTIC_RELEASE_REVISION,
  PARAM_ELASTIC_TARGET_X,
  PARAM_ELASTIC_TARGET_Y,
  PARAM_ELASTIC_TARGET_Z,
} from '../RenderVisualParams';

const UP = new THREE.Vector3(0, 1, 0);
const MAX_FRAME_SECONDS = 0.1;
const MAX_STEP_SECONDS = 1 / 60;

/**
 * 让同一张地图上的蘑菇不要整齐划一地晃。
 *
 * 搬迁之前这里哈希的是 Actor id；现在哈希槽位。用途只有一个——把闲置摆动的相位
 * 错开——而槽位在这个 proxy 活着的整段时间里都不变，所以效果一样。
 */
function stablePhase(id: ProxyId): number {
  let hash = Math.imul(id + 1, 2654435761) >>> 0;
  hash ^= hash >>> 15;
  return (hash >>> 0) / 0xffffffff * Math.PI * 2;
}

/**
 * 弹性拉伸（实现路径文档 §1.75）。
 *
 * 这里以前是 `ElasticTetherVisualSystem`。弹簧积分、拉伸比例、菌盖摆动全都只写
 * `visualRoot` 子树，从来不是玩法——过边界的只有「被谁拉到哪儿」：
 * 目标点、两个状态位、拔断长度和一个松手计数。
 */
export class ThreeElasticTetherVisual {
  private readonly tip: THREE.Vector3;
  private readonly velocity = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly world: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly phase: number;
  private releaseRevision = 0;
  private started = false;

  public constructor(
    private readonly id: ProxyId,
    private readonly rig: ElasticTetherVisualRig,
  ) {
    this.phase = stablePhase(id);
    this.tip = new THREE.Vector3(0, rig.restLength, 0);
  }

  public update(
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    // 已经脱落的物件不再是「长在地上、被拉长的菌柄」，姿态由刚体朝向接管。
    // 这里若继续把它掰回竖直，翻滚就会被每帧拽回立姿。
    if (transforms.readParam(this.id, PARAM_ELASTIC_DETACHED) !== 0) {
      this.restPose();
      this.started = false;
      return;
    }
    const releaseRevision = transforms.readParam(this.id, PARAM_ELASTIC_RELEASE_REVISION);
    if (!this.started) {
      this.tip.set(0, this.rig.restLength, 0);
      this.velocity.set(0, 0, 0);
      this.releaseRevision = releaseRevision;
      this.started = true;
    }
    const held = transforms.readParam(this.id, PARAM_ELASTIC_HELD) !== 0;
    this.resolveDesired(transforms, held, elapsedSeconds);

    if (this.releaseRevision !== releaseRevision) this.velocity.multiplyScalar(1.12);
    this.releaseRevision = releaseRevision;
    this.integrate(deltaSeconds, held);

    const maximumLength = transforms.readParam(this.id, PARAM_ELASTIC_DETACH_LENGTH) * 1.12;
    let length = this.tip.length();
    if (!Number.isFinite(length) || length < this.rig.restLength * 0.35) {
      this.tip.set(0, this.rig.restLength, 0);
      this.velocity.set(0, 0, 0);
      length = this.rig.restLength;
    } else if (length > maximumLength) {
      this.tip.multiplyScalar(maximumLength / length);
      length = maximumLength;
    }

    this.direction.copy(this.tip).multiplyScalar(1 / length);
    this.rotation.setFromUnitVectors(UP, this.direction);
    this.rig.elasticRoot.quaternion.copy(this.rotation);

    // 上限跟着这次叼取的拔断长度走，不能写死：菌盖位置直接取 length，
    // 菌柄却按 stretch 缩放，两者用不同的上限就会在拉到头时脱开。
    const maximumStretch = Math.max(1, maximumLength / this.rig.restLength);
    const stretch = THREE.MathUtils.clamp(length / this.rig.restLength, 0.5, maximumStretch);
    const widthScale = THREE.MathUtils.clamp(1 / Math.sqrt(stretch), 0.55, 1.18);
    this.rig.stemRoot.scale.set(widthScale, stretch, widthScale);
    this.rig.capRoot.position.y = length;
    const capSpread = 1 + Math.min(0.16, Math.max(0, stretch - 1) * 0.06);
    const capSquash = 1 - Math.min(0.12, Math.max(0, stretch - 1) * 0.045);
    const releaseWobble = Math.min(0.09, this.velocity.length() * 0.012);
    this.rig.capRoot.scale.set(
      capSpread + releaseWobble,
      capSquash - releaseWobble * 0.55,
      capSpread + releaseWobble,
    );
    this.rig.capRoot.rotation.y = Math.sin(elapsedSeconds * 2.2 + this.phase) * 0.035;
    this.rig.capRoot.rotation.z = Math.sin(elapsedSeconds * 3.1 + this.phase) * releaseWobble;
  }

  /** 脱落瞬间把拉伸、摆动和回弹一次性收回原状，交给翻滚表现摆姿势。 */
  private restPose(): void {
    this.rig.elasticRoot.quaternion.identity();
    this.rig.stemRoot.scale.set(1, 1, 1);
    this.rig.capRoot.position.y = this.rig.restLength;
    this.rig.capRoot.scale.set(1, 1, 1);
    this.rig.capRoot.rotation.set(0, 0, 0);
  }

  private resolveDesired(
    transforms: RenderTransformBuffer,
    held: boolean,
    elapsedSeconds: number,
  ): void {
    const restLength = this.rig.restLength;
    if (!held) {
      this.desired.set(
        Math.sin(elapsedSeconds * 1.7 + this.phase) * 0.018,
        restLength * (1 + Math.sin(elapsedSeconds * 2 + this.phase) * 0.018),
        Math.cos(elapsedSeconds * 1.45 + this.phase) * 0.014,
      );
      return;
    }
    transforms.readTransform(this.id, this.world);
    const deltaX = transforms.readParam(this.id, PARAM_ELASTIC_TARGET_X) - this.world.x;
    const deltaZ = transforms.readParam(this.id, PARAM_ELASTIC_TARGET_Z) - this.world.z;
    const sinYaw = Math.sin(this.world.yaw);
    const cosYaw = Math.cos(this.world.yaw);
    this.desired.set(
      cosYaw * deltaX - sinYaw * deltaZ,
      transforms.readParam(this.id, PARAM_ELASTIC_TARGET_Y) - this.world.y,
      sinYaw * deltaX + cosYaw * deltaZ,
    );
  }

  private integrate(deltaSeconds: number, held: boolean): void {
    const total = Math.min(Math.max(deltaSeconds, 0), MAX_FRAME_SECONDS);
    const steps = Math.max(1, Math.ceil(total / MAX_STEP_SECONDS));
    const step = steps > 0 ? total / steps : 0;
    const stiffness = held ? 245 : 88;
    const damping = held ? 22 : 6.4;
    for (let index = 0; index < steps; index += 1) {
      this.velocity.x += (this.desired.x - this.tip.x) * stiffness * step;
      this.velocity.y += (this.desired.y - this.tip.y) * stiffness * step;
      this.velocity.z += (this.desired.z - this.tip.z) * stiffness * step;
      this.velocity.multiplyScalar(Math.exp(-damping * step));
      this.tip.addScaledVector(this.velocity, step);
    }
  }
}

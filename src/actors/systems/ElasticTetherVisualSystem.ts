import * as THREE from 'three';
import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  ELASTIC_DETACH_COMPONENT,
  type ElasticDetachComponent,
  ELASTIC_TETHER_COMPONENT,
  type ElasticTetherComponent,
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/index.mjs';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../components/ThreeObjectComponent';

interface ElasticVisualState {
  tip: THREE.Vector3;
  velocity: THREE.Vector3;
  releaseRevision: number;
  phase: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const MAX_FRAME_SECONDS = 0.1;
const MAX_STEP_SECONDS = 1 / 60;

function stablePhase(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff * Math.PI * 2;
}

/** 复制关系只决定目标端点；所有拉伸、摆动和回弹均限制在 visualRoot 子树。 */
export class ElasticTetherVisualSystem {
  private readonly states = new Map<string, ElasticVisualState>();
  private readonly desired = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    const live = new Set<string>();
    for (const actor of world.query(
      ELASTIC_TETHER_COMPONENT,
      TRANSFORM_COMPONENT,
      THREE_OBJECT_COMPONENT,
    ) as Actor[]) {
      const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
      const rig = render.elasticTetherRig;
      if (!rig) continue;
      // 已经脱落的物件不再是「长在地上、被拉长的菌柄」，姿态由刚体朝向接管。
      // 这里若继续把它掰回竖直，翻滚就会被每帧拽回立姿。
      const detachable = actor.getComponent(
        ELASTIC_DETACH_COMPONENT,
      ) as ElasticDetachComponent | undefined;
      if (detachable?.detached) {
        this.states.delete(actor.id);
        this.restPose(rig);
        continue;
      }
      live.add(actor.id);
      const tether = actor.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const state = this.states.get(actor.id) ?? this.createState(actor.id, rig.restLength, tether);
      this.resolveDesired(this.desired, tether, transform, rig.restLength, state.phase, elapsedSeconds);

      const released = state.releaseRevision !== tether.releaseRevision;
      state.releaseRevision = tether.releaseRevision;
      if (released) state.velocity.multiplyScalar(1.12);
      this.integrate(state, this.desired, deltaSeconds, tether.holderPlayerId !== null);

      const maximumLength = tether.detachLength * 1.12;
      let length = state.tip.length();
      if (!Number.isFinite(length) || length < rig.restLength * 0.35) {
        state.tip.set(0, rig.restLength, 0);
        state.velocity.set(0, 0, 0);
        length = rig.restLength;
      } else if (length > maximumLength) {
        state.tip.multiplyScalar(maximumLength / length);
        length = maximumLength;
      }

      this.direction.copy(state.tip).multiplyScalar(1 / length);
      this.rotation.setFromUnitVectors(UP, this.direction);
      rig.elasticRoot.quaternion.copy(this.rotation);

      // 上限跟着这次叼取的拔断长度走，不能写死：菌盖位置直接取 length，
      // 菌柄却按 stretch 缩放，两者用不同的上限就会在拉到头时脱开。
      const maximumStretch = Math.max(1, maximumLength / rig.restLength);
      const stretch = THREE.MathUtils.clamp(length / rig.restLength, 0.5, maximumStretch);
      const widthScale = THREE.MathUtils.clamp(1 / Math.sqrt(stretch), 0.55, 1.18);
      rig.stemRoot.scale.set(widthScale, stretch, widthScale);
      rig.capRoot.position.y = length;
      const capSpread = 1 + Math.min(0.16, Math.max(0, stretch - 1) * 0.06);
      const capSquash = 1 - Math.min(0.12, Math.max(0, stretch - 1) * 0.045);
      const releaseWobble = Math.min(0.09, state.velocity.length() * 0.012);
      rig.capRoot.scale.set(
        capSpread + releaseWobble,
        capSquash - releaseWobble * 0.55,
        capSpread + releaseWobble,
      );
      rig.capRoot.rotation.y = Math.sin(elapsedSeconds * 2.2 + state.phase) * 0.035;
      rig.capRoot.rotation.z = Math.sin(elapsedSeconds * 3.1 + state.phase) * releaseWobble;
    }

    for (const actorId of this.states.keys()) {
      if (!live.has(actorId)) this.states.delete(actorId);
    }
  }

  /** 脱落瞬间把拉伸、摆动和回弹一次性收回原状，交给翻滚系统摆姿势。 */
  private restPose(rig: NonNullable<ThreeObjectComponent['elasticTetherRig']>): void {
    rig.elasticRoot.quaternion.identity();
    rig.stemRoot.scale.set(1, 1, 1);
    rig.capRoot.position.y = rig.restLength;
    rig.capRoot.scale.set(1, 1, 1);
    rig.capRoot.rotation.set(0, 0, 0);
  }

  private createState(
    actorId: string,
    restLength: number,
    tether: ElasticTetherComponent,
  ): ElasticVisualState {
    const state = {
      tip: new THREE.Vector3(0, restLength, 0),
      velocity: new THREE.Vector3(),
      releaseRevision: tether.releaseRevision,
      phase: stablePhase(actorId),
    };
    this.states.set(actorId, state);
    return state;
  }

  private resolveDesired(
    target: THREE.Vector3,
    tether: ElasticTetherComponent,
    transform: TransformComponent,
    restLength: number,
    phase: number,
    elapsedSeconds: number,
  ): void {
    if (!tether.holderPlayerId) {
      target.set(
        Math.sin(elapsedSeconds * 1.7 + phase) * 0.018,
        restLength * (1 + Math.sin(elapsedSeconds * 2 + phase) * 0.018),
        Math.cos(elapsedSeconds * 1.45 + phase) * 0.014,
      );
      return;
    }
    const deltaX = tether.targetX - transform.x;
    const deltaZ = tether.targetZ - transform.z;
    const sinYaw = Math.sin(transform.yaw);
    const cosYaw = Math.cos(transform.yaw);
    target.set(
      cosYaw * deltaX - sinYaw * deltaZ,
      tether.targetY - transform.y,
      sinYaw * deltaX + cosYaw * deltaZ,
    );
  }

  private integrate(
    state: ElasticVisualState,
    target: THREE.Vector3,
    deltaSeconds: number,
    held: boolean,
  ): void {
    const total = Math.min(Math.max(deltaSeconds, 0), MAX_FRAME_SECONDS);
    const steps = Math.max(1, Math.ceil(total / MAX_STEP_SECONDS));
    const step = steps > 0 ? total / steps : 0;
    const stiffness = held ? 245 : 88;
    const damping = held ? 22 : 6.4;
    for (let index = 0; index < steps; index += 1) {
      state.velocity.x += (target.x - state.tip.x) * stiffness * step;
      state.velocity.y += (target.y - state.tip.y) * stiffness * step;
      state.velocity.z += (target.z - state.tip.z) * stiffness * step;
      state.velocity.multiplyScalar(Math.exp(-damping * step));
      state.tip.addScaledVector(state.velocity, step);
    }
  }
}

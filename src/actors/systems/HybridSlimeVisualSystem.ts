import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/index.mjs';
import {
  HYBRID_SLIME_VISUAL_COMPONENT,
  type HybridSlimeVisualComponent,
} from '../components/HybridSlimeVisualComponent';

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * 固定蒙皮顶点预算的客户端混合软体；服务端不模拟或复制弹簧状态。
 *
 * `authorityYaw` 此前是从 `render.root.rotation.y` 读回来的——也就是 SoA 刚兑现
 * 出去的值又被读回玩法侧。那是一条 Render→Game 的反向依赖，上 worker 之后读不到；
 * 而且它对**有父节点的 Actor 是错的**：`submitTransforms` 给子节点写的是相对 yaw
 * （world.yaw − parent.yaw），读回来当世界 yaw 用会让外壳抵消错角度。
 *
 * 现在在玩法侧算同一个量：蒙皮要抵消的是「root 这一级实际被转了多少」，
 * 所以是相对 yaw，与渲染侧那段数学一致。
 */
export class HybridSlimeVisualSystem {
  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    for (const actor of world.query(HYBRID_SLIME_VISUAL_COMPONENT) as Actor[]) {
      const slime = actor.requireComponent(
        HYBRID_SLIME_VISUAL_COMPONENT,
      ) as HybridSlimeVisualComponent;
      const transform = actor.getComponent(TRANSFORM_COMPONENT) as TransformComponent | undefined;
      if (!transform) continue;
      const parentTransform = actor.parent?.getComponent(
        TRANSFORM_COMPONENT,
      ) as TransformComponent | undefined;
      slime.update(deltaSeconds, elapsedSeconds, {
        authorityYaw: parentTransform
          ? normalizeAngle(transform.yaw - parentTransform.yaw)
          : transform.yaw,
        movementSpeed: 0,
      });
    }
  }
}

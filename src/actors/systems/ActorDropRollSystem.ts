import * as THREE from 'three';
import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  DROP_MOTION_COMPONENT,
  type DropMotionComponent,
  ELASTIC_DETACH_COMPONENT,
  type ElasticDetachComponent,
} from '../../../shared/actor/index.mjs';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';
import type { ThreeRenderScene } from '../../render/three/ThreeRenderScene';

/**
 * 把脱落物件摆成刚体解算出的姿态。
 *
 * 拔断之前，物件是长在地上的：姿态由 Transform 的 yaw 加上弹性拉伸表现决定。
 * 拔断之后它是一颗自由刚体，躺着还是立着由服务端的四元数说了算——这一位没有
 * 复制过来的时候，蘑菇不管怎么弹、怎么滚，落地永远是笔直站着的。
 *
 * 旋转必须发生在刚体球心上：刚体球心在 Actor 原点上方 radius 处，而模型是以
 * 菌柄根部为原点建的。枢轴抬上去、本体压回来，蘑菇才是原地翻倒，而不是绕着
 * 脚跟甩出去半米。
 *
 * 遍历量跟着场上脱落物件走，与世界面积无关。
 */
export class ActorDropRollSystem {
  private readonly quaternion = new THREE.Quaternion();

  public constructor(private readonly scene: ThreeRenderScene) {}

  public update(world: ActorWorld): void {
    for (const actor of world.query(
      ELASTIC_DETACH_COMPONENT,
      DROP_MOTION_COMPONENT,
      RENDER_PROXY_COMPONENT,
    ) as Actor[]) {
      const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
      const rig = this.scene.resolve(proxy.proxyId)?.dropRollRig;
      if (!rig) continue;
      const detachable = actor.requireComponent(
        ELASTIC_DETACH_COMPONENT,
      ) as ElasticDetachComponent;
      const motion = actor.requireComponent(DROP_MOTION_COMPONENT) as DropMotionComponent;
      if (!detachable.detached || motion.radius <= 0) {
        // 还长在地上：枢轴保持单位变换，姿态完全交回给弹性拉伸表现。
        if (rig.pivotRoot.position.y !== 0) {
          rig.pivotRoot.position.y = 0;
          rig.bodyRoot.position.y = 0;
          rig.pivotRoot.quaternion.identity();
        }
        continue;
      }
      rig.pivotRoot.position.y = motion.radius;
      rig.bodyRoot.position.y = -motion.radius;
      this.quaternion.set(
        motion.rotationX,
        motion.rotationY,
        motion.rotationZ,
        motion.rotationW,
      );
      rig.pivotRoot.quaternion.copy(this.quaternion);
    }
  }
}

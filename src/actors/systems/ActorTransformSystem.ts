import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import {
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/components/TransformComponent.mjs';
import { NULL_PROXY_ID } from '../../render/RenderScene';
import type { RenderTransformBuffer } from '../../render/RenderTransformBuffer';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';

/**
 * Game World 这一侧唯一的 Game→Render 写入点（引擎迁移路线图 第 1 步）。
 *
 * 以前这里是 `render.root.position.set(...)`——直接写 `THREE.Object3D`。现在写的
 * 是 transform SoA 的字节，**这个文件因此不再 import three**。父子关系只以
 * `parentProxyId` 的形式过边界，「局部坐标怎么算」留给渲染世界（见
 * `ThreeRenderScene.submitTransforms`）。
 */
export class ActorTransformSystem {
  public constructor(private readonly transforms: RenderTransformBuffer) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    for (const actor of world.query(TRANSFORM_COMPONENT, RENDER_PROXY_COMPONENT)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
      const parentProxy = actor.parent?.getComponent(
        RENDER_PROXY_COMPONENT,
      ) as RenderProxyComponent | undefined;
      this.transforms.write(
        proxy.proxyId,
        transform.x,
        transform.y,
        transform.z,
        transform.yaw,
        parentProxy?.proxyId ?? NULL_PROXY_ID,
      );
    }
  }
}

import type { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import type { RenderScene } from '../../render/RenderScene';
import type { RenderTransformBuffer } from '../../render/RenderTransformBuffer';

/**
 * 翻面并把这一帧的 SoA 交给渲染世界（引擎迁移路线图 第 1 步）。
 *
 * 必须紧跟在 `ActorTransformSystem` 之后：后面的表现 System（附着、船体波动、
 * 弹性拉伸）都要读已经摆好位置的 `matrixWorld`，顺序错了就会差一帧。
 *
 * 第 3 步之后这个 System 会消失——渲染线程自己按显示器刷新率去读那段字节，
 * 不再由模拟侧同步推一把。它现在的存在本身就是「还没拆线程」的标记。
 */
export class RenderTransformSyncSystem {
  public constructor(
    private readonly transforms: RenderTransformBuffer,
    private readonly scene: RenderScene,
  ) {}

  public update(_world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    this.transforms.publish();
    this.scene.submitTransforms(this.transforms);
  }
}

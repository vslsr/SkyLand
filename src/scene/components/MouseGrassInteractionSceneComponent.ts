import { MouseGrassInteractor } from '../../grass';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

/** 仅在配置它的场景中，把鼠标轨迹转换为草地弯曲输入。 */
export class MouseGrassInteractionSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'mouse-grass-interaction' as const;
  private interactor?: MouseGrassInteractor;

  public constructor(private readonly context: SceneComponentContext) {
    // 「这张地图有没有草」是**场景定义说的事**，不需要回头问渲染世界要一个对象。
    // 流式地图的草由 chunk 铺，固定地图看 content.grass。
    const { renderer } = context.definition;
    if (!renderer.world && !renderer.content.grass) {
      throw new Error(
        `场景 ${context.definition.id} 加载了 ${this.type}，但没有可交互草地`,
      );
    }
  }

  public activate(): void {
    if (this.interactor) return;
    // 脉冲经 `SceneWorld` 发给渲染世界（`applyImpulse` 返回 void）。
    // 这一侧因此不需要持有那套草地系统，也就不会在渲染进线程时断掉。
    this.interactor = new MouseGrassInteractor(this.context.canvas, this.context.world);
  }

  /**
   * 每帧自己驱动，不再挂 `onBeforeRender`。
   *
   * 那个回调是渲染侧递一个 `THREE.Camera` 过来——渲染循环进线程之后就断了。
   * 现在反投影所需要的数（机位朝向、视场角、宽高比）全在主线程手里。
   */
  public update(): void {
    if (!this.interactor) return;
    const view = this.context.renderer.getCameraView();
    this.interactor.update(view.camera, view.viewport);
  }

  public deactivate(): void {
    this.interactor?.dispose();
    this.interactor = undefined;
  }

  public dispose(): void {
    this.deactivate();
  }
}

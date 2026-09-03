import { MouseGrassInteractor } from '../../grass';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

/** 仅在配置它的场景中，把鼠标轨迹转换为草地弯曲输入。 */
export class MouseGrassInteractionSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'mouse-grass-interaction' as const;
  private interactor?: MouseGrassInteractor;

  public constructor(private readonly context: SceneComponentContext) {
    if (!context.renderer.grassInteractionTarget) {
      throw new Error(
        `场景 ${context.definition.id} 加载了 ${this.type}，但没有可交互草地`,
      );
    }
  }

  public activate(): void {
    if (this.interactor) return;
    const target = this.context.renderer.grassInteractionTarget;
    if (!target) throw new Error(`场景 ${this.context.definition.id} 的草地交互目标已失效`);
    this.interactor = new MouseGrassInteractor(this.context.canvas, target);
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

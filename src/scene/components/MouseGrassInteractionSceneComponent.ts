import { MouseGrassInteractor } from '../../grass';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

/** 仅在配置它的场景中，把鼠标轨迹转换为草地弯曲输入。 */
export class MouseGrassInteractionSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'mouse-grass-interaction' as const;
  private interactor?: MouseGrassInteractor;
  private removeBeforeRender?: () => void;

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
    const interactor = new MouseGrassInteractor(this.context.canvas, target);
    this.interactor = interactor;
    this.removeBeforeRender = this.context.renderer.onBeforeRender((camera) => {
      interactor.update(camera);
    });
  }

  public deactivate(): void {
    this.removeBeforeRender?.();
    this.removeBeforeRender = undefined;
    this.interactor?.dispose();
    this.interactor = undefined;
  }

  public dispose(): void {
    this.deactivate();
  }
}

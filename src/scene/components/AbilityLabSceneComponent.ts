import { AbilityLabController } from '../../abilities/lab';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

/** 能力实验室的输入、模拟、表现与 UI 流程；由场景配置决定是否加载。 */
export class AbilityLabSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'ability-lab' as const;
  private readonly controller: AbilityLabController;

  public constructor(private readonly context: SceneComponentContext) {
    if (!context.player) {
      throw new Error(`场景 ${context.definition.id} 加载了 ${this.type}，但没有玩家实体`);
    }
    this.controller = new AbilityLabController({
      input: context.input,
      uiRoot: context.uiRoot,
      addWorldObject: (object) => context.renderer.addWorldObject(object),
      removeWorldObject: (object) => context.renderer.removeWorldObject(object),
    });
  }

  public activate(): void {
    const player = this.context.player;
    if (player) this.controller.activate(player, player.object3D);
  }

  public deactivate(): void {
    this.controller.deactivate();
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.controller.update(deltaSeconds, elapsedSeconds);
  }

  public dispose(): void {
    this.controller.dispose();
  }
}

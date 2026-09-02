import type { Actor } from '../../../shared/actor/Actor.mjs';

import { AbilityLabController } from '../../abilities/lab';
import type { SceneComponentDefinition } from '../../scenes/data/SceneDefinition';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

type AbilityLabDefinition = Extract<SceneComponentDefinition, { type: 'ability-lab' }>;

/** 能力实验室的输入、模拟、表现与 UI 流程；由场景配置决定是否加载。 */
export class AbilityLabSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'ability-lab' as const;
  private readonly controller: AbilityLabController;
  private boundTarget?: Actor;
  private active = false;

  public constructor(
    private readonly definition: AbilityLabDefinition,
    private readonly context: SceneComponentContext,
  ) {
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
    this.active = true;
    this.syncTarget();
  }

  public deactivate(): void {
    this.active = false;
    this.boundTarget = undefined;
    this.controller.deactivate();
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.syncTarget();
    this.controller.update(deltaSeconds, elapsedSeconds);
  }

  public dispose(): void {
    this.controller.dispose();
  }

  private syncTarget(): void {
    if (!this.active) return;
    const target = this.context.renderer.getActor(this.definition.targetActorId);
    if (target === this.boundTarget) return;
    this.controller.deactivate();
    this.boundTarget = undefined;
    if (!target) return;
    const render = this.context.renderer.getActorRenderProxy(this.definition.targetActorId);
    if (!render?.abilityTargetRig) {
      throw new Error(
        `能力实验室目标 Actor ${this.definition.targetActorId} 缺少训练假人视觉 rig`,
      );
    }
    const player = this.context.player;
    if (!player) return;
    this.controller.activate(player, player.renderPosition, target, render);
    this.boundTarget = target;
  }
}

import type { Actor } from '../../../shared/actor/Actor.mjs';

import { AbilityLabController } from '../../abilities/lab';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../../actors/components/RenderProxyComponent';
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
      render: context.renderer,
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
    const target = this.context.world.getActor(this.definition.targetActorId);
    if (target === this.boundTarget) return;
    this.controller.deactivate();
    this.boundTarget = undefined;
    if (!target) return;
    // 这里原来是 `getActorRenderProxy`：拿到活的 proxy，检查它身上有没有训练假人的
    // rig，再把 rig 交出去。现在只取一个整数——rig 在渲染世界里，缺了由那一侧报错。
    const proxy = target.getComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent | undefined;
    if (!proxy) {
      throw new Error(`能力实验室目标 Actor ${this.definition.targetActorId} 没有渲染 proxy`);
    }
    const player = this.context.player;
    if (!player) return;
    this.controller.activate(player, player.renderPosition, target, proxy.proxyId);
    this.boundTarget = target;
  }
}

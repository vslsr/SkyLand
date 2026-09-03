import type { Actor } from '../../../shared/actor/Actor.mjs';
import { NULL_PROXY_ID, type ProxyId } from '../../render/RenderScene';
import { PlayerInputTags, type InputSubsystem } from '../../input/index';
import { AbilityLabPanel } from '../../ui/AbilityLabPanel';
import {
  AbilityLabSimulation,
  type AbilityLabAction,
  type AbilityLabViewState,
} from './AbilityLabSimulation';

/**
 * 能力实验室要往渲染世界发的三条命令（引擎迁移路线图 第 3 步）。
 *
 * 这里原来收的是 `addWorldObject` / `removeWorldObject`——把自己建的 `Object3D`
 * 塞进场景图，还得先 `getActorRenderProxy` 拿到活的 proxy 才动得了目标身上的 rig。
 * 那是玩法侧最后一处递出活对象的地方。
 *
 * 现在整套动画在渲染世界里，这一侧只说：绑谁、这一帧什么状态、放一次技能。
 * 三个方法都返回 `void`。
 */
export interface AbilityLabRenderPort {
  setAbilityLabTarget(id: ProxyId): void;
  setAbilityLabState(
    state: AbilityLabViewState | undefined,
    casterX: number,
    casterY: number,
    casterZ: number,
  ): void;
  playAbilityLabAction(
    action: AbilityLabAction,
    casterX: number,
    casterY: number,
    casterZ: number,
    succeeded: boolean,
  ): void;
}

export interface AbilityLabControllerOptions {
  readonly input: InputSubsystem;
  readonly uiRoot: HTMLElement;
  readonly render: AbilityLabRenderPort;
}

/** 把语义输入、Component 模拟、线稿表现与 HUD 组合起来；各子模块仍可独立测试。 */
export class AbilityLabController {
  private readonly panel: AbilityLabPanel;
  private readonly inputDisposers: Array<() => void> = [];
  private readonly render: AbilityLabRenderPort;
  private simulation?: AbilityLabSimulation;
  private casterPosition?: { readonly x: number; readonly y: number; readonly z: number };

  public constructor(options: AbilityLabControllerOptions) {
    this.render = options.render;
    this.panel = new AbilityLabPanel(options.uiRoot);
    this.panel.onAction((action) => this.handleAction(action));
    const triggered = { phases: ['triggered'] as const };
    this.inputDisposers.push(
      options.input.bind(PlayerInputTags.AbilityArcane, () => this.handleAction('arcane'), triggered),
      options.input.bind(PlayerInputTags.AbilityBurn, () => this.handleAction('burn'), triggered),
      options.input.bind(PlayerInputTags.AbilityRage, () => this.handleAction('rage'), triggered),
      options.input.bind(PlayerInputTags.AbilitySilence, () => this.handleAction('silence'), triggered),
      options.input.bind(PlayerInputTags.AbilityReset, () => this.handleAction('reset'), triggered),
    );
  }

  public get active(): boolean {
    return Boolean(this.simulation);
  }

  /**
   * `casterPosition` 是一个活引用，不是 Object3D：施法者的位置在玩法侧是几个数，
   * 这里只需要每帧读它，不需要认识渲染世界里的任何节点。
   */
  public activate(
    casterActor: Actor,
    casterPosition: { readonly x: number; readonly y: number; readonly z: number },
    targetActor: Actor,
    targetProxyId: ProxyId,
  ): void {
    this.deactivate();
    // 目标只以 ProxyId 过去；rig 在渲染世界里，缺了由那一侧当场报错。
    this.render.setAbilityLabTarget(targetProxyId);
    try {
      this.casterPosition = casterPosition;
      this.simulation = new AbilityLabSimulation(casterActor, targetActor);
      this.panel.setVisible(true);
      this.panel.setState(this.simulation.createViewState());
    } catch (error) {
      this.render.setAbilityLabTarget(NULL_PROXY_ID);
      this.casterPosition = undefined;
      throw error;
    }
  }

  public deactivate(): void {
    this.simulation?.dispose();
    this.simulation = undefined;
    this.casterPosition = undefined;
    this.render.setAbilityLabState(undefined, 0, 0, 0);
    this.render.setAbilityLabTarget(NULL_PROXY_ID);
    this.panel.setVisible(false);
  }

  public update(deltaSeconds: number, _elapsedSeconds: number): void {
    if (!this.simulation || !this.casterPosition) return;
    this.simulation.update(deltaSeconds);
    const state = this.simulation.createViewState();
    // 帧步不用送：渲染世界在 updateVisuals 里本来就有 dt 与 elapsed。
    this.render.setAbilityLabState(
      state,
      this.casterPosition.x,
      this.casterPosition.y,
      this.casterPosition.z,
    );
    this.panel.setState(state);
  }

  public dispose(): void {
    this.deactivate();
    for (const dispose of this.inputDisposers.splice(0)) dispose();
    this.panel.dispose();
  }

  private handleAction(action: AbilityLabAction): void {
    if (!this.simulation || !this.casterPosition) return;
    const { x, y, z } = this.casterPosition;
    if (action === 'reset') {
      this.simulation.reset();
      this.render.playAbilityLabAction('reset', x, y, z, true);
      this.panel.setState(this.simulation.createViewState());
      return;
    }
    const succeeded = this.simulation.activate(action);
    this.render.playAbilityLabAction(action, x, y, z, succeeded);
    this.panel.setState(this.simulation.createViewState());
  }
}

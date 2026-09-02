import * as THREE from 'three';
import type { Actor } from '../../../shared/actor/Actor.mjs';
import type { ThreeMeshProxy } from '../../render/three/ThreeMeshProxy';
import { PlayerInputTags, type InputSubsystem } from '../../input/index';
import { AbilityLabPanel } from '../../ui/AbilityLabPanel';
import {
  AbilityLabSimulation,
  type AbilityLabAction,
} from './AbilityLabSimulation';
import { AbilityLabVisualSystem } from './AbilityLabVisualSystem';

export interface AbilityLabControllerOptions {
  readonly input: InputSubsystem;
  readonly uiRoot: HTMLElement;
  readonly addWorldObject: (object: THREE.Object3D) => void;
  readonly removeWorldObject: (object: THREE.Object3D) => void;
}

/** 把语义输入、Component 模拟、线稿表现与 HUD 组合起来；各子模块仍可独立测试。 */
export class AbilityLabController {
  private readonly panel: AbilityLabPanel;
  private readonly visuals = new AbilityLabVisualSystem();
  private readonly inputDisposers: Array<() => void> = [];
  private readonly sourcePosition = new THREE.Vector3();
  private readonly addWorldObject: (object: THREE.Object3D) => void;
  private readonly removeWorldObject: (object: THREE.Object3D) => void;
  private simulation?: AbilityLabSimulation;
  private casterPosition?: { readonly x: number; readonly y: number; readonly z: number };

  public constructor(options: AbilityLabControllerOptions) {
    this.addWorldObject = options.addWorldObject;
    this.removeWorldObject = options.removeWorldObject;
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
    targetRender: ThreeMeshProxy,
  ): void {
    this.deactivate();
    this.visuals.bindTarget(targetRender);
    try {
      this.casterPosition = casterPosition;
      this.simulation = new AbilityLabSimulation(casterActor, targetActor);
      this.visuals.reset();
      this.addWorldObject(this.visuals.root);
      this.panel.setVisible(true);
      this.panel.setState(this.simulation.createViewState());
    } catch (error) {
      this.visuals.unbindTarget();
      this.casterPosition = undefined;
      throw error;
    }
  }

  public deactivate(): void {
    this.simulation?.dispose();
    this.simulation = undefined;
    this.casterPosition = undefined;
    this.visuals.reset();
    this.visuals.unbindTarget();
    this.removeWorldObject(this.visuals.root);
    this.panel.setVisible(false);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (!this.simulation || !this.casterPosition) return;
    this.simulation.update(deltaSeconds);
    const state = this.simulation.createViewState();
    this.sourcePosition.set(this.casterPosition.x, this.casterPosition.y, this.casterPosition.z);
    this.visuals.update(deltaSeconds, elapsedSeconds, state, this.sourcePosition);
    this.panel.setState(state);
  }

  public dispose(): void {
    this.deactivate();
    for (const dispose of this.inputDisposers.splice(0)) dispose();
    this.panel.dispose();
    this.visuals.dispose();
  }

  private handleAction(action: AbilityLabAction): void {
    if (!this.simulation || !this.casterPosition) return;
    if (action === 'reset') {
      this.simulation.reset();
      this.visuals.reset();
      this.panel.setState(this.simulation.createViewState());
      return;
    }
    const succeeded = this.simulation.activate(action);
    this.sourcePosition.set(this.casterPosition.x, this.casterPosition.y, this.casterPosition.z);
    this.visuals.play(action, this.sourcePosition, succeeded);
    this.panel.setState(this.simulation.createViewState());
  }
}

import * as THREE from 'three';
import type { Actor } from '../../../shared/actor/Actor.mjs';
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
  private casterObject?: THREE.Object3D;

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

  public activate(casterActor: Actor, casterObject: THREE.Object3D): void {
    this.deactivate();
    this.casterObject = casterObject;
    this.simulation = new AbilityLabSimulation(casterActor);
    this.visuals.reset();
    this.addWorldObject(this.visuals.root);
    this.panel.setVisible(true);
    this.panel.setState(this.simulation.createViewState());
  }

  public deactivate(): void {
    if (!this.simulation) return;
    this.simulation.dispose();
    this.simulation = undefined;
    this.casterObject = undefined;
    this.visuals.reset();
    this.removeWorldObject(this.visuals.root);
    this.panel.setVisible(false);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (!this.simulation || !this.casterObject) return;
    this.simulation.update(deltaSeconds);
    const state = this.simulation.createViewState();
    this.casterObject.getWorldPosition(this.sourcePosition);
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
    if (!this.simulation || !this.casterObject) return;
    if (action === 'reset') {
      this.simulation.reset();
      this.visuals.reset();
      this.panel.setState(this.simulation.createViewState());
      return;
    }
    const succeeded = this.simulation.activate(action);
    this.casterObject.getWorldPosition(this.sourcePosition);
    this.visuals.play(action, this.sourcePosition, succeeded);
    this.panel.setState(this.simulation.createViewState());
  }
}

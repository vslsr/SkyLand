import type * as THREE from 'three';
import { TopDownController } from '../controllers/TopDownController';
import type { InputSubsystem } from '../input/index';
import type { SceneBounds } from '../scenes/data/SceneDefinition';
import { createPlayerSlimeModel } from '../models/playerSlime';
import { PlayerReconciler } from './PlayerReconciler';
import { SlimeAnimator } from './SlimeAnimator';

export class PlayerEntity {
  public readonly model = createPlayerSlimeModel();
  public readonly controller: TopDownController;
  private readonly animator = new SlimeAnimator(this.model);
  private readonly reconciler = new PlayerReconciler();

  public constructor(
    canvas: HTMLCanvasElement,
    spawn: { x: number; z: number },
    input: InputSubsystem,
    bounds: SceneBounds,
  ) {
    this.model.root.name = 'local-player-slime';
    this.model.root.position.set(spawn.x, 0, spawn.z);
    this.controller = new TopDownController(canvas, this.model.root, input, { enabled: false, bounds });
  }

  public get object3D(): THREE.Object3D {
    return this.model.root;
  }

  /** 每发出一条输入就记下当时的预测位置，供之后和服务器对账。 */
  public recordPrediction(sequence: number): void {
    const { x, z } = this.controller.position;
    this.reconciler.recordPrediction(sequence, x, z);
  }

  /** 快照里属于自己的那条权威状态。 */
  public applyAuthoritativeState(sequence: number, x: number, z: number): void {
    this.reconciler.acceptAuthoritative(sequence, x, z, this.controller);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.reconciler.update(deltaSeconds, this.controller);
    this.animator.update(deltaSeconds, elapsedSeconds, this.controller.movementSpeed);
  }

  public dispose(): void {
    this.controller.dispose();
    this.reconciler.reset();
    this.model.root.parent?.remove(this.model.root);
  }
}

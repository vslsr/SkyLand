import type * as THREE from 'three';
import { Actor } from '../../shared/actor/Actor.mjs';
import {
  GrassDisplacementComponent,
} from '../actors/components/GrassDisplacementComponent';
import { TopDownController } from '../controllers/TopDownController';
import type { GrassInteractionTarget } from '../grass';
import type { InputSubsystem } from '../input/index';
import type { SceneBounds } from '../scenes/data/SceneDefinition';
import { createPlayerSlimeModel } from '../models/playerSlime';
import { PlayerReconciler } from './PlayerReconciler';
import { SlimeAnimator } from './SlimeAnimator';

interface PlayerWorldInteraction extends GrassInteractionTarget {
  resolveSimpleCollision?(
    position: { x: number; z: number },
    radius: number,
  ): { x: number; z: number };
  /** 第三人称相机悬臂的遮挡探针，见 SceneRenderer.sweepCameraProbe。 */
  sweepCameraProbe?(
    start: readonly [number, number, number],
    end: readonly [number, number, number],
    radius: number,
  ): number;
}

export class PlayerEntity extends Actor {
  public readonly model = createPlayerSlimeModel();
  public readonly controller: TopDownController;
  private readonly animator = new SlimeAnimator(this.model);
  private readonly reconciler = new PlayerReconciler();
  private readonly grassDisplacement: GrassDisplacementComponent;

  public constructor(
    playerId: string,
    canvas: HTMLCanvasElement,
    spawn: { x: number; z: number },
    input: InputSubsystem,
    bounds: SceneBounds,
    grassInteraction: PlayerWorldInteraction,
  ) {
    super(playerId, 'player-slime');
    const cameraProbe = grassInteraction.sweepCameraProbe?.bind(grassInteraction);
    this.model.root.name = 'local-player-slime';
    this.model.root.position.set(spawn.x, 0, spawn.z);
    this.controller = new TopDownController(canvas, this.model.root, input, {
      enabled: false,
      bounds,
      collisionRadius: this.model.radius,
      resolveCollision: (position, radius) => (
        grassInteraction.resolveSimpleCollision?.(position, radius) ?? position
      ),
      cameraProbe,
    });
    this.grassDisplacement = this.addComponent(new GrassDisplacementComponent(
      this.model.root,
      grassInteraction,
      { radius: this.model.radius * 1.65 },
    )) as GrassDisplacementComponent;
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
    this.grassDisplacement.update(deltaSeconds);
  }

  public override dispose(): void {
    this.controller.dispose();
    this.reconciler.reset();
    super.dispose();
    this.model.root.parent?.remove(this.model.root);
  }
}

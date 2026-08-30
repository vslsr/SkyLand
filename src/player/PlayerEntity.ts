import type * as THREE from 'three';
import { TopDownController } from '../controllers/TopDownController';
import { createPlayerSlimeModel } from '../models/playerSlime';
import { SlimeAnimator } from './SlimeAnimator';

export class PlayerEntity {
  public readonly model = createPlayerSlimeModel();
  public readonly controller: TopDownController;
  private readonly animator = new SlimeAnimator(this.model);

  public constructor(canvas: HTMLCanvasElement) {
    this.model.root.position.set(0, 0, 8);
    this.controller = new TopDownController(canvas, this.model.root, { enabled: false });
  }

  public get object3D(): THREE.Object3D {
    return this.model.root;
  }

  public updateAnimation(deltaSeconds: number, elapsedSeconds: number): void {
    this.animator.update(deltaSeconds, elapsedSeconds, this.controller.movementSpeed);
  }

  public dispose(): void {
    this.controller.dispose();
    this.model.root.removeFromParent();
  }
}

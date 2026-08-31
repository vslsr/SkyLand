import * as THREE from 'three';
import { Actor, PlayerMovementComponent } from '../../shared/actor/index.mjs';
import { GrassDisplacementComponent } from '../actors/components/GrassDisplacementComponent';
import type { GrassInteractionTarget } from '../grass';
import { createPlayerSlimeModel, createSlimePalette } from '../models/playerSlime';
import type { InterpolatedPlayerState } from '../network/protocol';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import { SlimeAnimator } from './SlimeAnimator';

function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const target = object as Partial<THREE.Mesh>;
    target.geometry?.dispose();
    const material = target.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
}

/** 同房间的另一名玩家：状态全部来自快照插值，本地不做任何模拟。 */
export class RemotePlayer extends Actor {
  public name: string;
  private readonly model: ReturnType<typeof createPlayerSlimeModel>;
  private readonly animator: SlimeAnimator;
  private speed = 0;

  private readonly grassDisplacement: GrassDisplacementComponent;

  public constructor(
    state: InterpolatedPlayerState,
    grassInteraction: GrassInteractionTarget,
    archetype: ActorArchetypeDefinition,
  ) {
    super(state.id, archetype.id);
    if (!archetype.components.playerMovement || archetype.components.render.model !== 'line-art-player-slime') {
      throw new Error(`玩家 Actor 原型无效：${archetype.id}`);
    }
    const movement = this.addComponent(new PlayerMovementComponent(
      archetype.components.playerMovement,
    )) as PlayerMovementComponent;
    this.name = state.name;
    this.model = createPlayerSlimeModel(
      archetype.components.render,
      createSlimePalette(state.id),
    );
    this.model.root.name = `remote-player-${state.id}`;
    this.model.root.position.set(state.x, 0, state.z);
    this.model.root.rotation.y = state.yaw;
    this.animator = new SlimeAnimator(this.model, movement.walkSpeed);
    this.grassDisplacement = this.addComponent(new GrassDisplacementComponent(
      this.model.root,
      grassInteraction,
      { radius: this.model.radius * 1.65 },
    )) as GrassDisplacementComponent;
  }

  public get object3D(): THREE.Object3D {
    return this.model.root;
  }

  public applyState(state: InterpolatedPlayerState): void {
    this.name = state.name;
    // 位置与朝向都已经在 SnapshotBuffer 里按渲染时间插值过，这里直接落到模型上。
    this.model.root.position.set(state.x, 0, state.z);
    this.model.root.rotation.y = state.yaw;
    this.speed = state.speed;
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.animator.update(deltaSeconds, elapsedSeconds, this.speed);
    this.grassDisplacement.update(deltaSeconds);
  }

  public override dispose(): void {
    super.dispose();
    this.model.root.parent?.remove(this.model.root);
    disposeSubtree(this.model.root);
  }
}

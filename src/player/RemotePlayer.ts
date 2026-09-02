import type * as THREE from 'three';
import {
  Actor,
  BuoyancyComponent,
  PlayerMovementComponent,
} from '../../shared/actor/index.mjs';
import { GrassDisplacementComponent } from '../actors/components/GrassDisplacementComponent';
import type { GrassInteractionTarget } from '../grass';
import type { ActorVisualModel } from '../models/actors/ActorVisualModel';
import { createSlimePalette } from '../models/playerSlime';
import type { InterpolatedPlayerState } from '../network/protocol';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import {
  createPlayerActorVisual,
  isPlayerActorRenderDefinition,
  type PlayerActorVisual,
} from './PlayerActorVisual';
import { createObjectPositionSampler } from './objectPositionSampler';

/** 同房间的另一名玩家：位置来自快照插值；混合软体只做不回写状态的客户端表现。 */
export class RemotePlayer extends Actor {
  public name: string;
  private readonly model: ActorVisualModel;
  private readonly visual: PlayerActorVisual;
  private readonly buoyancy?: BuoyancyComponent;
  private speed = 0;
  private verticalVelocity = 0;
  private grounded = true;

  private readonly grassDisplacement: GrassDisplacementComponent;

  public constructor(
    state: InterpolatedPlayerState,
    private readonly grassInteraction: GrassInteractionTarget & {
      sampleGroundHeight?(x: number, z: number): number;
      samplePlayerHeight?(x: number, z: number, buoyancyDraft?: number): number;
    },
    archetype: ActorArchetypeDefinition,
  ) {
    super(state.id, archetype.id);
    const render = archetype.components.render;
    if (!archetype.components.playerMovement || !isPlayerActorRenderDefinition(render)) {
      throw new Error(`玩家 Actor 原型无效：${archetype.id}`);
    }
    const movement = this.addComponent(new PlayerMovementComponent(
      archetype.components.playerMovement,
    )) as PlayerMovementComponent;
    this.buoyancy = archetype.components.buoyancy
      ? this.addComponent(new BuoyancyComponent(archetype.components.buoyancy)) as BuoyancyComponent
      : undefined;
    this.name = state.name;
    this.visual = createPlayerActorVisual(
      state.id,
      render,
      movement.walkSpeed,
      render.model === 'line-art-player-slime' ? createSlimePalette(state.id) : undefined,
    );
    this.model = this.visual.model;
    if (this.visual.component) this.addComponent(this.visual.component);
    this.model.root.name = `remote-player-${state.id}`;
    this.model.root.position.set(
      state.x,
      state.y ?? this.sampleHeight(state.x, state.z),
      state.z,
    );
    this.model.root.rotation.y = state.yaw;
    this.verticalVelocity = state.verticalVelocity ?? 0;
    this.grounded = state.grounded ?? true;
    this.grassDisplacement = this.addComponent(new GrassDisplacementComponent(
      createObjectPositionSampler(this.model.root),
      grassInteraction,
      { radius: this.visual.radius * 1.65 },
    )) as GrassDisplacementComponent;
  }

  public get object3D(): THREE.Object3D {
    return this.model.root;
  }

  /** 本地物理世界里给这名远端玩家建代理时用的圆柱尺寸。 */
  public get collisionShape(): { radius: number, height: number } {
    return { radius: this.visual.collisionRadius, height: this.visual.collisionHeight };
  }

  /** 快照插值后的脚底位置，供碰撞代理跟随。 */
  public get feetPosition(): { x: number, y: number, z: number } {
    const position = this.model.root.position;
    return { x: position.x, y: position.y, z: position.z };
  }

  public applyState(state: InterpolatedPlayerState): void {
    this.name = state.name;
    // 位置与朝向都已经在 SnapshotBuffer 里按渲染时间插值过，这里直接落到模型上。
    this.model.root.position.set(
      state.x,
      this.model.root.position.y,
      state.z,
    );
    this.model.root.position.y = state.y ?? this.sampleHeight(state.x, state.z);
    this.model.root.rotation.y = state.yaw;
    this.speed = state.speed;
    this.verticalVelocity = state.verticalVelocity ?? 0;
    this.grounded = state.grounded ?? (state.y === undefined);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.visual.update(
      deltaSeconds,
      elapsedSeconds,
      this.speed,
      this.model.root.rotation.y,
      {
        velocityX: Math.sin(this.model.root.rotation.y) * this.speed,
        velocityZ: Math.cos(this.model.root.rotation.y) * this.speed,
        verticalVelocity: this.verticalVelocity,
        grounded: this.grounded,
      },
    );
    this.grassDisplacement.update(deltaSeconds);
  }

  private sampleHeight(x: number, z: number): number {
    if (this.buoyancy && this.grassInteraction.samplePlayerHeight) {
      return this.grassInteraction.samplePlayerHeight(x, z, this.buoyancy.draft);
    }
    return this.grassInteraction.sampleGroundHeight?.(x, z) ?? 0;
  }

  public override dispose(): void {
    super.dispose();
    this.model.root.parent?.remove(this.model.root);
    this.visual.dispose();
  }
}

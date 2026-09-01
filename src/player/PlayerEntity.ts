import type * as THREE from 'three';
import {
  Actor,
  BuoyancyComponent,
  PlayerJumpComponent,
  PlayerMovementComponent,
} from '../../shared/actor/index.mjs';
import {
  GrassDisplacementComponent,
} from '../actors/components/GrassDisplacementComponent';
import {
  createDefaultSlimeSurfaceDragDefinition,
  SlimeSurfaceDragComponent,
} from '../actors/components/SlimeSurfaceDragComponent';
import { SlimeSurfaceDragController } from '../controllers/SlimeSurfaceDragController';
import {
  TopDownController,
  type PlayerCollisionMotion,
} from '../controllers/TopDownController';
import type { GrassInteractionTarget } from '../grass';
import type { InputSubsystem } from '../input/index';
import type {
  ActorArchetypeDefinition,
  SceneBounds,
} from '../scenes/data/SceneDefinition';
import type { ActorVisualModel } from '../models/actors/ActorVisualModel';
import {
  createPlayerActorVisual,
  isPlayerActorRenderDefinition,
  type PlayerActorVisual,
} from './PlayerActorVisual';
import { PlayerReconciler } from './PlayerReconciler';
import { GameAbilityComponent } from '../abilities/index';
import {
  WaterMovementEffectController,
  createPlayerMovementAttributes,
} from '../../shared/abilities/playerMovementEffects.mjs';
import { PlayerBuoyancyHeightController } from './PlayerBuoyancyHeightController';

interface PlayerWorldInteraction extends GrassInteractionTarget {
  resolveSimpleCollision?(
    position: { x: number; z: number },
    radius: number,
    maximumStepHeight: number,
    moverHeight: number,
    from?: { x: number; z: number },
    buoyancyDraft?: number,
    motion?: PlayerCollisionMotion,
  ): { x: number; y?: number; z: number };
  sampleGroundHeight?(x: number, z: number): number;
  samplePlayerHeight?(x: number, z: number, buoyancyDraft?: number): number;
  isWaterAt?(x: number, z: number): boolean;
  raycastGround?(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number } | undefined;
  /** 第三人称相机悬臂的遮挡探针，见 SceneRenderer.sweepCameraProbe。 */
  sweepCameraProbe?(
    start: readonly [number, number, number],
    end: readonly [number, number, number],
    radius: number,
  ): number;
}

export class PlayerEntity extends Actor {
  public readonly model: ActorVisualModel;
  public readonly controller: TopDownController;
  private readonly visual: PlayerActorVisual;
  private readonly reconciler = new PlayerReconciler();
  private readonly grassDisplacement: GrassDisplacementComponent;
  private readonly slimeSurfaceDragController?: SlimeSurfaceDragController;
  private readonly gameAbility: GameAbilityComponent;
  private readonly waterMovementEffect: WaterMovementEffectController;
  private readonly jumpAbility: PlayerJumpComponent;
  private readonly buoyancyHeight?: PlayerBuoyancyHeightController;
  private readonly isWaterAt?: (x: number, z: number) => boolean;

  public constructor(
    playerId: string,
    canvas: HTMLCanvasElement,
    spawn: { x: number; z: number },
    input: InputSubsystem,
    bounds: SceneBounds,
    grassInteraction: PlayerWorldInteraction,
    archetype: ActorArchetypeDefinition,
  ) {
    super(playerId, archetype.id);
    const render = archetype.components.render;
    if (!archetype.components.playerMovement || !isPlayerActorRenderDefinition(render)) {
      throw new Error(`玩家 Actor 原型无效：${archetype.id}`);
    }
    const movement = this.addComponent(new PlayerMovementComponent(
      archetype.components.playerMovement,
    )) as PlayerMovementComponent;
    this.jumpAbility = this.addComponent(new PlayerJumpComponent(
      archetype.components.playerJump,
    )) as PlayerJumpComponent;
    this.gameAbility = this.addComponent(new GameAbilityComponent({
      attributes: createPlayerMovementAttributes(movement.walkSpeed),
    })) as GameAbilityComponent;
    this.waterMovementEffect = new WaterMovementEffectController(
      this.gameAbility.abilitySystem,
    );
    const buoyancy = archetype.components.buoyancy
      ? this.addComponent(new BuoyancyComponent(archetype.components.buoyancy)) as BuoyancyComponent
      : undefined;
    this.visual = createPlayerActorVisual(playerId, render, movement.walkSpeed);
    this.model = this.visual.model;
    if (this.visual.component) this.addComponent(this.visual.component);
    // 纯客户端交互不能依赖房间进程是否已重载最新 ActorCatalog；PBF 表现存在就装配，
    // 新原型优先使用作者参数，旧房间下发的原型则回退到与当前 JSON 等价的比例值。
    const slimeSurfaceDrag = this.visual.component
      ? this.addComponent(new SlimeSurfaceDragComponent(
        this.visual.component.rig,
        this.visual.component.simulation,
        archetype.components.slimeSurfaceDrag
          ?? createDefaultSlimeSurfaceDragDefinition(this.visual.radius),
      )) as SlimeSurfaceDragComponent
      : undefined;
    const cameraProbe = grassInteraction.sweepCameraProbe?.bind(grassInteraction);
    const sampleGroundHeight = grassInteraction.sampleGroundHeight?.bind(grassInteraction);
    const sampleBasePlayerHeight = buoyancy && grassInteraction.samplePlayerHeight
      ? (x: number, z: number): number => grassInteraction.samplePlayerHeight!(x, z, buoyancy.draft)
      : sampleGroundHeight;
    this.isWaterAt = grassInteraction.isWaterAt?.bind(grassInteraction);
    this.buoyancyHeight = buoyancy && sampleBasePlayerHeight
      ? new PlayerBuoyancyHeightController(
          this.model.root,
          sampleBasePlayerHeight,
          buoyancy.bobAmplitude,
        )
      : undefined;
    const samplePlayerHeight = this.buoyancyHeight?.sampleHeight ?? sampleBasePlayerHeight;
    const raycastGround = grassInteraction.raycastGround?.bind(grassInteraction);
    this.model.root.name = 'local-player-slime';
    this.model.root.position.set(spawn.x, samplePlayerHeight?.(spawn.x, spawn.z) ?? 0, spawn.z);
    this.controller = new TopDownController(canvas, this.model.root, input, {
      enabled: false,
      bounds,
      collisionRadius: this.visual.collisionRadius,
      movement,
      jumpAbility: this.jumpAbility,
      updateMovementState: () => this.waterMovementEffect.sync(
        this.jumpAbility.grounded
          && (grassInteraction.isWaterAt?.(
            this.model.root.position.x,
            this.model.root.position.z,
          ) ?? false),
      ),
      resolveWalkSpeed: () => this.waterMovementEffect.moveSpeed,
      resolveCollision: (position, radius, from, motion) => (
        grassInteraction.resolveSimpleCollision?.(
          position,
          radius,
          movement.maximumStepHeight,
          this.visual.collisionHeight,
          from,
          buoyancy?.draft,
          motion,
        ) ?? position
      ),
      sampleGroundHeight: samplePlayerHeight,
      raycastGround,
      cameraProbe,
    });
    this.slimeSurfaceDragController = slimeSurfaceDrag
      ? new SlimeSurfaceDragController(
          canvas,
          input,
          slimeSurfaceDrag,
          () => this.controller.frame,
          (active) => this.controller.setMouseFacingSuppressed(active),
        )
      : undefined;
    this.grassDisplacement = this.addComponent(new GrassDisplacementComponent(
      this.model.root,
      grassInteraction,
      { radius: this.visual.radius * 1.65 },
    )) as GrassDisplacementComponent;
  }

  public get object3D(): THREE.Object3D {
    return this.model.root;
  }

  /** 每发出一条输入就记下当时的预测位置，供之后和服务器对账。 */
  public recordPrediction(sequence: number): void {
    const { x, z } = this.controller.position;
    this.reconciler.recordPrediction(sequence, x, z, this.controller.verticalPosition);
  }

  /** 快照里属于自己的那条权威状态。 */
  public applyAuthoritativeState(
    sequence: number,
    x: number,
    z: number,
    y?: number,
    verticalVelocity?: number,
    grounded?: boolean,
  ): void {
    if (y !== undefined && grounded !== false) {
      this.buoyancyHeight?.setAuthoritativeHeight(x, z, y);
    }
    const accepted = this.reconciler.acceptAuthoritative(
      sequence,
      x,
      z,
      this.controller,
      y,
    );
    if (
      accepted
      && grounded !== undefined
      && verticalVelocity !== undefined
      && (
        grounded !== this.jumpAbility.grounded
        || (!grounded && Math.abs(verticalVelocity - this.jumpAbility.verticalVelocity) > 2)
      )
    ) {
      this.jumpAbility.applyAuthoritativeState(verticalVelocity, grounded);
    }
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.gameAbility.update(deltaSeconds);
    this.reconciler.update(deltaSeconds, this.controller);
    this.buoyancyHeight?.update(
      deltaSeconds,
      this.isWaterAt?.(this.model.root.position.x, this.model.root.position.z) ?? false,
      this.controller.isGrounded,
    );
    this.slimeSurfaceDragController?.update();
    const input = this.controller.inputFrame;
    const movementSpeed = this.controller.movementSpeed;
    this.visual.update(
      deltaSeconds,
      elapsedSeconds,
      movementSpeed,
      this.model.root.rotation.y,
      {
        velocityX: input.move.x * movementSpeed,
        velocityZ: input.move.z * movementSpeed,
        verticalVelocity: this.controller.verticalVelocity,
        grounded: this.controller.isGrounded,
        collisionDisplacement: this.controller.consumeCollisionDisplacement(),
      },
    );
    this.grassDisplacement.update(deltaSeconds);
  }

  public override dispose(): void {
    this.waterMovementEffect.dispose();
    this.slimeSurfaceDragController?.dispose();
    this.controller.dispose();
    this.reconciler.reset();
    super.dispose();
    this.model.root.parent?.remove(this.model.root);
    this.visual.dispose();
  }
}

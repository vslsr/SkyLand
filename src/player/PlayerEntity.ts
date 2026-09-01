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
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import type { PlayerInputStep } from '../network/protocol';
import { MAXIMUM_PENDING_INPUT_STEPS } from '../../shared/networkTuning.mjs';

export interface PlayerTransformDebugState {
  logic: { x: number; y: number; z: number };
  render: { x: number; y: number; z: number; yaw: number };
  velocity: { x: number; y: number; z: number };
  grounded: boolean;
  pendingInputCount: number;
  firstPendingTick?: number;
  lastPendingTick?: number;
}

export interface PlayerAuthoritativeApplyResult {
  applied: boolean;
  reason: 'reconciled' | 'stale-ack' | 'incomplete-authority';
  ackTick: number;
  pendingBefore: number;
  pendingAfter: number;
  replayed?: number;
  residualDistance?: number;
  snapped?: boolean;
}

interface PlayerWorldInteraction extends GrassInteractionTarget {
  sampleGroundHeight?(x: number, z: number): number;
  samplePlayerHeight?(x: number, z: number, buoyancyDraft?: number): number;
  isWaterAt?(x: number, z: number): boolean;
  getPhysicsWorld?(): PhysicsWorld | undefined;
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
  private readonly pendingInputSteps: PlayerInputStep[] = [];

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
      collisionHeight: this.visual.collisionHeight,
      movement,
      jumpAbility: this.jumpAbility,
      physicsWorld: grassInteraction.getPhysicsWorld?.(),
      characterId: playerId,
      updateMovementState: () => this.waterMovementEffect.sync(
        this.jumpAbility.grounded
          && (grassInteraction.isWaterAt?.(
            this.model.root.position.x,
            this.model.root.position.z,
          ) ?? false),
      ),
      resolveWalkSpeed: () => this.waterMovementEffect.moveSpeed,
      resolveBuoyancyHeight: () => (
        this.isWaterAt?.(this.controller?.position.x ?? spawn.x, this.controller?.position.z ?? spawn.z)
          ? samplePlayerHeight?.(
              this.controller?.position.x ?? spawn.x,
              this.controller?.position.z ?? spawn.z,
            )
          : undefined
      ),
      sampleGroundHeight: samplePlayerHeight,
      raycastGround,
      cameraCollisionEnabled: Boolean(grassInteraction.getPhysicsWorld?.()),
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

  /** 尚未被服务端确认的输入；上行包会重复携带它们来抵抗丢包。 */
  public get unacknowledgedInputSteps(): readonly PlayerInputStep[] {
    return this.pendingInputSteps;
  }

  public captureTransformDebugState(): PlayerTransformDebugState {
    const horizontalVelocity = this.controller.horizontalVelocity;
    return {
      logic: {
        x: this.controller.position.x,
        y: this.controller.verticalPosition,
        z: this.controller.position.z,
      },
      render: {
        x: this.model.root.position.x,
        y: this.model.root.position.y,
        z: this.model.root.position.z,
        yaw: this.model.root.rotation.y,
      },
      velocity: {
        x: horizontalVelocity.x,
        y: this.controller.verticalVelocity,
        z: horizontalVelocity.z,
      },
      grounded: this.controller.isGrounded,
      pendingInputCount: this.pendingInputSteps.length,
      firstPendingTick: this.pendingInputSteps[0]?.tick,
      lastPendingTick: this.pendingInputSteps.at(-1)?.tick,
    };
  }

  /** 快照里属于自己的那条权威状态。 */
  public applyAuthoritativeState(
    ackTick: number,
    x: number,
    z: number,
    y?: number,
    verticalVelocity?: number,
    velocityX?: number,
    velocityZ?: number,
    grounded?: boolean,
  ): PlayerAuthoritativeApplyResult {
    const pendingBefore = this.pendingInputSteps.length;
    if (y !== undefined && grounded !== false) {
      this.buoyancyHeight?.setAuthoritativeHeight(x, z, y);
    }
    if (
      y === undefined
      || grounded === undefined
      || verticalVelocity === undefined
      || velocityX === undefined
      || velocityZ === undefined
    ) {
      return {
        applied: false,
        reason: 'incomplete-authority',
        ackTick,
        pendingBefore,
        pendingAfter: this.pendingInputSteps.length,
      };
    }
    const firstPending = this.pendingInputSteps.findIndex((input) => input.tick > ackTick);
    this.pendingInputSteps.splice(
      0,
      firstPending < 0 ? this.pendingInputSteps.length : firstPending,
    );
    const applied = this.reconciler.acceptAuthoritative(
      ackTick,
      {
        x,
        y,
        z,
        vx: velocityX,
        vy: verticalVelocity,
        vz: velocityZ,
        grounded,
      },
      this.pendingInputSteps,
      this.controller,
    );
    const result = applied ? this.reconciler.latestResult : undefined;
    return {
      applied,
      reason: applied ? 'reconciled' : 'stale-ack',
      ackTick,
      pendingBefore,
      pendingAfter: this.pendingInputSteps.length,
      ...(result ?? {}),
    };
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.pendingInputSteps.push(...this.controller.drainInputSteps());
    if (this.pendingInputSteps.length > MAXIMUM_PENDING_INPUT_STEPS) {
      this.pendingInputSteps.splice(
        0,
        this.pendingInputSteps.length - MAXIMUM_PENDING_INPUT_STEPS,
      );
    }
    this.gameAbility.update(deltaSeconds);
    this.buoyancyHeight?.update(
      deltaSeconds,
      this.isWaterAt?.(this.model.root.position.x, this.model.root.position.z) ?? false,
      this.controller.isGrounded,
    );
    this.slimeSurfaceDragController?.update();
    const movementSpeed = this.controller.movementSpeed;
    const horizontalVelocity = this.controller.horizontalVelocity;
    this.visual.update(
      deltaSeconds,
      elapsedSeconds,
      movementSpeed,
      this.model.root.rotation.y,
      {
        velocityX: horizontalVelocity.x,
        velocityZ: horizontalVelocity.z,
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
    this.pendingInputSteps.length = 0;
    super.dispose();
    this.model.root.parent?.remove(this.model.root);
    this.visual.dispose();
  }
}

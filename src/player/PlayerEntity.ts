import {
  Actor,
  BuoyancyComponent,
  InventoryComponent,
  PlayerJumpComponent,
  PlayerMovementComponent,
  PickupDropComponent,
  sampleBuoyancyBobOffset,
} from '../../shared/actor/index.mjs';
import {
  GrassDisplacementComponent,
} from '../actors/components/GrassDisplacementComponent';
import {
  DEFAULT_TOP_DOWN_CAMERA_OFFSET,
  TopDownController,
} from '../controllers/TopDownController';
import type { Vec3 } from '../math/vec3';
import type { GrassInteractionTarget } from '../grass';
import type { InputSubsystem } from '../input/index';
import type {
  ActorArchetypeDefinition,
  SceneBounds,
} from '../scenes/data/SceneDefinition';
import type { ProxyId, RenderScene } from '../render/RenderScene';
import type { RenderProxyTable, RenderWorldHandle } from '../render/RenderProxyTable';
import type { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import {
  SLIME_MOTION_AT_REST,
  writeSlimeMotionParams,
  type SlimeMotionParams,
} from '../render/RenderSlimeMotion';
import {
  SLIME_DRAG_AT_REST,
  writeSlimeDragParams,
  type SlimeDragParams,
} from '../render/RenderSlimeDrag';
import {
  createSlimeBiteParams,
  writeSlimeBiteParams,
  type SlimeBiteParams,
} from '../render/RenderSlimeBite';
import {
  SLIME_GROUND_PROBE_AT_REST,
  resolveSlimeLegGroundProbeLayout,
  writeSlimeGroundProbeParams,
} from '../render/RenderSlimeLegs';
import { LegGroundProbeComponent } from '../actors/components/LegGroundProbeComponent';
import {
  isPlayerRenderDefinition,
  resolvePlayerVisualShape,
  type PlayerVisualShape,
} from './playerVisualShape';
import { PlayerReconciler } from './PlayerReconciler';
import { GameAbilityComponent } from '../abilities/index';
import {
  WaterMovementEffectController,
  createPlayerMovementAttributes,
} from '../../shared/abilities/playerMovementEffects.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import type {
  PlayerInputStep,
  SnapshotLeash,
  SnapshotSlimeDrag,
} from '../network/protocol';
import {
  MAXIMUM_PENDING_INPUT_STEPS,
  SIMULATION_STEP_SECONDS,
} from '../../shared/networkTuning.mjs';

/** 嚼一口多快，弧度每秒。约每秒两口，快到看得出在嚼，慢到不像发抖。 */
const CHEW_RATE = 12;
/** 每一口抬多高，米。 */
const CHEW_RISE = 0.035;
/** 每一口左右晃多少，米。比抬起来小一半：吃东西是上下的动作。 */
const CHEW_SWAY = 0.018;

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
  corrected?: boolean;
  snapped?: boolean;
}

interface PlayerWorldInteraction extends GrassInteractionTarget {
  sampleGroundHeight?(x: number, z: number): number;
  onTerrainChanged?(listener: () => void): () => void;
  samplePlayerHeight?(x: number, z: number, buoyancyDraft?: number): number;
  isWaterAt?(x: number, z: number): boolean;
  getPhysicsWorld?(): PhysicsWorld | undefined;
  raycastGround?(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number } | undefined;
}

export class PlayerEntity extends Actor {
  public readonly controller: TopDownController;
  /**
   * 本地玩家在渲染世界里的句柄。它和 Actor Replica 的 proxy 出自同一张槽位表，
   * 位置也走同一段 transform SoA——玩家不是 Replica，但它在边界上和别人一样，
   * 只是一个 ProxyId。
   */
  private readonly proxyId: ProxyId;
  /** 槽位表既是分配器也是命令口：销毁和回收槽位必须是同一件事。 */
  private readonly proxyIds: RenderProxyTable;
  private readonly renderScene: RenderScene;
  private readonly transforms: RenderTransformBuffer;
  /**
   * 权威 transform 的**玩法侧**副本，f64。控制器读写的是它，每帧末尾再兑现进
   * 边界那段 f32 SoA。渲染侧那份是镜像，不是源。
   */
  private readonly transform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { y: 0 },
  };
  private readonly motion: SlimeMotionParams = { ...SLIME_MOTION_AT_REST };
  /** 服务端推给自己的形变；今天只有「被别人咬住」一种。 */
  private readonly replicatedDrag: SlimeDragParams = { ...SLIME_DRAG_AT_REST };

  /** 自己正被谁咬着捏出来的那些尖。由 `GrasslandScene` 按两边位置当场算。 */
  private readonly biteTips: SlimeBiteParams = createSlimeBiteParams();
  private readonly visual: PlayerVisualShape;
  private readonly reconciler = new PlayerReconciler();
  private readonly grassDisplacement: GrassDisplacementComponent;
  /** 只有长腿外壳才有：每帧采身体脚下的五个点，供渲染侧的步态落脚。 */
  private readonly legGroundProbe?: LegGroundProbeComponent;
  private readonly gameAbility: GameAbilityComponent;
  private readonly waterMovementEffect: WaterMovementEffectController;
  private readonly jumpAbility: PlayerJumpComponent;
  private readonly isWaterAt?: (x: number, z: number) => boolean;
  private readonly unsubscribeTerrainChanges?: () => void;
  private readonly pendingInputSteps: PlayerInputStep[] = [];
  /**
   * 正在吃东西的那一段有多久了，秒；没在吃时是 undefined。
   *
   * 它**只改这一帧写出去的渲染坐标**，不碰玩法 transform：抖动是表现，不是位移。
   * 写进玩法坐标的话，预测与和解会把这几厘米当成真的走了几厘米，然后每一帧都
   * 被服务端拉回来。
   */
  private chewingSeconds?: number;

  public constructor(
    playerId: string,
    canvas: HTMLCanvasElement,
    spawn: { x: number; z: number },
    input: InputSubsystem,
    bounds: SceneBounds,
    grassInteraction: PlayerWorldInteraction,
    archetype: ActorArchetypeDefinition,
    renderWorld: RenderWorldHandle,
    topDownCameraOffset: Vec3 = DEFAULT_TOP_DOWN_CAMERA_OFFSET,
  ) {
    super(playerId, archetype.id);
    const render = archetype.components.render;
    if (!archetype.components.playerMovement || !isPlayerRenderDefinition(render)) {
      throw new Error(`玩家 Actor 原型无效：${archetype.id}`);
    }
    const movement = this.addComponent(new PlayerMovementComponent(
      archetype.components.playerMovement,
    )) as PlayerMovementComponent;
    // 背包是权威数据，本地这份只是快照的镜像：容量参数从原型来，内容等
    // GrasslandScene 把玩家快照喂进 applySnapshot，不做本地预测。
    this.addComponent(new InventoryComponent(archetype.components.inventory));
    if (archetype.components.pickupDrop) {
      this.addComponent(new PickupDropComponent(archetype.components.pickupDrop));
    }
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
    this.visual = resolvePlayerVisualShape(render);
    this.renderScene = renderWorld.scene;
    this.transforms = renderWorld.transforms;
    this.proxyIds = renderWorld.proxyIds;
    this.proxyId = this.proxyIds.acquire();
    this.renderScene.createPlayerProxy(this.proxyId, {
      name: 'local-player-slime',
      render,
      walkSpeed: movement.walkSpeed,
      surfaceDrag: archetype.components.slimeSurfaceDrag,
    });
    const sampleGroundHeight = grassInteraction.sampleGroundHeight?.bind(grassInteraction);
    const sampleBasePlayerHeight = buoyancy && grassInteraction.samplePlayerHeight
      ? (x: number, z: number): number => grassInteraction.samplePlayerHeight!(x, z, buoyancy.draft)
      : sampleGroundHeight;
    this.isWaterAt = grassInteraction.isWaterAt?.bind(grassInteraction);
    const samplePlayerHeight = sampleBasePlayerHeight;
    const raycastGround = grassInteraction.raycastGround?.bind(grassInteraction);
    if (render.model === 'line-art-legged-slime') {
      this.legGroundProbe = this.addComponent(new LegGroundProbeComponent(
        sampleGroundHeight,
        resolveSlimeLegGroundProbeLayout(render),
      )) as LegGroundProbeComponent;
    }
    this.transform.position.x = spawn.x;
    this.transform.position.y = samplePlayerHeight?.(spawn.x, spawn.z) ?? 0;
    this.transform.position.z = spawn.z;
    // 出生点先兑现一次：下一帧 publish 之前渲染侧读到的就是这里，
    // 否则玩家会在世界原点闪一帧。
    this.publishRenderState();
    this.controller = new TopDownController(canvas, this.transform, input, {
      enabled: false,
      cameraOffset: topDownCameraOffset,
      bounds,
      collisionRadius: this.visual.collisionRadius,
      collisionHeight: this.visual.collisionHeight,
      movement,
      jumpAbility: this.jumpAbility,
      physicsWorld: grassInteraction.getPhysicsWorld?.(),
      characterId: playerId,
      updateMovementState: () => this.waterMovementEffect.sync(
        this.isWaterAt?.(
          this.controller?.position.x ?? spawn.x,
          this.controller?.position.z ?? spawn.z,
        ) ?? false,
      ),
      resolveWalkSpeed: () => this.waterMovementEffect.moveSpeed,
      resolveBuoyancyHeight: (tick) => {
        if (!buoyancy) return undefined;
        const x = this.controller?.position.x ?? spawn.x;
        const z = this.controller?.position.z ?? spawn.z;
        if (!this.isWaterAt?.(x, z)) return undefined;
        const supportY = samplePlayerHeight?.(x, z);
        if (supportY === undefined) return undefined;
        const bobOffset = sampleBuoyancyBobOffset(
          playerId,
          tick * SIMULATION_STEP_SECONDS,
          buoyancy.bobAmplitude,
          buoyancy.bobFrequency,
        );
        return Math.max(sampleGroundHeight?.(x, z) ?? -Infinity, supportY + bobOffset);
      },
      sampleGroundHeight: samplePlayerHeight,
      raycastGround,
      // 玩法 TopDown 保持 Scene 配置的完整构图；树木和建筑可以遮挡，但不能把镜头推近。
      cameraCollisionEnabled: false,
    });
    this.unsubscribeTerrainChanges = grassInteraction.onTerrainChanged?.(() => {
      const position = this.controller.position;
      const groundY = sampleGroundHeight?.(position.x, position.z);
      if (groundY !== undefined) this.controller.ensureTerrainSupport(groundY);
    });
    this.grassDisplacement = this.addComponent(new GrassDisplacementComponent(
      (out) => {
        out.x = this.transform.position.x;
        out.y = this.transform.position.y;
        out.z = this.transform.position.z;
      },
      grassInteraction,
      { radius: this.visual.radius * 1.65 },
    )) as GrassDisplacementComponent;
  }

  /** 蒙皮拖拽等渲染侧交互按它寻址；玩法侧除了这个整数不知道渲染世界里有什么。 */
  public get renderProxyId(): ProxyId {
    return this.proxyId;
  }

  /** 渲染位置。相机焦点、粒子效果等只需要读数值，不需要 Object3D。 */
  public get renderPosition(): { readonly x: number; readonly y: number; readonly z: number } {
    return this.transform.position;
  }

  /** 尚未被服务端确认的输入；上行包会重复携带它们来抵抗丢包。 */
  public get unacknowledgedInputSteps(): readonly PlayerInputStep[] {
    return this.pendingInputSteps;
  }

  /**
   * 服务端推给自己的形变——今天只有「被别人咬住」一种。自己的鼠标拖拽不走这里，
   * 而且渲染侧规定一块外壳只有一个所有者：自己正拖着时，复制过来的会被忽略。
   */
  /** 被外力拴住时的缰绳，转交本地预测；见 TopDownController.setLeash。 */
  public setLeash(leash: SnapshotLeash | undefined): void {
    this.controller.setLeash(leash);
  }

  public setReplicatedSlimeDrag(drag: SnapshotSlimeDrag | undefined): void {
    this.replicatedDrag.revision = drag?.revision ?? 0;
    this.replicatedDrag.contactX = drag?.contactX ?? 0;
    this.replicatedDrag.contactY = drag?.contactY ?? 0;
    this.replicatedDrag.contactZ = drag?.contactZ ?? 0;
    this.replicatedDrag.pullX = drag?.pullX ?? 0;
    this.replicatedDrag.pullY = drag?.pullY ?? 0;
    this.replicatedDrag.pullZ = drag?.pullZ ?? 0;
  }

  /** 没人咬着就传零向量：不驱动这项表现的槽位每帧写 0。 */
  public setBiteTips(tips: ArrayLike<number>): void {
    this.biteTips.set(tips);
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
        x: this.transform.position.x,
        y: this.transform.position.y,
        z: this.transform.position.z,
        yaw: this.transform.rotation.y,
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

  /**
   * 吃东西那段抖动的开关，由 `HotbarController` 那次按住驱动。
   *
   * 「抖着嚼 → 咽下去」和「圈在走 → 圈满激活」是同一段时间：按住开始时抖起来，
   * 倒计时走完（服务端在同一刻扣账）时停下。所以这里不需要第二个计时器，也不
   * 需要服务端多发一个状态——它没有任何权威含义。
   */
  public setChewing(chewing: boolean): void {
    if (!chewing) {
      this.chewingSeconds = undefined;
      return;
    }
    this.chewingSeconds ??= 0;
  }

  public update(deltaSeconds: number): void {
    if (this.chewingSeconds !== undefined) this.chewingSeconds += deltaSeconds;
    this.pendingInputSteps.push(...this.controller.drainInputSteps());
    if (this.pendingInputSteps.length > MAXIMUM_PENDING_INPUT_STEPS) {
      this.pendingInputSteps.splice(
        0,
        this.pendingInputSteps.length - MAXIMUM_PENDING_INPUT_STEPS,
      );
    }
    this.gameAbility.update(deltaSeconds);
    const horizontalVelocity = this.controller.horizontalVelocity;
    const collisionDisplacement = this.controller.consumeCollisionDisplacement();
    this.motion.movementSpeed = this.controller.movementSpeed;
    this.motion.movementVelocityX = horizontalVelocity.x;
    this.motion.movementVelocityZ = horizontalVelocity.z;
    this.motion.verticalVelocity = this.controller.verticalVelocity;
    this.motion.airborne = this.controller.isGrounded ? 0 : 1;
    this.motion.collisionDisplacementX = collisionDisplacement?.x ?? 0;
    this.motion.collisionDisplacementZ = collisionDisplacement?.z ?? 0;
    this.publishRenderState();
    this.grassDisplacement.update(deltaSeconds);
  }

  /**
   * 把这一帧的 transform 与运动参数写进边界。
   *
   * **必须在渲染世界翻面之前调用**（`GrasslandScene` 把玩家更新排在
   * `renderer.update` 之前）。参数与 transform 同段同一次 publish，
   * 所以软体读到的速度和它被摆到的位置永远是同一帧的。
   */
  private publishRenderState(): void {
    const chew = this.chewingSeconds;
    // 嚼的那一下是「上下一顿一顿、左右跟着晃一点」：竖直用取绝对值的正弦，
    // 每半个周期一顿；水平错开半拍，免得整只史莱姆变成一条直线上的往返。
    const chewY = chew === undefined ? 0 : Math.abs(Math.sin(chew * CHEW_RATE)) * CHEW_RISE;
    const chewX = chew === undefined ? 0 : Math.sin(chew * CHEW_RATE * 2) * CHEW_SWAY;
    const chewZ = chew === undefined ? 0 : Math.cos(chew * CHEW_RATE * 2 + 1.1) * CHEW_SWAY;
    this.transforms.write(
      this.proxyId,
      this.transform.position.x + chewX,
      this.transform.position.y + chewY,
      this.transform.position.z + chewZ,
      this.transform.rotation.y,
    );
    writeSlimeMotionParams(this.transforms, this.proxyId, this.motion);
    // 本地玩家的拖拽整个在渲染侧完成，不经过这条复制通道；但槽位仍要每帧写，
    // 否则回收来的槽位会带着上一位玩家的残留把自己的外壳拉出去。
    // 自己的鼠标拖拽整个在渲染侧完成，不经过这条复制通道；走这里的只有被别人
    // 咬住那一份。没有的时候也要每帧写，否则回收来的槽位会带着上一位玩家的
    // 残留把自己的外壳拉出去。
    writeSlimeDragParams(this.transforms, this.proxyId, this.replicatedDrag);
    writeSlimeBiteParams(this.transforms, this.proxyId, this.biteTips);
    this.publishGroundProbe();
  }

  /**
   * 长腿外壳脚下那一小片地面。没有腿的外壳也要每帧写静止值——槽位会被回收，
   * 上一位玩家留下的采样窗口会让新 proxy 的腿一出生就踩在别处的地面上。
   */
  private publishGroundProbe(): void {
    const legs = this.legGroundProbe;
    if (!legs) {
      writeSlimeGroundProbeParams(
        this.transforms,
        this.proxyId,
        SLIME_GROUND_PROBE_AT_REST,
      );
      return;
    }
    legs.refresh(this.transform.position.x, this.transform.position.y, this.transform.position.z);
    writeSlimeGroundProbeParams(this.transforms, this.proxyId, legs.probe);
  }

  public override dispose(): void {
    this.unsubscribeTerrainChanges?.();
    this.waterMovementEffect.dispose();
    this.controller.dispose();
    this.reconciler.reset();
    this.pendingInputSteps.length = 0;
    super.dispose();
    this.proxyIds.destroyMeshProxy(this.proxyId);
  }
}

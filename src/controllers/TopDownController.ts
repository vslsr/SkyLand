import { CameraBoom, type CameraProbe } from '../camera/CameraBoom';
import { CameraFollow } from '../camera/CameraFollow';
import { TopDownCameraOrbit } from '../camera/TopDownCameraOrbit';
import type { CameraFrame } from '../camera/CameraTransform';
import type { CameraAxes } from '../camera/cameraMath';
import { createCameraViewMatrix } from '../camera/cameraMath';
import type { Vec3 } from '../math/vec3';
import { cross, normalize } from '../math/vec3';
import {
  PlayerInputTags,
  type InputActionEvent,
  type InputSubsystem,
} from '../input/index';
import {
  PLAYER_BOUNDS,
  PLAYER_MOVE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  applyPlayerMovement,
  clampToRange,
  lerpAngle,
  normalizeAngle,
} from '../../shared/playerMovement.mjs';
import type { PlayerInputFrame, PlayerInputStep, SnapshotLeash } from '../network/protocol';
import type { SceneBounds } from '../scenes/data/SceneDefinition';
import {
  type PlayerJumpComponent,
} from '../../shared/actor/index.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import {
  copyCharacterState,
  createCharacterState,
} from '../../shared/physics/characterState.mjs';
import {
  createCharacterSimulationParams,
  stepCharacter,
} from '../../shared/physics/stepCharacter.mjs';
import { SimulationClock } from '../../shared/physics/simulationClock.mjs';
import {
  RECONCILE_RATE,
  RECONCILE_CONVERGENCE,
  RECONCILE_SNAP_DISTANCE,
  RECONCILE_TOLERANCE,
  SIMULATION_STEP_SECONDS,
} from '../../shared/networkTuning.mjs';

export interface AuthoritativeCharacterState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  jumpPressed?: boolean;
}

export interface PlayerCollisionMotion {
  minimumY: number;
  airborne: boolean;
}

/**
 * 控制器允许写入角色的旋转轴。
 *
 * TopDown 的角色只在地面上转身，所以默认只放开 Yaw；Pitch / Roll 是留给俯冲、
 * 翻滚一类玩法的配置位，打开之后也只有外部朝向请求会写它们——移动永远只驱动
 * Yaw 这一根轴。
 */
export interface TopDownRotationAxes {
  yaw?: boolean;
  pitch?: boolean;
  roll?: boolean;
}

/**
 * 一次朝向对准请求。
 *
 * 控制器保留「让角色对准某个方向」的能力，但不再自带驱动方：技能、AI、之后
 * 重新接回来的鼠标瞄准都从外面把请求送进来，传 `undefined` 交回移动朝向。
 */
export interface TopDownFacingRequest {
  /** 世界坐标里的对准点；给了它就每帧按角色当前位置重算 Yaw，锁定目标可以移动。 */
  target?: { x: number; z: number };
  /** 直接给定的朝向角；`target` 存在时以 `target` 为准。 */
  yaw?: number;
  /** 仅在 `rotationAxes.pitch` 打开时生效。 */
  pitch?: number;
  /** 仅在 `rotationAxes.roll` 打开时生效。 */
  roll?: number;
  /** 收敛速度（每秒）；默认与过去的鼠标朝向一致。 */
  sharpness?: number;
  /** 直接对齐，不做插值。 */
  immediate?: boolean;
}

export interface TopDownControllerOptions {
  enabled?: boolean;
  /** 相对于阻尼焦点的完整 Scene 相机偏移。 */
  cameraOffset?: Vec3;
  /** TopDown 镜头追随玩家的收敛速度；越大越紧，默认保留轻微粘滞感。 */
  cameraFollowSharpness?: number;
  /** 是否允许在画面上拖动旋转 TopDown 镜头。默认开启。 */
  cameraDragEnabled?: boolean;
  /**
   * 控制器允许写入角色的旋转轴，默认 `{ yaw: true, pitch: false, roll: false }`：
   * 只有 Yaw 会跟着移动转，Pitch / Roll 要显式打开并由外部朝向请求驱动。
   */
  rotationAxes?: TopDownRotationAxes;
  fieldOfViewDegrees?: number;
  bounds?: SceneBounds;
  collisionRadius?: number;
  collisionHeight?: number;
  movement?: {
    walkSpeed: number;
    sprintMultiplier: number;
    maximumStepHeight?: number;
    acceleration?: number;
    deceleration?: number;
    airAcceleration?: number;
    airDrag?: number;
  };
  jumpAbility?: PlayerJumpComponent;
  physicsWorld?: PhysicsWorld;
  characterId?: string;
  /** 在本帧读取 GAS 移动属性前同步环境 GameplayEffect。 */
  updateMovementState?: () => void;
  /** 返回 GAS Movement.Speed 的 CurrentValue。 */
  resolveWalkSpeed?: () => number;
  /** 当前固定模拟 tick 的动态浮力目标；不在水中返回 undefined。 */
  resolveBuoyancyHeight?: (tick: number) => number | undefined;
  resolveCollision?: (
    position: { x: number; z: number },
    radius: number,
    from: { x: number; z: number },
    motion: PlayerCollisionMotion,
  ) => { x: number; y?: number; z: number };
  sampleGroundHeight?: (x: number, z: number) => number;
  raycastGround?: (
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ) => { x: number; y: number; z: number } | undefined;
  /**
   * 是否启用第三人称相机遮挡判定与悬臂收缩。默认关闭。
   */
  cameraCollisionEnabled?: boolean;
  /** 第三人称相机的遮挡探针；只有 cameraCollisionEnabled 开启时才会查询。 */
  cameraProbe?: CameraProbe;
}

/** 悬臂支点的离地高度：史莱姆胸口附近，不是脚下，免得镜头贴地。 */
const CAMERA_PIVOT_HEIGHT = 0.25;
/** 移动方向驱动 Yaw 的收敛速度。 */
const MOVEMENT_FACING_SHARPNESS = 10;
/** 外部朝向请求没写 sharpness 时的收敛速度。 */
const FACING_REQUEST_SHARPNESS = 14;
/** 默认旋转轴开关：只允许运动 Yaw 轴。 */
const DEFAULT_ROTATION_AXES: Required<TopDownRotationAxes> = {
  yaw: true,
  pitch: false,
  roll: false,
};
export const DEFAULT_TOP_DOWN_CAMERA_OFFSET: Vec3 = [5.5, 7.5, 8.5];

/**
 * 控制器需要玩家对象提供的全部能力：一个可读写的 transform。
 *
 * 它**不必是 `THREE.Object3D`**——控制器只碰 `.position.{x,y,z}` 与
 * `.rotation.y`。写成结构类型之后，`Object3D` 仍然满足它（现有调用方不受影响），
 * 同时也允许把玩家的位置换成一条普通记录、由 transform SoA 过边界。
 * 这是本地玩家接到渲染边界上的前置（实现路径文档 §1.5 的第 1 条注意）。
 *
 * `rotation.x` / `rotation.z` 是可选的：默认只有 Yaw 会被写入，打开 Pitch / Roll
 * 的场景才需要 transform 带上对应分量。
 */
export interface PlayerTransformTarget {
  readonly position: { x: number; y: number; z: number };
  readonly rotation: { y: number; x?: number; z?: number };
}

export class TopDownController {
  private readonly canvas: HTMLCanvasElement;
  private readonly player: PlayerTransformTarget;
  private readonly inputDisposers: Array<() => void> = [];
  private readonly cameraOffset: Vec3;
  private readonly cameraDragEnabled: boolean;
  private readonly fieldOfViewRadians: number;
  private readonly rotationAxes: Required<TopDownRotationAxes>;
  private readonly movementInput = { x: 0, y: 0 };
  private readonly bounds: SceneBounds;
  private readonly collisionRadius: number;
  private readonly movement: { walkSpeed: number; sprintMultiplier: number };
  private readonly jumpAbility?: PlayerJumpComponent;
  private readonly physicsWorld?: PhysicsWorld;
  private readonly characterId?: string;
  private readonly characterState?: ReturnType<typeof createCharacterState>;
  private readonly characterParams?: ReturnType<typeof createCharacterSimulationParams>;
  private readonly simulationClock = new SimulationClock();
  private readonly generatedInputSteps: PlayerInputStep[] = [];
  private nextInputTick = 1;
  private previousSimulationPosition = { x: 0, y: 0, z: 0 };
  private renderOffsetX = 0;
  private renderOffsetY = 0;
  private renderOffsetZ = 0;
  private readonly updateMovementState?: TopDownControllerOptions['updateMovementState'];
  private readonly resolveWalkSpeed?: TopDownControllerOptions['resolveWalkSpeed'];
  private readonly resolveBuoyancyHeight?: TopDownControllerOptions['resolveBuoyancyHeight'];
  private readonly resolveCollision?: TopDownControllerOptions['resolveCollision'];
  private readonly sampleGroundHeight?: TopDownControllerOptions['sampleGroundHeight'];
  private readonly raycastGround?: TopDownControllerOptions['raycastGround'];
  private readonly cameraCollisionEnabled: boolean;
  private readonly cameraProbe?: CameraProbe;
  private readonly cameraBoom = new CameraBoom();
  private readonly cameraFollow: CameraFollow;
  private readonly cameraOrbit: TopDownCameraOrbit;
  private readonly cameraDrag = {
    pointerId: -1,
    pressX: 0,
    pressY: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
    active: false,
  };
  private cameraDistanceRatio = 1;
  private enabled: boolean;
  private facingYaw = Math.PI;
  private facingPitch = 0;
  private facingRoll = 0;
  /** 外部送进来的朝向对准请求；没有就由移动方向驱动 Yaw。 */
  private facingRequest?: TopDownFacingRequest;
  private currentSpeed = 0;
  private moveX = 0;
  private moveZ = 0;
  private pendingCollisionDisplacementX = 0;
  private pendingCollisionDisplacementZ = 0;
  private sprinting = false;
  private jumpHeld = false;
  private jumpRequestPending = false;
  private cameraDragSuppressed = false;

  public constructor(
    canvas: HTMLCanvasElement,
    player: PlayerTransformTarget,
    input: InputSubsystem,
    options: TopDownControllerOptions = {},
  ) {
    this.canvas = canvas;
    this.player = player;
    this.enabled = options.enabled ?? true;
    this.cameraOffset = [...(options.cameraOffset ?? DEFAULT_TOP_DOWN_CAMERA_OFFSET)];
    this.cameraDragEnabled = options.cameraDragEnabled ?? true;
    this.rotationAxes = { ...DEFAULT_ROTATION_AXES, ...options.rotationAxes };
    this.cameraOrbit = new TopDownCameraOrbit(this.cameraOffset);
    this.bounds = options.bounds ?? PLAYER_BOUNDS;
    this.collisionRadius = Math.max(0, options.collisionRadius ?? 0);
    this.movement = options.movement ?? {
      walkSpeed: PLAYER_MOVE_SPEED,
      sprintMultiplier: PLAYER_SPRINT_MULTIPLIER,
    };
    this.jumpAbility = options.jumpAbility;
    this.physicsWorld = options.physicsWorld;
    this.characterId = options.characterId;
    if (options.jumpAbility && this.physicsWorld && this.characterId) {
      this.characterState = createCharacterState({
        x: this.player.position.x,
        y: this.player.position.y,
        z: this.player.position.z,
        grounded: true,
      });
      this.characterParams = createCharacterSimulationParams(
        this.characterId,
        this.movement,
        options.jumpAbility,
        { bounds: this.bounds },
      );
      this.physicsWorld.createCharacter(this.characterId, {
        x: this.player.position.x,
        y: this.player.position.y,
        z: this.player.position.z,
        radius: this.collisionRadius,
        halfHeight: (options.collisionHeight ?? this.collisionRadius * 2) * 0.5,
      });
      this.physicsWorld.prepareQueries();
      this.previousSimulationPosition = {
        x: this.characterState.x,
        y: this.characterState.y,
        z: this.characterState.z,
      };
    }
    this.updateMovementState = options.updateMovementState;
    this.resolveWalkSpeed = options.resolveWalkSpeed;
    this.resolveBuoyancyHeight = options.resolveBuoyancyHeight;
    this.resolveCollision = options.resolveCollision;
    this.sampleGroundHeight = options.sampleGroundHeight;
    this.raycastGround = options.raycastGround;
    this.cameraCollisionEnabled = options.cameraCollisionEnabled ?? false;
    this.cameraProbe = options.cameraProbe;
    this.cameraFollow = new CameraFollow(this.cameraPivot, {
      sharpness: options.cameraFollowSharpness,
    });
    this.fieldOfViewRadians = ((options.fieldOfViewDegrees ?? 50) * Math.PI) / 180;
    this.bindInput(input);
    this.bindPointerEvents();
  }

  public get frame(): CameraFrame {
    const target = this.cameraFollow.position;
    // 遮挡只收缩 XZ 平面的悬臂距离，Scene 配置的相机高度不能被一起压低。
    // XZ 朝向保持不变；俯仰轴按最终机位重算，鼠标射线始终与实际画面一致。
    const ratio = this.cameraDistanceRatio;
    const position: Vec3 = [
      target[0] + this.cameraOffset[0] * ratio,
      target[1] + this.cameraOffset[1],
      target[2] + this.cameraOffset[2] * ratio,
    ];
    const forward = normalize([
      target[0] - position[0],
      target[1] - position[1],
      target[2] - position[2],
    ]);
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = normalize(cross(right, forward));
    const axes: CameraAxes = { right, up, forward };
    return { position, axes, viewMatrix: createCameraViewMatrix(position, axes) };
  }

  public get movementSpeed(): number {
    return this.characterState
      ? Math.hypot(this.characterState.vx, this.characterState.vz)
      : this.currentSpeed;
  }

  /** 悬臂支点：角色所在位置抬高到胸口。 */
  private get cameraPivot(): Vec3 {
    return [
      this.player.position.x,
      this.player.position.y + CAMERA_PIVOT_HEIGHT,
      this.player.position.z,
    ];
  }

  /** 当前悬臂占原长的比例，1 表示没有被遮挡。调试面板与测试用它。 */
  public get cameraDistance(): number {
    return this.cameraDistanceRatio;
  }

  public get position(): { x: number; z: number } {
    return this.characterState
      ? { x: this.characterState.x, z: this.characterState.z }
      : { x: this.player.position.x, z: this.player.position.z };
  }

  public get verticalPosition(): number {
    return this.characterState?.y ?? this.player.position.y;
  }

  public get verticalVelocity(): number {
    return this.characterState?.vy ?? this.jumpAbility?.verticalVelocity ?? 0;
  }

  public get horizontalVelocity(): { x: number; z: number } {
    return {
      x: this.characterState?.vx ?? 0,
      z: this.characterState?.vz ?? 0,
    };
  }

  public applyAuthoritativeMotion(
    velocityX: number,
    verticalVelocity: number,
    velocityZ: number,
    grounded: boolean,
  ): void {
    if (this.characterState) {
      this.characterState.vx = velocityX;
      this.characterState.vy = grounded ? 0 : verticalVelocity;
      this.characterState.vz = velocityZ;
      this.characterState.grounded = grounded;
      this.jumpAbility?.applyAuthoritativeState(verticalVelocity, grounded);
    } else {
      this.jumpAbility?.applyAuthoritativeState(verticalVelocity, grounded);
    }
  }

  public get isGrounded(): boolean {
    return this.characterState?.grounded ?? this.jumpAbility?.grounded ?? true;
  }

  /**
   * 返回自上次读取后被场景碰撞阻挡的位移。它只用于客户端表现冲击，读取后清零；
   * 权威位置仍完全由现有移动、碰撞和服务器和解路径决定。
   */
  public consumeCollisionDisplacement(): { x: number; z: number } | undefined {
    const x = this.pendingCollisionDisplacementX;
    const z = this.pendingCollisionDisplacementZ;
    this.pendingCollisionDisplacementX = 0;
    this.pendingCollisionDisplacementZ = 0;
    return Math.hypot(x, z) > 1e-6 ? { x, z } : undefined;
  }

  /** 上行的一帧输入：只描述意图，位置留给服务端算。 */
  public get inputFrame(): PlayerInputFrame {
    return {
      move: { x: this.moveX, z: this.moveZ },
      sprint: this.sprinting,
      jump: this.jumpHeld || this.jumpRequestPending,
      yaw: normalizeAngle(this.facingYaw),
    };
  }

  /** 取走本渲染帧实际执行过的 60Hz 输入步。 */
  public drainInputSteps(): PlayerInputStep[] {
    return this.generatedInputSteps.splice(0);
  }

  /**
   * 从服务端确认点重放所有尚未确认的本地输入，再和当前预测作比较。
   * 容差内保留本地预测；超出容差时只平滑逻辑修正量，不能把固定步插值延迟
   * 误当成网络误差。普通和解也不能清空固定步余量，否则快照会周期性打断移动。
   */
  /**
   * 被外力（牙齿、之后的倒刺）拴住时的缰绳，来自权威快照。
   *
   * 它进的是共享固定步，所以本地预测和服务端重放算的是同一件事；只在服务端加力
   * 会让客户端一路走出去再被快照拽回来，变成持续的橡皮筋。锚点随施力方移动，
   * 客户端拿到的那一份比权威旧一个插值延迟，出入由既有的和解平滑吸收。
   */
  public setLeash(leash: SnapshotLeash | undefined): void {
    if (!this.characterParams) return;
    this.characterParams.leash = leash;
  }

  public rewindAndReplay(
    authoritative: AuthoritativeCharacterState,
    pendingInputs: readonly PlayerInputStep[],
  ): { replayed: number; residualDistance: number; corrected: boolean; snapped: boolean } {
    if (!this.characterState || !this.characterParams || !this.physicsWorld || !this.characterId) {
      this.setPosition(authoritative.x, authoritative.z);
      this.setVerticalPosition(authoritative.y);
      this.applyAuthoritativeMotion(
        authoritative.vx,
        authoritative.vy,
        authoritative.vz,
        authoritative.grounded,
      );
      return { replayed: 0, residualDistance: 0, corrected: true, snapped: true };
    }

    const predicted = createCharacterState(this.characterState);
    copyCharacterState(this.characterState, authoritative);
    this.physicsWorld.setCharacterTranslation(this.characterId, this.characterState);
    this.physicsWorld.prepareQueries();
    const ordered = [...pendingInputs].sort((left, right) => left.tick - right.tick);
    for (const input of ordered) {
      // 与服务端逐步同构：每一步都按**这一步的位置**重判水域。少了这一句，
      // 重放会用和解那一刻的速度跑完全部未确认步，进出水时必然对不上。
      this.refreshWaterStepParams(input.tick);
      stepCharacter(
        this.characterState,
        input,
        SIMULATION_STEP_SECONDS,
        this.physicsWorld,
        this.characterParams,
      );
    }

    const errorX = predicted.x - this.characterState.x;
    const errorY = predicted.y - this.characterState.y;
    const errorZ = predicted.z - this.characterState.z;
    const residualDistance = Math.hypot(errorX, errorY, errorZ);
    const groundedChanged = predicted.grounded !== this.characterState.grounded;

    if (residualDistance <= RECONCILE_TOLERANCE && !groundedChanged) {
      // 快照坐标按毫米量化，所以容差内不整个采用重放结果——那会让 Rapier 每份
      // 快照都从略有不同的地形三角面起点重新出发。但也**不能原样保留预测**：
      // 那样误差永远不收敛，会一直攒到 6cm 门槛，再由下面的分支一次性拉回，
      // 走起来就是一秒一顿。这里按比例吃掉一部分，误差指数衰减。
      const reconciledMotion = {
        vx: this.characterState.vx,
        vy: this.characterState.vy,
        vz: this.characterState.vz,
        grounded: this.characterState.grounded,
        jumpPressed: this.characterState.jumpPressed,
      };
      const consumedX = errorX * RECONCILE_CONVERGENCE;
      const consumedY = errorY * RECONCILE_CONVERGENCE;
      const consumedZ = errorZ * RECONCILE_CONVERGENCE;
      copyCharacterState(this.characterState, predicted);
      Object.assign(this.characterState, reconciledMotion);
      this.characterState.x -= consumedX;
      this.characterState.y -= consumedY;
      this.characterState.z -= consumedZ;
      this.physicsWorld.setCharacterTranslation(this.characterId, this.characterState);
      this.physicsWorld.prepareQueries();
      // 吃掉的那一点同样走渲染偏移补偿，画面上看不出这一步收敛。
      this.previousSimulationPosition.x -= consumedX;
      this.previousSimulationPosition.y -= consumedY;
      this.previousSimulationPosition.z -= consumedZ;
      this.renderOffsetX += consumedX;
      this.renderOffsetY += consumedY;
      this.renderOffsetZ += consumedZ;
      // 插值两端与偏移各自平移了同一个量，可见位置因此**逐点不变**，
      // 不必也不该在这里重算它——那会把当前这一帧的插值相位一起抹掉。
      this.jumpAbility?.applyAuthoritativeState(
        this.characterState.vy,
        this.characterState.grounded,
      );
      return {
        replayed: ordered.length,
        residualDistance,
        corrected: false,
        snapped: false,
      };
    }

    const snapped = residualDistance > RECONCILE_SNAP_DISTANCE;
    if (snapped) {
      this.previousSimulationPosition = {
        x: this.characterState.x,
        y: this.characterState.y,
        z: this.characterState.z,
      };
      this.renderOffsetX = 0;
      this.renderOffsetY = 0;
      this.renderOffsetZ = 0;
      this.simulationClock.reset();
      this.resetCamera();
      this.refreshRenderPosition(1);
    } else {
      // 同量平移插值区间并反向累加修正偏移：当前画面连续，但偏移只包含
      // 预测与权威的逻辑差，不会吞入正常的一帧固定步插值延迟。
      this.previousSimulationPosition.x -= errorX;
      this.previousSimulationPosition.y -= errorY;
      this.previousSimulationPosition.z -= errorZ;
      this.renderOffsetX += errorX;
      this.renderOffsetY += errorY;
      this.renderOffsetZ += errorZ;
      this.refreshRenderPosition(this.simulationClock.alpha);
    }
    this.jumpAbility?.applyAuthoritativeState(
      this.characterState.vy,
      this.characterState.grounded,
    );
    return { replayed: ordered.length, residualDistance, corrected: true, snapped };
  }

  /** 输入包成功发出后清除短按锁存；仍按住 Space 时 jump 会继续保持 true。 */
  public acknowledgeInputFrame(): void {
    this.jumpRequestPending = false;
  }

  public setInputEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.movementInput.x = 0;
      this.movementInput.y = 0;
      this.currentSpeed = 0;
      this.moveX = 0;
      this.moveZ = 0;
      this.sprinting = false;
      this.jumpHeld = false;
      this.jumpRequestPending = false;
      this.jumpAbility?.setPressed(false);
      this.cancelCameraDrag();
      this.cameraOrbit.cancelPending();
    }
  }

  /** 传送或重新出生：悬臂与平滑支点都不该把上一处状态带过来。 */
  public resetCamera(): void {
    this.cameraBoom.reset();
    this.cameraDistanceRatio = 1;
    this.cameraFollow.reset(this.cameraPivot);
    this.cancelCameraDrag();
    this.cameraOrbit.cancelPending();
  }

  public setPosition(x: number, z: number): void {
    const previous = { x: this.player.position.x, z: this.player.position.z };
    const bounded = {
      x: clampToRange(x, this.bounds.minimumX, this.bounds.maximumX),
      z: clampToRange(z, this.bounds.minimumZ, this.bounds.maximumZ),
    };
    if (this.characterState && this.physicsWorld && this.characterId) {
      this.characterState.x = bounded.x;
      this.characterState.z = bounded.z;
      this.physicsWorld.setCharacterTranslation(this.characterId, this.characterState);
      this.previousSimulationPosition.x = bounded.x;
      this.previousSimulationPosition.z = bounded.z;
      this.refreshRenderPosition(1);
      return;
    }
    const resolved: { x: number; y?: number; z: number } =
      this.resolveCollision?.(bounded, this.collisionRadius, previous, {
        minimumY: this.player.position.y,
        airborne: this.jumpAbility?.isAirborne ?? false,
      }) ?? bounded;
    const finalX = clampToRange(resolved.x, this.bounds.minimumX, this.bounds.maximumX);
    const finalZ = clampToRange(resolved.z, this.bounds.minimumZ, this.bounds.maximumZ);
    this.pendingCollisionDisplacementX += bounded.x - finalX;
    this.pendingCollisionDisplacementZ += bounded.z - finalZ;
    this.player.position.x = finalX;
    if (!(this.jumpAbility?.isAirborne ?? false)) {
      this.player.position.y = resolved.y
        ?? this.sampleGroundHeight?.(finalX, finalZ)
        ?? this.player.position.y;
    }
    this.player.position.z = finalZ;
  }

  public setVerticalPosition(y: number): void {
    if (!Number.isFinite(y)) return;
    if (this.characterState && this.physicsWorld && this.characterId) {
      this.characterState.y = y;
      this.physicsWorld.setCharacterTranslation(this.characterId, this.characterState);
      this.previousSimulationPosition.y = y;
      this.refreshRenderPosition(1);
      return;
    }
    this.player.position.y = y;
  }

  /**
   * 地形 patch 可能把一张新三角面直接生成在角色脚点之上。Rapier 的角色控制器
   * 只解算下一次位移，不会自动修复这种由静态碰撞重建造成的初始穿透，因此这里
   * 在地面确实高过脚点时做一次向上重定位。下降的地形仍交给重力自然处理。
   */
  public ensureTerrainSupport(minimumY: number): boolean {
    if (!Number.isFinite(minimumY) || minimumY <= this.verticalPosition + 1e-6) return false;
    if (this.characterState && this.physicsWorld && this.characterId) {
      this.characterState.y = minimumY;
      this.characterState.vy = 0;
      this.characterState.grounded = true;
      this.physicsWorld.setCharacterTranslation(this.characterId, this.characterState);
      this.previousSimulationPosition.y = minimumY;
      this.renderOffsetY = 0;
      this.jumpAbility?.applyAuthoritativeState(0, true);
      this.refreshRenderPosition(1);
      return true;
    }
    this.player.position.y = minimumY;
    this.jumpAbility?.applyAuthoritativeState(0, true);
    return true;
  }

  public translateVertical(deltaY: number): void {
    if (Number.isFinite(deltaY)) this.setVerticalPosition(this.verticalPosition + deltaY);
  }

  /** 表面拖拽命中玩家自身时暂停镜头拖拽，避免同一次手势同时转动镜头。 */
  public setCameraDragSuppressed(suppressed: boolean): void {
    this.cameraDragSuppressed = suppressed;
    if (suppressed) {
      this.cancelCameraDrag();
      this.cameraOrbit.cancelPending();
    }
  }

  /**
   * 朝向对准接口。
   *
   * 「让角色对准某个方向」这件事仍归控制器做，但它不再自带驱动方——鼠标点击
   * 不会再转动角色。技能、AI、之后重新接回来的鼠标瞄准都从外面调这个接口；传
   * `undefined` 就把朝向交回移动方向。请求里的 Pitch / Roll 只在 `rotationAxes`
   * 放开了对应轴时才会被写进 transform。
   */
  public setFacingRequest(request: TopDownFacingRequest | undefined): void {
    this.facingRequest = request ? { ...request } : undefined;
  }

  /** 当前生效的朝向请求；没有外部驱动方时是 undefined。 */
  public get facingRequestState(): TopDownFacingRequest | undefined {
    return this.facingRequest ? { ...this.facingRequest } : undefined;
  }

  /** 控制器当前的朝向。只有 `rotationAxes` 放开的轴会被写进玩家 transform。 */
  public get facing(): { yaw: number; pitch: number; roll: number } {
    return { yaw: this.facingYaw, pitch: this.facingPitch, roll: this.facingRoll };
  }

  /**
   * 屏幕点 → 地面点，供外部驱动方算对准目标。
   *
   * 鼠标驱动被拆掉之后控制器内部不再调它，但这条射线要用控制器自己的相机机位与
   * 场景地形查询，所以能力留在这里，只是改成显式接口。
   */
  public projectScreenPointToGround(
    clientX: number,
    clientY: number,
  ): { x: number; z: number } | undefined {
    return this.projectScreenPointToGameplayPlane(clientX, clientY);
  }

  public translate(deltaX: number, deltaZ: number): void {
    this.setPosition(this.position.x + deltaX, this.position.z + deltaZ);
  }

  public update(deltaSeconds: number): void {
    this.updateCameraOrbit(deltaSeconds);
    this.decayRenderOffset(deltaSeconds);
    // 镜头必须先解算：即使输入被 UI 接管，角色仍可能被服务端和解拉着走，
    // 这时镜头照样要躲开挡在中间的树。
    this.updateCameraBoom(deltaSeconds);
    if (!this.enabled) {
      if (this.characterState) {
        this.updateCharacterMotion(deltaSeconds, 0, 0, false);
      } else {
        this.updateVerticalMotion(deltaSeconds);
      }
      return;
    }
    this.updateMovementState?.();
    const resolvedWalkSpeed = this.resolveWalkSpeed?.() ?? this.movement.walkSpeed;
    const walkSpeed = Number.isFinite(resolvedWalkSpeed)
      ? Math.max(0, resolvedWalkSpeed)
      : this.movement.walkSpeed;
    const controlledWalkSpeed = walkSpeed * (this.jumpAbility?.horizontalControlScale ?? 1);

    const localX = this.movementInput.x;
    const localY = this.movementInput.y;
    const inputLength = Math.hypot(localX, localY);
    const axes = this.frame.axes;
    const cameraForwardLength = Math.hypot(axes.forward[0], axes.forward[2]) || 1;
    const forwardX = axes.forward[0] / cameraForwardLength;
    const forwardZ = axes.forward[2] / cameraForwardLength;
    const rightX = axes.right[0];
    const rightZ = axes.right[2];

    this.moveX = 0;
    this.moveZ = 0;
    if (inputLength > 0) {
      const normalizedX = localX / inputLength;
      const normalizedY = localY / inputLength;
      this.moveX = rightX * normalizedX + forwardX * normalizedY;
      this.moveZ = rightZ * normalizedX + forwardZ * normalizedY;
    }

    if (this.characterState) {
      this.updateCharacterMotion(deltaSeconds, this.moveX, this.moveZ, this.sprinting, walkSpeed);
      this.currentSpeed = Math.hypot(this.characterState.vx, this.characterState.vz);
    } else if (inputLength > 0) {
      // 兼容没有角色碰撞查询的轻量测试/旧固定场景。
      const next = applyPlayerMovement(
        this.position,
        { x: this.moveX, z: this.moveZ, sprint: this.sprinting },
        deltaSeconds,
        this.bounds,
        {
          walkSpeed: controlledWalkSpeed,
          sprintMultiplier: this.movement.sprintMultiplier,
        },
      );
      this.setPosition(next.x, next.z);
      const speed = controlledWalkSpeed
        * (this.sprinting ? this.movement.sprintMultiplier : 1);
      this.currentSpeed += (speed - this.currentSpeed) * Math.min(1, deltaSeconds * 12);
    } else {
      this.currentSpeed += (0 - this.currentSpeed) * Math.min(1, deltaSeconds * 10);
    }

    this.updateFacing(deltaSeconds, inputLength > 0);
    if (!this.characterState) this.resolveLanding();
  }

  /**
   * 朝向解算。
   *
   * 控制器内置的驱动方只有一个：移动方向，而且它只写 Yaw——这就是「默认只允许
   * 运动 Yaw 轴」。外部朝向请求可以接管 Yaw，并在 `rotationAxes` 放开时补上
   * Pitch / Roll；被 `rotationAxes` 关掉的轴，控制器一个字都不往 transform 里写。
   */
  private updateFacing(deltaSeconds: number, moving: boolean): void {
    const request = this.facingRequest;
    const requestedYaw = this.resolveRequestedYaw(request);
    // 请求一旦提到 Yaw 就整根轴归它：对准点贴到脚下这一帧解不出角度时保持当前
    // 朝向，不能中途把角色甩回移动方向。
    const yawRequested = request?.target !== undefined || request?.yaw !== undefined;
    if (this.rotationAxes.yaw) {
      const movementYaw = moving && !yawRequested
        ? Math.atan2(this.moveX, this.moveZ)
        : undefined;
      const targetYaw = requestedYaw ?? movementYaw;
      if (targetYaw !== undefined) {
        this.facingYaw = requestedYaw === undefined
          ? lerpAngle(
            this.facingYaw,
            targetYaw,
            Math.min(1, deltaSeconds * MOVEMENT_FACING_SHARPNESS),
          )
          : this.approachAngle(this.facingYaw, targetYaw, deltaSeconds, request);
      }
      this.facingYaw = normalizeAngle(this.facingYaw);
      this.player.rotation.y = this.facingYaw;
    }
    if (this.rotationAxes.pitch) {
      if (request?.pitch !== undefined) {
        this.facingPitch = this.approachAngle(
          this.facingPitch,
          request.pitch,
          deltaSeconds,
          request,
        );
      }
      if ('x' in this.player.rotation) this.player.rotation.x = this.facingPitch;
    }
    if (this.rotationAxes.roll) {
      if (request?.roll !== undefined) {
        this.facingRoll = this.approachAngle(
          this.facingRoll,
          request.roll,
          deltaSeconds,
          request,
        );
      }
      if ('z' in this.player.rotation) this.player.rotation.z = this.facingRoll;
    }
  }

  /** 对准点每帧按角色当前位置重算；贴得太近时保持上一帧朝向，免得原地抖。 */
  private resolveRequestedYaw(request: TopDownFacingRequest | undefined): number | undefined {
    if (!request) return undefined;
    const target = request.target;
    if (!target) return request.yaw;
    const deltaX = target.x - this.player.position.x;
    const deltaZ = target.z - this.player.position.z;
    if (Math.hypot(deltaX, deltaZ) <= 0.08) return undefined;
    return Math.atan2(deltaX, deltaZ);
  }

  private approachAngle(
    current: number,
    target: number,
    deltaSeconds: number,
    request: TopDownFacingRequest | undefined,
  ): number {
    const sharpness = request?.sharpness ?? FACING_REQUEST_SHARPNESS;
    if (request?.immediate || !(sharpness > 0)) return normalizeAngle(target);
    return normalizeAngle(lerpAngle(current, target, Math.min(1, deltaSeconds * sharpness)));
  }

  /**
   * 按角色**当前所在位置**重算与水域相关的固定步参数。
   *
   * 服务端在每个固定步之前都做这件事（`ServerScene` 的 `syncWaterMovementEffect` +
   * `walkSpeed` + `buoyancyHeight`）。客户端过去只在每帧开头做一次，重放时干脆
   * 一次都不做——于是一进水，重放的每一步都在用错的速度和浮力，落点是服务端从
   * 未到过的地方，每份快照都要把人往回拉一次。旱地上这两个值恒定，所以这个错
   * 只在带水域的地图上露出来。
   */
  private refreshWaterStepParams(tick: number): void {
    if (!this.characterParams) return;
    this.updateMovementState?.();
    const resolved = this.resolveWalkSpeed?.();
    if (Number.isFinite(resolved)) {
      this.characterParams.walkSpeed = Math.max(0, resolved as number);
    }
    this.characterParams.buoyancyHeight = this.resolveBuoyancyHeight?.(tick);
  }

  private updateCharacterMotion(
    deltaSeconds: number,
    moveX: number,
    moveZ: number,
    sprint: boolean,
    walkSpeed?: number,
  ): void {
    if (!this.characterState || !this.characterParams || !this.physicsWorld) return;
    this.characterParams.walkSpeed = walkSpeed ?? this.movement.walkSpeed;
    const jump = this.jumpHeld || this.jumpRequestPending;
    this.simulationClock.advance(deltaSeconds, (stepSeconds: number) => {
      this.previousSimulationPosition = {
        x: this.characterState!.x,
        y: this.characterState!.y,
        z: this.characterState!.z,
      };
      const input: PlayerInputStep = {
        tick: this.nextInputTick,
        move: { x: moveX, z: moveZ },
        sprint,
        jump,
        yaw: normalizeAngle(this.facingYaw),
      };
      this.nextInputTick += 1;
      // 一帧可能跑好几个固定步，位置逐步在变——涉水参数必须跟着逐步重算，
      // 否则同一帧内的第二步还在用进水之前的速度。
      this.refreshWaterStepParams(input.tick);
      stepCharacter(
        this.characterState!,
        input,
        stepSeconds,
        this.physicsWorld!,
        this.characterParams!,
      );
      this.generatedInputSteps.push(input);
      this.jumpRequestPending = false;
    });
    this.jumpAbility?.applyAuthoritativeState(
      this.characterState.vy,
      this.characterState.grounded,
    );
    this.refreshRenderPosition(this.simulationClock.alpha);
  }

  private decayRenderOffset(deltaSeconds: number): void {
    const amount = Math.exp(-RECONCILE_RATE * Math.max(0, deltaSeconds));
    this.renderOffsetX *= amount;
    this.renderOffsetY *= amount;
    this.renderOffsetZ *= amount;
  }

  private refreshRenderPosition(alpha: number): void {
    if (!this.characterState) return;
    const mix = Math.max(0, Math.min(1, alpha));
    this.player.position.x = this.previousSimulationPosition.x
      + (this.characterState.x - this.previousSimulationPosition.x) * mix
      + this.renderOffsetX;
    this.player.position.y = this.previousSimulationPosition.y
      + (this.characterState.y - this.previousSimulationPosition.y) * mix
      + this.renderOffsetY;
    this.player.position.z = this.previousSimulationPosition.z
      + (this.characterState.z - this.previousSimulationPosition.z) * mix
      + this.renderOffsetZ;
  }

  private updateVerticalMotion(deltaSeconds: number): void {
    if (!this.jumpAbility) return;
    this.player.position.y = this.jumpAbility.integrate(this.player.position.y, deltaSeconds);
    this.resolveLanding();
  }

  private resolveLanding(): void {
    if (!this.jumpAbility) return;
    const groundY = this.sampleGroundHeight?.(
      this.player.position.x,
      this.player.position.z,
    ) ?? 0;
    this.player.position.y = this.jumpAbility.resolveGround(this.player.position.y, groundY);
  }

  /**
   * 解算第三人称镜头的遮挡。
   *
   * 每帧一次扫掠查询：起点是角色，终点是无遮挡时的机位。查询走场景碰撞网格的
   * CAMERA 层，所以只会命中附近格子里的那几个盒子，成本与世界大小无关。
   */
  private updateCameraBoom(deltaSeconds: number): void {
    const smoothedPivot = this.cameraFollow.update(this.cameraPivot, deltaSeconds);
    this.cameraDistanceRatio = this.cameraBoom.solve(
      smoothedPivot,
      this.cameraOffset,
      deltaSeconds,
      this.cameraCollisionEnabled ? this.cameraProbe : undefined,
    );
  }

  private updateCameraOrbit(deltaSeconds: number): void {
    const offset = this.cameraOrbit.update(deltaSeconds);
    this.cameraOffset[0] = offset[0];
    this.cameraOffset[1] = offset[1];
    this.cameraOffset[2] = offset[2];
  }

  public dispose(): void {
    for (const dispose of this.inputDisposers.splice(0)) dispose();
    if (this.physicsWorld && this.characterId) {
      this.physicsWorld.removeCharacter(this.characterId);
    }
    this.cancelCameraDrag();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerEnd);
    this.canvas.removeEventListener('pointercancel', this.handlePointerEnd);
    this.canvas.removeEventListener('lostpointercapture', this.handlePointerCaptureLost);
  }

  private projectScreenPointToGameplayPlane(
    clientX: number,
    clientY: number,
  ): { x: number; z: number } | undefined {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const frame = this.frame;
    const tangent = Math.tan(this.fieldOfViewRadians / 2);
    const aspect = rect.width / rect.height;
    const rayDirection = normalize([
      frame.axes.forward[0] + frame.axes.right[0] * ndcX * tangent * aspect + frame.axes.up[0] * ndcY * tangent,
      frame.axes.forward[1] + frame.axes.right[1] * ndcX * tangent * aspect + frame.axes.up[1] * ndcY * tangent,
      frame.axes.forward[2] + frame.axes.right[2] * ndcX * tangent * aspect + frame.axes.up[2] * ndcY * tangent,
    ]);
    const terrainHit = this.raycastGround?.(frame.position, rayDirection);
    if (terrainHit) return { x: terrainHit.x, z: terrainHit.z };
    if (rayDirection[1] >= -0.0001) return undefined;

    const distance = -frame.position[1] / rayDirection[1];
    if (distance <= 0) return undefined;
    return {
      x: frame.position[0] + rayDirection[0] * distance,
      z: frame.position[2] + rayDirection[2] * distance,
    };
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (
      !this.cameraDragEnabled
      || this.cameraDragSuppressed
      || event.button !== 0
      || this.cameraDrag.pointerId >= 0
    ) return;
    this.cameraDrag.pointerId = event.pointerId;
    this.cameraDrag.pressX = event.clientX;
    this.cameraDrag.pressY = event.clientY;
    this.cameraDrag.lastX = event.clientX;
    this.cameraDrag.lastY = event.clientY;
    this.cameraDrag.moved = 0;
    this.cameraDrag.active = false;
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // pointerup 仍会正常结束手势；部分浏览器会拒绝捕获已离开的指针。
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (event.pointerId !== this.cameraDrag.pointerId) return;
    if (this.cameraDragSuppressed) {
      this.cancelCameraDrag();
      return;
    }
    const deltaX = event.clientX - this.cameraDrag.lastX;
    const deltaY = event.clientY - this.cameraDrag.lastY;
    this.cameraDrag.lastX = event.clientX;
    this.cameraDrag.lastY = event.clientY;
    this.cameraDrag.moved += Math.abs(deltaX) + Math.abs(deltaY);
    if (!this.cameraDrag.active && this.cameraDrag.moved >= 6) {
      this.cameraDrag.active = true;
      this.cameraOrbit.addPointerDelta(
        event.clientX - this.cameraDrag.pressX,
        event.clientY - this.cameraDrag.pressY,
      );
    } else if (this.cameraDrag.active) {
      this.cameraOrbit.addPointerDelta(deltaX, deltaY);
    }
    if (this.cameraDrag.active && event.cancelable) event.preventDefault();
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.cameraDrag.pointerId) return;
    this.cancelCameraDrag();
  };

  private readonly handlePointerCaptureLost = (event: PointerEvent): void => {
    if (event.pointerId !== this.cameraDrag.pointerId) return;
    this.cameraDrag.pointerId = -1;
    this.cameraDrag.active = false;
    this.cameraDrag.moved = 0;
  };

  private cancelCameraDrag(): void {
    const pointerId = this.cameraDrag.pointerId;
    this.cameraDrag.pointerId = -1;
    this.cameraDrag.active = false;
    this.cameraDrag.moved = 0;
    if (
      pointerId < 0
      || !this.canvas.hasPointerCapture?.(pointerId)
      || !this.canvas.releasePointerCapture
    ) return;
    try {
      this.canvas.releasePointerCapture(pointerId);
    } catch {
      // lostpointercapture 可能已经先一步释放，状态在上方已清理。
    }
  }

  private bindInput(input: InputSubsystem): void {
    this.inputDisposers.push(
      input.bind(PlayerInputTags.Move, (event) => this.handleMoveInput(event)),
      input.bind(PlayerInputTags.Sprint, (event) => this.handleSprintInput(event)),
      input.bind(PlayerInputTags.Jump, (event) => this.handleJumpInput(event)),
    );
  }

  private bindPointerEvents(): void {
    // 控制器在 DOM 层只认镜头拖拽：点击语义归 Input.Player.Primary 的订阅方，
    // 角色朝向归 setFacingRequest，两者都不再由这里的指针事件驱动。
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerEnd);
    this.canvas.addEventListener('pointercancel', this.handlePointerEnd);
    this.canvas.addEventListener('lostpointercapture', this.handlePointerCaptureLost);
  }

  private handleMoveInput(event: InputActionEvent): void {
    if (!this.enabled || event.phase === 'completed' || event.phase === 'canceled') {
      this.movementInput.x = 0;
      this.movementInput.y = 0;
      return;
    }
    if (typeof event.value === 'boolean') return;
    this.movementInput.x = event.value.x;
    this.movementInput.y = event.value.y;
  }

  private handleSprintInput(event: InputActionEvent): void {
    this.sprinting = this.enabled
      && event.phase !== 'completed'
      && event.phase !== 'canceled'
      && event.value === true;
  }

  private handleJumpInput(event: InputActionEvent): void {
    const active = this.enabled
      && event.phase !== 'completed'
      && event.phase !== 'canceled'
      && event.value === true;
    if (active && !this.jumpHeld) this.jumpRequestPending = true;
    this.jumpHeld = active;
    this.jumpAbility?.setPressed(active);
  }
}

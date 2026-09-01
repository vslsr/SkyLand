import { CameraBoom, type CameraProbe } from '../camera/CameraBoom';
import { CameraFollow } from '../camera/CameraFollow';
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
import type { PlayerInputFrame, PlayerInputStep } from '../network/protocol';
import type { SceneBounds } from '../scenes/data/SceneDefinition';
import type * as THREE from 'three';
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

export interface TopDownControllerOptions {
  enabled?: boolean;
  /** 相对于阻尼焦点的完整 Scene 相机偏移。 */
  cameraOffset?: Vec3;
  /** TopDown 镜头追随玩家的收敛速度；越大越紧，默认保留轻微粘滞感。 */
  cameraFollowSharpness?: number;
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
  /** 水面支撑高度；不在水中返回 undefined。 */
  resolveBuoyancyHeight?: () => number | undefined;
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
export const DEFAULT_TOP_DOWN_CAMERA_OFFSET: Vec3 = [5.5, 7.5, 8.5];

export class TopDownController {
  private readonly canvas: HTMLCanvasElement;
  private readonly player: THREE.Object3D;
  private readonly inputDisposers: Array<() => void> = [];
  private readonly cameraOffset: Vec3;
  private readonly fieldOfViewRadians: number;
  private readonly pointer = { x: 0, y: 0, available: false, dirty: false };
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
  private cameraDistanceRatio = 1;
  private enabled: boolean;
  private facingYaw = Math.PI;
  private currentSpeed = 0;
  private moveX = 0;
  private moveZ = 0;
  private pendingCollisionDisplacementX = 0;
  private pendingCollisionDisplacementZ = 0;
  private sprinting = false;
  private jumpHeld = false;
  private jumpRequestPending = false;
  private mouseFacingActive = false;
  private mouseFacingSuppressed = false;

  public constructor(
    canvas: HTMLCanvasElement,
    player: THREE.Object3D,
    input: InputSubsystem,
    options: TopDownControllerOptions = {},
  ) {
    this.canvas = canvas;
    this.player = player;
    this.enabled = options.enabled ?? true;
    this.cameraOffset = [...(options.cameraOffset ?? DEFAULT_TOP_DOWN_CAMERA_OFFSET)];
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
      // 快照坐标按毫米量化。容差内把预测位置写回，避免每份快照都让 Rapier
      // 从略有不同的地形三角面起点重新出发；速度等运动状态仍采用重放结果。
      const reconciledMotion = {
        vx: this.characterState.vx,
        vy: this.characterState.vy,
        vz: this.characterState.vz,
        grounded: this.characterState.grounded,
        jumpPressed: this.characterState.jumpPressed,
      };
      copyCharacterState(this.characterState, predicted);
      Object.assign(this.characterState, reconciledMotion);
      this.physicsWorld.setCharacterTranslation(this.characterId, this.characterState);
      this.physicsWorld.prepareQueries();
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
      this.mouseFacingActive = false;
    }
  }

  /** 传送或重新出生：悬臂与平滑支点都不该把上一处状态带过来。 */
  public resetCamera(): void {
    this.cameraBoom.reset();
    this.cameraDistanceRatio = 1;
    this.cameraFollow.reset(this.cameraPivot);
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

  /** 表面拖拽命中玩家自身时暂停左键朝向，避免同一次手势同时旋转 Actor。 */
  public setMouseFacingSuppressed(suppressed: boolean): void {
    this.mouseFacingSuppressed = suppressed;
    if (suppressed) this.mouseFacingActive = false;
  }

  public translate(deltaX: number, deltaZ: number): void {
    this.setPosition(this.position.x + deltaX, this.position.z + deltaZ);
  }

  public update(deltaSeconds: number): void {
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

    if (this.mouseFacingActive) {
      if (this.pointer.dirty) {
        const groundPoint = this.projectPointerToGameplayPlane();
        if (groundPoint) {
          const deltaX = groundPoint.x - this.player.position.x;
          const deltaY = groundPoint.y - this.player.position.z;
          if (Math.hypot(deltaX, deltaY) > 0.08) {
            const targetYaw = Math.atan2(deltaX, deltaY);
            this.facingYaw = lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 14));
          }
        }
        this.pointer.dirty = false;
      }
    } else if (inputLength > 0) {
      const targetYaw = Math.atan2(this.moveX, this.moveZ);
      this.facingYaw = lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 10));
    }
    this.facingYaw = normalizeAngle(this.facingYaw);
    this.player.rotation.y = this.facingYaw;
    if (!this.characterState) this.resolveLanding();
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
    this.characterParams.buoyancyHeight = this.resolveBuoyancyHeight?.();
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
    this.player.position.set(
      this.previousSimulationPosition.x
        + (this.characterState.x - this.previousSimulationPosition.x) * mix
        + this.renderOffsetX,
      this.previousSimulationPosition.y
        + (this.characterState.y - this.previousSimulationPosition.y) * mix
        + this.renderOffsetY,
      this.previousSimulationPosition.z
        + (this.characterState.z - this.previousSimulationPosition.z) * mix
        + this.renderOffsetZ,
    );
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

  public dispose(): void {
    for (const dispose of this.inputDisposers.splice(0)) dispose();
    if (this.physicsWorld && this.characterId) {
      this.physicsWorld.removeCharacter(this.characterId);
    }
    this.canvas.removeEventListener('pointerdown', this.handlePointerMove);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerenter', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
  }

  private projectPointerToGameplayPlane(): { x: number; y: number } | undefined {
    if (!this.pointer.available) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;

    const ndcX = ((this.pointer.x - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((this.pointer.y - rect.top) / rect.height) * 2;
    const frame = this.frame;
    const tangent = Math.tan(this.fieldOfViewRadians / 2);
    const aspect = rect.width / rect.height;
    const rayDirection = normalize([
      frame.axes.forward[0] + frame.axes.right[0] * ndcX * tangent * aspect + frame.axes.up[0] * ndcY * tangent,
      frame.axes.forward[1] + frame.axes.right[1] * ndcX * tangent * aspect + frame.axes.up[1] * ndcY * tangent,
      frame.axes.forward[2] + frame.axes.right[2] * ndcX * tangent * aspect + frame.axes.up[2] * ndcY * tangent,
    ]);
    const terrainHit = this.raycastGround?.(frame.position, rayDirection);
    if (terrainHit) return { x: terrainHit.x, y: terrainHit.z };
    if (rayDirection[1] >= -0.0001) return undefined;

    const distance = -frame.position[1] / rayDirection[1];
    if (distance <= 0) return undefined;
    return {
      x: frame.position[0] + rayDirection[0] * distance,
      y: frame.position[2] + rayDirection[2] * distance,
    };
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    this.pointer.available = true;
    this.pointer.dirty = true;
  };

  private readonly handlePointerLeave = (): void => {
    this.pointer.available = false;
    this.pointer.dirty = false;
  };

  private bindInput(input: InputSubsystem): void {
    this.inputDisposers.push(
      input.bind(PlayerInputTags.Move, (event) => this.handleMoveInput(event)),
      input.bind(PlayerInputTags.Sprint, (event) => this.handleSprintInput(event)),
      input.bind(PlayerInputTags.Jump, (event) => this.handleJumpInput(event)),
      input.bind(PlayerInputTags.Primary, (event) => this.handlePrimaryInput(event)),
    );
  }

  private bindPointerEvents(): void {
    // 点击本身仍由 Input.Player.Primary 决定；这里只同步点击瞬间的光标坐标。
    this.canvas.addEventListener('pointerdown', this.handlePointerMove);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerenter', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
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

  private handlePrimaryInput(event: InputActionEvent): void {
    if (event.phase === 'completed' || event.phase === 'canceled') {
      this.mouseFacingActive = false;
      return;
    }
    if (
      event.deviceKind === 'keyboardMouse'
      && event.sourceControl?.startsWith('Mouse.')
    ) {
      this.mouseFacingActive = (
        this.enabled
        && !this.mouseFacingSuppressed
        && event.value === true
      );
    }
  }
}

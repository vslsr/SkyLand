import { CameraBoom, type CameraProbe } from '../camera/CameraBoom';
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
import type { PlayerInputFrame } from '../network/protocol';
import type { SceneBounds } from '../scenes/data/SceneDefinition';
import type * as THREE from 'three';
import type { PlayerJumpComponent } from '../../shared/actor/index.mjs';

export interface PlayerCollisionMotion {
  minimumY: number;
  airborne: boolean;
}

export interface TopDownControllerOptions {
  enabled?: boolean;
  cameraOffset?: Vec3;
  fieldOfViewDegrees?: number;
  bounds?: SceneBounds;
  collisionRadius?: number;
  movement?: { walkSpeed: number; sprintMultiplier: number };
  jumpAbility?: PlayerJumpComponent;
  /** 在本帧读取 GAS 移动属性前同步环境 GameplayEffect。 */
  updateMovementState?: () => void;
  /** 返回 GAS Movement.Speed 的 CurrentValue。 */
  resolveWalkSpeed?: () => number;
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

export class TopDownController {
  private readonly canvas: HTMLCanvasElement;
  private readonly player: THREE.Object3D;
  private readonly inputDisposers: Array<() => void> = [];
  private readonly cameraOffset: Vec3;
  private readonly fieldOfViewRadians: number;
  private readonly pointer = { x: 0, y: 0, available: false };
  private readonly movementInput = { x: 0, y: 0 };
  private readonly bounds: SceneBounds;
  private readonly collisionRadius: number;
  private readonly movement: { walkSpeed: number; sprintMultiplier: number };
  private readonly jumpAbility?: PlayerJumpComponent;
  private readonly updateMovementState?: TopDownControllerOptions['updateMovementState'];
  private readonly resolveWalkSpeed?: TopDownControllerOptions['resolveWalkSpeed'];
  private readonly resolveCollision?: TopDownControllerOptions['resolveCollision'];
  private readonly sampleGroundHeight?: TopDownControllerOptions['sampleGroundHeight'];
  private readonly raycastGround?: TopDownControllerOptions['raycastGround'];
  private readonly cameraCollisionEnabled: boolean;
  private readonly cameraProbe?: CameraProbe;
  private readonly cameraBoom = new CameraBoom();
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
    this.cameraOffset = options.cameraOffset ?? [5.5, 7.5, 8.5];
    this.bounds = options.bounds ?? PLAYER_BOUNDS;
    this.collisionRadius = Math.max(0, options.collisionRadius ?? 0);
    this.movement = options.movement ?? {
      walkSpeed: PLAYER_MOVE_SPEED,
      sprintMultiplier: PLAYER_SPRINT_MULTIPLIER,
    };
    this.jumpAbility = options.jumpAbility;
    this.updateMovementState = options.updateMovementState;
    this.resolveWalkSpeed = options.resolveWalkSpeed;
    this.resolveCollision = options.resolveCollision;
    this.sampleGroundHeight = options.sampleGroundHeight;
    this.raycastGround = options.raycastGround;
    this.cameraCollisionEnabled = options.cameraCollisionEnabled ?? false;
    this.cameraProbe = options.cameraProbe;
    this.fieldOfViewRadians = ((options.fieldOfViewDegrees ?? 50) * Math.PI) / 180;
    this.bindInput(input);
    this.bindPointerEvents();
  }

  public get frame(): CameraFrame {
    const target = this.cameraPivot;
    // 悬臂只改长度不改方向，所以三条相机轴与无遮挡时完全一致：
    // 鼠标射线投影、朝向解算都不需要为镜头收缩单独处理。
    const ratio = this.cameraDistanceRatio;
    const position: Vec3 = [
      target[0] + this.cameraOffset[0] * ratio,
      target[1] + this.cameraOffset[1] * ratio,
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
    return this.currentSpeed;
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
    return { x: this.player.position.x, z: this.player.position.z };
  }

  public get verticalPosition(): number {
    return this.player.position.y;
  }

  public get verticalVelocity(): number {
    return this.jumpAbility?.verticalVelocity ?? 0;
  }

  public get isGrounded(): boolean {
    return this.jumpAbility?.grounded ?? true;
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

  /** 传送或重新出生：悬臂不该把上一处的收缩量带过来。 */
  public resetCamera(): void {
    this.cameraBoom.reset();
    this.cameraDistanceRatio = 1;
  }

  public setPosition(x: number, z: number): void {
    const previous = { x: this.player.position.x, z: this.player.position.z };
    const bounded = {
      x: clampToRange(x, this.bounds.minimumX, this.bounds.maximumX),
      z: clampToRange(z, this.bounds.minimumZ, this.bounds.maximumZ),
    };
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
    if (Number.isFinite(y)) this.player.position.y = y;
  }

  public translateVertical(deltaY: number): void {
    if (Number.isFinite(deltaY)) this.player.position.y += deltaY;
  }

  /** 表面拖拽命中玩家自身时暂停左键朝向，避免同一次手势同时旋转 Actor。 */
  public setMouseFacingSuppressed(suppressed: boolean): void {
    this.mouseFacingSuppressed = suppressed;
    if (suppressed) this.mouseFacingActive = false;
  }

  public translate(deltaX: number, deltaZ: number): void {
    this.setPosition(this.player.position.x + deltaX, this.player.position.z + deltaZ);
  }

  public update(deltaSeconds: number): void {
    // 镜头必须先解算：即使输入被 UI 接管，角色仍可能被服务端和解拉着走，
    // 这时镜头照样要躲开挡在中间的树。
    this.updateCameraBoom(deltaSeconds);
    this.updateVerticalMotion(deltaSeconds);
    if (!this.enabled) return;
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
      // 本地预测：和房间进程跑同一份 applyPlayerMovement，输入一致则结果一致。
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
      const groundPoint = this.projectPointerToGameplayPlane();
      if (groundPoint) {
        const deltaX = groundPoint.x - this.player.position.x;
        const deltaY = groundPoint.y - this.player.position.z;
        if (Math.hypot(deltaX, deltaY) > 0.08) {
          const targetYaw = Math.atan2(deltaX, deltaY);
          this.facingYaw = lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 14));
        }
      }
    } else if (inputLength > 0) {
      const targetYaw = Math.atan2(this.moveX, this.moveZ);
      this.facingYaw = lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 10));
    }
    this.facingYaw = normalizeAngle(this.facingYaw);
    this.player.rotation.y = this.facingYaw;
    this.resolveLanding();
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
    this.cameraDistanceRatio = this.cameraBoom.solve(
      this.cameraPivot,
      this.cameraOffset,
      deltaSeconds,
      this.cameraCollisionEnabled ? this.cameraProbe : undefined,
    );
  }

  public dispose(): void {
    for (const dispose of this.inputDisposers.splice(0)) dispose();
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
  };

  private readonly handlePointerLeave = (): void => {
    this.pointer.available = false;
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

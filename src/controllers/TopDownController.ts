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

export interface TopDownControllerOptions {
  enabled?: boolean;
  cameraOffset?: Vec3;
  fieldOfViewDegrees?: number;
  bounds?: SceneBounds;
}

export class TopDownController {
  private readonly canvas: HTMLCanvasElement;
  private readonly player: THREE.Object3D;
  private readonly inputDisposers: Array<() => void> = [];
  private readonly cameraOffset: Vec3;
  private readonly fieldOfViewRadians: number;
  private readonly pointer = { x: 0, y: 0, available: false };
  private readonly movementInput = { x: 0, y: 0 };
  private readonly bounds: SceneBounds;
  private enabled: boolean;
  private facingYaw = Math.PI;
  private currentSpeed = 0;
  private moveX = 0;
  private moveZ = 0;
  private sprinting = false;

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
    this.fieldOfViewRadians = ((options.fieldOfViewDegrees ?? 50) * Math.PI) / 180;
    this.bindInput(input);
    this.bindPointerEvents();
  }

  public get frame(): CameraFrame {
    const target: Vec3 = [this.player.position.x, 0.25, this.player.position.z];
    const position: Vec3 = [
      target[0] + this.cameraOffset[0],
      target[1] + this.cameraOffset[1],
      target[2] + this.cameraOffset[2],
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

  public get position(): { x: number; z: number } {
    return { x: this.player.position.x, z: this.player.position.z };
  }

  /** 上行的一帧输入：只描述意图，位置留给服务端算。 */
  public get inputFrame(): PlayerInputFrame {
    return {
      move: { x: this.moveX, z: this.moveZ },
      sprint: this.sprinting,
      yaw: normalizeAngle(this.facingYaw),
    };
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
    }
  }

  public setPosition(x: number, z: number): void {
    this.player.position.x = clampToRange(x, this.bounds.minimumX, this.bounds.maximumX);
    this.player.position.z = clampToRange(z, this.bounds.minimumZ, this.bounds.maximumZ);
  }

  public translate(deltaX: number, deltaZ: number): void {
    this.setPosition(this.player.position.x + deltaX, this.player.position.z + deltaZ);
  }

  public update(deltaSeconds: number): void {
    if (!this.enabled) return;

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
      );
      this.player.position.x = next.x;
      this.player.position.z = next.z;
      const speed = PLAYER_MOVE_SPEED * (this.sprinting ? PLAYER_SPRINT_MULTIPLIER : 1);
      this.currentSpeed += (speed - this.currentSpeed) * Math.min(1, deltaSeconds * 12);
    } else {
      this.currentSpeed += (0 - this.currentSpeed) * Math.min(1, deltaSeconds * 10);
    }

    const groundPoint = this.projectPointerToGameplayPlane();
    if (groundPoint) {
      const deltaX = groundPoint.x - this.player.position.x;
      const deltaY = groundPoint.y - this.player.position.z;
      if (Math.hypot(deltaX, deltaY) > 0.08) {
        const targetYaw = Math.atan2(deltaX, deltaY);
        this.facingYaw = lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 14));
      }
    } else if (inputLength > 0) {
      const targetYaw = Math.atan2(this.moveX, this.moveZ);
      this.facingYaw = lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 10));
    }
    this.facingYaw = normalizeAngle(this.facingYaw);
    this.player.rotation.y = this.facingYaw;
  }

  public dispose(): void {
    for (const dispose of this.inputDisposers.splice(0)) dispose();
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
    );
  }

  private bindPointerEvents(): void {
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
}

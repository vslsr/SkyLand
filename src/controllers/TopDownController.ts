import type { CameraFrame } from '../camera/CameraTransform';
import type { CameraAxes } from '../camera/cameraMath';
import { createCameraViewMatrix } from '../camera/cameraMath';
import type { Vec3 } from '../math/vec3';
import { cross, normalize } from '../math/vec3';
import type * as THREE from 'three';

export interface TopDownControllerOptions {
  enabled?: boolean;
  moveSpeed?: number;
  sprintMultiplier?: number;
  cameraOffset?: Vec3;
  fieldOfViewDegrees?: number;
  bounds?: {
    minimumX: number;
    maximumX: number;
    minimumY: number;
    maximumY: number;
  };
}

export interface TopDownInputFrame {
  move: { x: number; y: number; z: number };
  look: { yaw: number; pitch: number };
}

const DEFAULT_BOUNDS = {
  minimumX: -16,
  maximumX: 16,
  minimumY: -21,
  maximumY: 11,
};

export class TopDownController {
  private readonly canvas: HTMLCanvasElement;
  private readonly player: THREE.Object3D;
  private readonly pressedKeys = new Set<string>();
  private readonly cameraOffset: Vec3;
  private readonly moveSpeed: number;
  private readonly sprintMultiplier: number;
  private readonly fieldOfViewRadians: number;
  private readonly bounds: TopDownControllerOptions['bounds'];
  private readonly pointer = { x: 0, y: 0, available: false };
  private enabled: boolean;
  private facingYaw = Math.PI;
  private currentSpeed = 0;
  private moveX = 0;
  private moveZ = 0;

  public constructor(canvas: HTMLCanvasElement, player: THREE.Object3D, options: TopDownControllerOptions = {}) {
    this.canvas = canvas;
    this.player = player;
    this.enabled = options.enabled ?? true;
    this.moveSpeed = options.moveSpeed ?? 3.2;
    this.sprintMultiplier = options.sprintMultiplier ?? 1.65;
    this.cameraOffset = options.cameraOffset ?? [5.5, 7.5, 8.5];
    this.fieldOfViewRadians = ((options.fieldOfViewDegrees ?? 50) * Math.PI) / 180;
    this.bounds = options.bounds ?? DEFAULT_BOUNDS;
    this.bindEvents();
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

  public get inputFrame(): TopDownInputFrame {
    return {
      move: { x: this.moveX, y: 0, z: this.moveZ },
      look: { yaw: this.facingYaw, pitch: 0 },
    };
  }

  public setInputEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pressedKeys.clear();
      this.currentSpeed = 0;
      this.moveX = 0;
      this.moveZ = 0;
    }
  }

  public update(deltaSeconds: number): void {
    if (!this.enabled) return;

    const localX = Number(this.pressedKeys.has('KeyD')) - Number(this.pressedKeys.has('KeyA'));
    const localY = Number(this.pressedKeys.has('KeyW')) - Number(this.pressedKeys.has('KeyS'));
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
      const sprinting = this.pressedKeys.has('ShiftLeft') || this.pressedKeys.has('ShiftRight');
      const speed = this.moveSpeed * (sprinting ? this.sprintMultiplier : 1);
      this.player.position.x = this.clamp(
        this.player.position.x + this.moveX * speed * deltaSeconds,
        this.bounds?.minimumX ?? DEFAULT_BOUNDS.minimumX,
        this.bounds?.maximumX ?? DEFAULT_BOUNDS.maximumX,
      );
      this.player.position.z = this.clamp(
        this.player.position.z + this.moveZ * speed * deltaSeconds,
        this.bounds?.minimumY ?? DEFAULT_BOUNDS.minimumY,
        this.bounds?.maximumY ?? DEFAULT_BOUNDS.maximumY,
      );
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
        this.facingYaw = this.lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 14));
      }
    } else if (inputLength > 0) {
      const targetYaw = Math.atan2(this.moveX, this.moveZ);
      this.facingYaw = this.lerpAngle(this.facingYaw, targetYaw, Math.min(1, deltaSeconds * 10));
    }
    this.player.rotation.y = this.facingYaw;
  }

  public dispose(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerenter', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    window.removeEventListener('blur', this.clearInput);
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

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || this.isTextEntry(event.target)) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      this.pressedKeys.add(event.code);
      event.preventDefault();
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressedKeys.delete(event.code);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    this.pointer.available = true;
  };

  private readonly handlePointerLeave = (): void => {
    this.pointer.available = false;
  };

  private readonly clearInput = (): void => this.pressedKeys.clear();

  private bindEvents(): void {
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerenter', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('blur', this.clearInput);
  }

  private isTextEntry(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  }

  private lerpAngle(current: number, target: number, amount: number): number {
    const difference = ((target - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return current + difference * amount;
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }
}

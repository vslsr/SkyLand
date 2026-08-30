import type { Mat4 } from '../math/mat4';
import type { Vec3 } from '../math/vec3';
import { assertCameraInvariant, runCameraMathSelfTest } from './cameraInvariant';
import {
  calculateCameraAxes,
  createCameraViewMatrix,
  localDirectionToWorld,
  type CameraAxes,
  type LocalDirection,
} from './cameraMath';

export interface CameraFrame {
  position: Vec3;
  axes: CameraAxes;
  viewMatrix: Mat4;
}

export interface CameraTransformOptions {
  position?: Vec3;
  yaw?: number;
  pitch?: number;
}

export class CameraTransform {
  public position: Vec3;
  public yaw: number;
  public pitch: number;

  private orientationVersion = 0;
  private validatedVersion = -1;

  public constructor(options: CameraTransformOptions = {}) {
    runCameraMathSelfTest();
    this.position = options.position ? [...options.position] : [0, 3.6, 18];
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? 0.13;
  }

  public get axes(): CameraAxes {
    return calculateCameraAxes(this.yaw, this.pitch);
  }

  public get frame(): CameraFrame {
    const axes = this.axes;
    const viewMatrix = createCameraViewMatrix(this.position, axes);
    if (this.validatedVersion !== this.orientationVersion) {
      assertCameraInvariant(axes, viewMatrix);
      this.validatedVersion = this.orientationVersion;
    }
    return { position: [...this.position], axes, viewMatrix };
  }

  public rotate(yawDelta: number, pitchDelta: number): void {
    this.yaw += yawDelta;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + pitchDelta));
    this.orientationVersion += 1;
  }

  public moveLocal(direction: LocalDirection, distance: number): void {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (length === 0) return;

    const normalizedLocal: LocalDirection = [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length,
    ];
    const worldDirection = localDirectionToWorld(this.axes, normalizedLocal);
    this.position[0] += worldDirection[0] * distance;
    this.position[1] += worldDirection[1] * distance;
    this.position[2] += worldDirection[2] * distance;
  }
}

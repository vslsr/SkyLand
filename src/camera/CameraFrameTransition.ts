import type { CameraFrame } from './CameraTransform';
import { createCameraViewMatrix, type CameraAxes } from './cameraMath';
import type { Vec3 } from '../math/vec3';
import { cross, normalize } from '../math/vec3';

export interface CameraFrameTransitionOptions {
  durationSeconds?: number;
}

const DEFAULT_TRANSITION_DURATION_SECONDS = 0.45;

function copyFrame(frame: CameraFrame): CameraFrame {
  const axes: CameraAxes = {
    right: [...frame.axes.right],
    up: [...frame.axes.up],
    forward: [...frame.axes.forward],
  };
  const position: Vec3 = [...frame.position];
  return { position, axes, viewMatrix: createCameraViewMatrix(position, axes) };
}

function mixVector(from: Vec3, to: Vec3, amount: number): Vec3 {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function normalizedOr(value: Vec3, fallback: Vec3): Vec3 {
  return Math.hypot(value[0], value[1], value[2]) > 1e-6
    ? normalize(value)
    : [...fallback];
}

/** 在两套控制器的相机帧之间做一次有明确终点的客户端过渡。 */
export class CameraFrameTransition {
  private readonly durationSeconds: number;
  private source?: CameraFrame;
  private elapsedSeconds = 0;

  public constructor(options: CameraFrameTransitionOptions = {}) {
    this.durationSeconds = Math.max(
      0,
      options.durationSeconds ?? DEFAULT_TRANSITION_DURATION_SECONDS,
    );
  }

  public begin(source: CameraFrame): void {
    this.source = this.durationSeconds > 0 ? copyFrame(source) : undefined;
    this.elapsedSeconds = 0;
  }

  public update(deltaSeconds: number): void {
    if (!this.source) return;
    const seconds = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    this.elapsedSeconds += seconds;
    if (this.elapsedSeconds >= this.durationSeconds) this.source = undefined;
  }

  public resolve(target: CameraFrame): CameraFrame {
    if (!this.source) return target;
    const progress = Math.min(1, this.elapsedSeconds / this.durationSeconds);
    const amount = progress * progress * (3 - 2 * progress);
    const position = mixVector(this.source.position, target.position, amount);
    const forward = normalizedOr(
      mixVector(this.source.axes.forward, target.axes.forward, amount),
      target.axes.forward,
    );
    const upHint = normalizedOr(
      mixVector(this.source.axes.up, target.axes.up, amount),
      target.axes.up,
    );
    const right = normalizedOr(cross(forward, upHint), target.axes.right);
    const up = normalizedOr(cross(right, forward), target.axes.up);
    const axes: CameraAxes = { right, up, forward };
    return { position, axes, viewMatrix: createCameraViewMatrix(position, axes) };
  }
}

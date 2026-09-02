import type { Vec3 } from '../math/vec3';

export interface TopDownCameraOrbitOptions {
  /** 水平拖拽灵敏度（弧度/像素），与参考项目保持一致。 */
  yawSensitivity?: number;
  /** 垂直拖拽灵敏度（弧度/像素）。 */
  pitchSensitivity?: number;
  /** 俯角下限；留在地平线之上，避免 TopDown 镜头翻到角色下方。 */
  minimumPitch?: number;
  /** 俯角上限；避免水平前向长度趋近零。 */
  maximumPitch?: number;
  /** 拖拽余量的收敛速度。 */
  sharpness?: number;
}

const DEFAULT_YAW_SENSITIVITY = 0.0055;
const DEFAULT_PITCH_SENSITIVITY = 0.0045;
const DEFAULT_MINIMUM_PITCH = 0.05;
const DEFAULT_MAXIMUM_PITCH = 1.45;
// 参考项目每帧应用 60% 余量；这里换成与帧率无关的指数阻尼。
const DEFAULT_ORBIT_SHARPNESS = -Math.log(0.4) * 60;
const MAX_ORBIT_STEP_SECONDS = 1 / 30;
const SETTLED_RADIANS = 1e-6;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * TopDown 镜头的有界球面轨道。
 *
 * 它只保存固定数量的角度与偏移，不依赖世界大小。拖拽输入先累积，
 * update 再按参考项目的惯性手感平滑应用。
 */
export class TopDownCameraOrbit {
  private readonly distance: number;
  private readonly offset: Vec3;
  private readonly yawSensitivity: number;
  private readonly pitchSensitivity: number;
  private readonly minimumPitch: number;
  private readonly maximumPitch: number;
  private readonly sharpness: number;
  private yaw: number;
  private pitch: number;
  private pendingYaw = 0;
  private pendingPitch = 0;

  public constructor(initialOffset: Vec3, options: TopDownCameraOrbitOptions = {}) {
    const x = finiteOr(initialOffset[0], 0);
    const y = finiteOr(initialOffset[1], 0);
    const z = finiteOr(initialOffset[2], 0);
    this.offset = [x, y, z];
    this.distance = Math.hypot(x, y, z);
    this.yaw = Math.atan2(x, z);
    this.pitch = this.distance > 1e-8
      ? Math.atan2(y, Math.hypot(x, z))
      : 0;
    this.yawSensitivity = Math.max(
      0,
      finiteOr(options.yawSensitivity ?? DEFAULT_YAW_SENSITIVITY, DEFAULT_YAW_SENSITIVITY),
    );
    this.pitchSensitivity = Math.max(
      0,
      finiteOr(
        options.pitchSensitivity ?? DEFAULT_PITCH_SENSITIVITY,
        DEFAULT_PITCH_SENSITIVITY,
      ),
    );
    const configuredMinimum = finiteOr(
      options.minimumPitch ?? DEFAULT_MINIMUM_PITCH,
      DEFAULT_MINIMUM_PITCH,
    );
    const configuredMaximum = finiteOr(
      options.maximumPitch ?? DEFAULT_MAXIMUM_PITCH,
      DEFAULT_MAXIMUM_PITCH,
    );
    this.minimumPitch = Math.min(configuredMinimum, configuredMaximum, this.pitch);
    this.maximumPitch = Math.max(configuredMinimum, configuredMaximum, this.pitch);
    this.sharpness = Math.max(
      0.01,
      finiteOr(options.sharpness ?? DEFAULT_ORBIT_SHARPNESS, DEFAULT_ORBIT_SHARPNESS),
    );
  }

  public get currentOffset(): Vec3 {
    return this.offset;
  }

  /** 右拖向右旋转画面，下拖抬高镜头，与参考项目的操作方向一致。 */
  public addPointerDelta(deltaX: number, deltaY: number): void {
    if (Number.isFinite(deltaX)) this.pendingYaw -= deltaX * this.yawSensitivity;
    if (Number.isFinite(deltaY)) this.pendingPitch += deltaY * this.pitchSensitivity;
  }

  /** 中断手势或传送时丢掉尚未应用的惯性，保留用户已选定的视角。 */
  public cancelPending(): void {
    this.pendingYaw = 0;
    this.pendingPitch = 0;
  }

  public update(deltaSeconds: number): Vec3 {
    if (this.distance <= 1e-8) return this.offset;
    if (this.pendingYaw === 0 && this.pendingPitch === 0) return this.offset;
    const elapsed = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    const seconds = Math.min(elapsed, MAX_ORBIT_STEP_SECONDS);
    if (seconds <= 0) return this.offset;
    const blend = 1 - Math.exp(-this.sharpness * seconds);
    const yawStep = this.pendingYaw * blend;
    const pitchStep = this.pendingPitch * blend;
    this.pendingYaw -= yawStep;
    this.pendingPitch -= pitchStep;
    this.yaw = Math.atan2(Math.sin(this.yaw + yawStep), Math.cos(this.yaw + yawStep));
    const nextPitch = clamp(this.pitch + pitchStep, this.minimumPitch, this.maximumPitch);
    if (
      (nextPitch === this.minimumPitch && this.pendingPitch < 0)
      || (nextPitch === this.maximumPitch && this.pendingPitch > 0)
    ) {
      this.pendingPitch = 0;
    }
    this.pitch = nextPitch;
    if (Math.abs(this.pendingYaw) < SETTLED_RADIANS) this.pendingYaw = 0;
    if (Math.abs(this.pendingPitch) < SETTLED_RADIANS) this.pendingPitch = 0;

    const horizontalDistance = Math.cos(this.pitch) * this.distance;
    this.offset[0] = Math.sin(this.yaw) * horizontalDistance;
    this.offset[1] = Math.sin(this.pitch) * this.distance;
    this.offset[2] = Math.cos(this.yaw) * horizontalDistance;
    return this.offset;
  }
}

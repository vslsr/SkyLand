import type { Vec3 } from '../math/vec3';

export interface CameraFollowOptions {
  /**
   * 相机追随目标的收敛速度。数值越大越紧，越小滞后越明显。
   * 使用指数阻尼，所以相同总时长在不同帧率下得到相同结果。
   */
  sharpness?: number;
  /** 上下坡和跳跃时的纵向收敛速度；默认略快于平面追随。 */
  verticalSharpness?: number;
}

const DEFAULT_FOLLOW_SHARPNESS = 8;
const DEFAULT_VERTICAL_FOLLOW_SHARPNESS = 10;
/** 防止卡顿后的长帧把镜头在一次 update 中直接拉到目标。 */
const MAX_FOLLOW_STEP_SECONDS = 1 / 30;
const SETTLED_DISTANCE = 1e-6;

function damp(current: number, target: number, blend: number): number {
  const next = current + (target - current) * blend;
  return Math.abs(target - next) <= SETTLED_DISTANCE ? target : next;
}

/**
 * 固定三维状态的客户端相机阻尼器。
 *
 * 它平滑观察支点的三轴移动，不改玩家位置、相机偏移方向或碰撞悬臂长度；
 * 纵向阻尼略紧，以兼顾跳跃连续性和玩法 Scene 配置的 TopDown 高度。状态量不会随世界尺寸增长。
 */
export class CameraFollow {
  private readonly sharpness: number;
  private readonly verticalSharpness: number;
  private readonly current: Vec3;

  public constructor(initialPosition: Vec3, options: CameraFollowOptions = {}) {
    this.sharpness = Math.max(0.01, options.sharpness ?? DEFAULT_FOLLOW_SHARPNESS);
    this.verticalSharpness = Math.max(
      0.01,
      options.verticalSharpness ?? DEFAULT_VERTICAL_FOLLOW_SHARPNESS,
    );
    this.current = [...initialPosition];
  }

  public get position(): Vec3 {
    return this.current;
  }

  public update(target: Vec3, deltaSeconds: number): Vec3 {
    const elapsed = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    const seconds = Math.min(elapsed, MAX_FOLLOW_STEP_SECONDS);
    const planarBlend = 1 - Math.exp(-this.sharpness * seconds);
    const verticalBlend = 1 - Math.exp(-this.verticalSharpness * seconds);
    this.current[0] = damp(this.current[0], target[0], planarBlend);
    this.current[1] = damp(this.current[1], target[1], verticalBlend);
    this.current[2] = damp(this.current[2], target[2], planarBlend);
    return this.current;
  }

  /** 传送、重生或大幅网络校正时直接对齐，避免镜头横跨世界追赶。 */
  public reset(position: Vec3): void {
    this.current[0] = position[0];
    this.current[1] = position[1];
    this.current[2] = position[2];
  }
}

import type { Vec3 } from '../math/vec3';

export interface CameraFollowOptions {
  /**
   * 相机追随目标的收敛速度。数值越大越紧，越小滞后越明显。
   * 使用指数阻尼，所以相同总时长在不同帧率下得到相同结果。
   */
  sharpness?: number;
}

const DEFAULT_FOLLOW_SHARPNESS = 8;

/**
 * 固定三维状态的客户端相机阻尼器。
 *
 * 它只平滑观察支点，不改玩家位置、相机偏移方向或碰撞悬臂长度；因此不会影响
 * 权威移动，也不会让状态量随世界尺寸增长。
 */
export class CameraFollow {
  private readonly sharpness: number;
  private readonly current: Vec3;

  public constructor(initialPosition: Vec3, options: CameraFollowOptions = {}) {
    this.sharpness = Math.max(0.01, options.sharpness ?? DEFAULT_FOLLOW_SHARPNESS);
    this.current = [...initialPosition];
  }

  public get position(): Vec3 {
    return this.current;
  }

  public update(target: Vec3, deltaSeconds: number): Vec3 {
    const seconds = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    const blend = 1 - Math.exp(-this.sharpness * seconds);
    this.current[0] += (target[0] - this.current[0]) * blend;
    this.current[1] += (target[1] - this.current[1]) * blend;
    this.current[2] += (target[2] - this.current[2]) * blend;
    return this.current;
  }

  /** 传送、重生或大幅网络校正时直接对齐，避免镜头横跨世界追赶。 */
  public reset(position: Vec3): void {
    this.current[0] = position[0];
    this.current[1] = position[1];
    this.current[2] = position[2];
  }
}

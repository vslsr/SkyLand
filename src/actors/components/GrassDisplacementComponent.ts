import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { GrassInteractionTarget } from '../../grass';

export const GRASS_DISPLACEMENT_COMPONENT = 'grass-displacement';

export interface GrassDisplacementComponentOptions {
  radius?: number;
  pressurePerSecond?: number;
  /**
   * 这个 Actor 在草地足迹里的来源标识，通常就是它的 id。
   *
   * 每个来源各自攒一条有限长度的路径；省略的话所有 Actor 会被并进同一条，
   * 两名玩家分头走时中间会连出一段谁都没走过的假足迹。
   */
  sourceId?: string;
}

/**
 * 采样这个 Actor 脚下的世界坐标。
 *
 * 写成 out 参数是为了每帧零分配——原来复用 `THREE.Vector3` 也是同一个目的。
 * **y 不能省**：`canSweep` 的阈值和 `motionStrength` 都用三维距离，只回 (x, z)
 * 会让跳跃/坠落帧被当成没有位移。
 */
export interface WorldPositionSampler {
  (out: { x: number; y: number; z: number }): void;
}

const DEFAULT_RADIUS = 0.68;
const DEFAULT_PRESSURE_PER_SECOND = 3;
const MAX_DELTA_SECONDS = 0.1;
const MAX_SWEEP_DISTANCE_RADIUS_RATIO = 5;
const MOTION_PRESSURE_PER_RADIUS = 0.9;
const MAX_MOTION_PRESSURE = 0.24;

/**
 * 持续把 Actor 脚下的草向外压开；停止更新后弯曲纹理会自然回弹。
 *
 * 这个 Component 曾经直接持有一个 `THREE.Object3D` 当位置源（引擎迁移路线图
 * 第 1.5 步的棘轮清单）。现在换成采样回调与普通数字，文件里不再 import three。
 *
 * **诚实的一条**：`GrassInteractionTarget` 与这个回调仍然闭包着渲染世界的对象，
 * 所以这一步只是让 Actor 不再"持有"渲染对象，**并不等于这个 Component 已经能进
 * Sim Worker**。真正过边界时，`applyImpulse` 要变成往命令环形缓冲写一条
 * radial 冲量，位置采样要改成读 transform SoA。那是第 2 步的事。
 */
export class GrassDisplacementComponent extends ActorComponent {
  public enabled = true;
  public readonly radius: number;
  public readonly pressurePerSecond: number;
  public readonly sourceId?: string;
  private readonly worldPosition = { x: 0, y: 0, z: 0 };
  private previousWorldX = 0;
  private previousWorldY = 0;
  private previousWorldZ = 0;
  /** 上一次有效的水平移动方向。零向量是允许的取值，见 update 里的说明。 */
  private fallbackDirectionX = 1;
  private fallbackDirectionZ = 0;
  private hasPreviousWorldPosition = false;

  public constructor(
    private readonly samplePosition: WorldPositionSampler,
    private readonly target: GrassInteractionTarget,
    options: GrassDisplacementComponentOptions = {},
  ) {
    super(GRASS_DISPLACEMENT_COMPONENT);
    this.radius = positiveFiniteOr(options.radius, DEFAULT_RADIUS);
    this.pressurePerSecond = positiveFiniteOr(
      options.pressurePerSecond,
      DEFAULT_PRESSURE_PER_SECOND,
    );
    this.sourceId = options.sourceId;
  }

  public update(deltaSeconds: number): void {
    this.samplePosition(this.worldPosition);
    if (!this.enabled || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      this.rememberCurrentPosition();
      return;
    }
    const clampedDelta = Math.min(deltaSeconds, MAX_DELTA_SECONDS);
    const sustainedStrength = 1 - Math.exp(-this.pressurePerSecond * clampedDelta);
    const deltaX = this.worldPosition.x - this.previousWorldX;
    const deltaY = this.worldPosition.y - this.previousWorldY;
    const deltaZ = this.worldPosition.z - this.previousWorldZ;
    // 三维距离：竖直位移也算移动，否则跳跃帧会被当成原地不动。
    const travelDistance = this.hasPreviousWorldPosition
      ? Math.hypot(deltaX, deltaY, deltaZ)
      : 0;
    const canSweep = this.hasPreviousWorldPosition
      && travelDistance <= this.radius * MAX_SWEEP_DISTANCE_RADIUS_RATIO;
    if (canSweep && travelDistance > 0.0001) {
      // 守卫用的是三维距离，但归一化的是水平分量：纯竖直位移能通过守卫、水平长度
      // 却是 0。原来靠 THREE.Vector2.normalize() 内部的 `length() || 1` 兜住，
      // 结果是方向变成 (0, 0) 而不是 NaN。这里必须原样复刻这个行为。
      const horizontalLength = Math.hypot(deltaX, deltaZ) || 1;
      this.fallbackDirectionX = deltaX / horizontalLength;
      this.fallbackDirectionZ = deltaZ / horizontalLength;
    }
    const motionStrength = canSweep
      ? Math.min(
        MAX_MOTION_PRESSURE,
        (travelDistance / this.radius) * MOTION_PRESSURE_PER_RADIUS,
      )
      : 0;
    const strength = Math.min(1, sustainedStrength + motionStrength);
    this.applyPressure(
      canSweep ? this.previousWorldX : this.worldPosition.x,
      canSweep ? this.previousWorldZ : this.worldPosition.z,
      this.worldPosition.x,
      this.worldPosition.z,
      strength,
      this.fallbackDirectionX,
      this.fallbackDirectionZ,
    );
    this.rememberCurrentPosition();
  }

  private applyPressure(
    startPositionX: number,
    startPositionZ: number,
    positionX: number,
    positionZ: number,
    strength: number,
    directionX: number,
    directionZ: number,
  ): void {
    this.target.applyImpulse({
      mode: 'radial',
      sourceId: this.sourceId,
      startPosition: { x: startPositionX, z: startPositionZ },
      position: { x: positionX, z: positionZ },
      direction: { x: directionX, z: directionZ },
      radius: this.radius,
      strength,
    });
  }

  private rememberCurrentPosition(): void {
    this.previousWorldX = this.worldPosition.x;
    this.previousWorldY = this.worldPosition.y;
    this.previousWorldZ = this.worldPosition.z;
    this.hasPreviousWorldPosition = true;
  }
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

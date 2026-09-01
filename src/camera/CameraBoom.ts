import type { Vec3 } from '../math/vec3';

/**
 * 相机探针：从角色到期望机位扫掠一个球，返回最早被挡住的线段参数。
 * 没有任何遮挡时返回 1。
 */
export type CameraProbe = (
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  radius: number,
) => number;

export interface CameraBoomOptions {
  /**
   * 探针球半径。它决定镜头离墙面留多少空隙：太小会让近裁剪面切进墙里，
   * 太大则在狭窄处把镜头推得过近。要和 PerspectiveCamera 的 near 匹配。
   */
  probeRadius?: number;
  /** 悬臂最短能收到原长的百分之多少，避免完全贴到角色脸上。 */
  minimumRatio?: number;
  /** 障碍让开后悬臂伸回去的速度（每秒恢复的比例），收回时不用它。 */
  extendSpeed?: number;
}

const DEFAULT_PROBE_RADIUS = 0.32;
/**
 * 悬臂长度的下限。取 0.25 而不是更小：树冠的最宽处就在离地 0.6 米，玩家贴着
 * 树站着时确实是站在枝叶底下，悬臂会一路收到下限；下限太小会让镜头贴到
 * 角色脸上，在林子里穿行时观感比偶尔穿一点模还糟。
 */
const DEFAULT_MINIMUM_RATIO = 0.25;
const DEFAULT_EXTEND_SPEED = 2.4;

/**
 * 第三人称相机悬臂（spring arm）。
 *
 * 第三人称镜头穿模的根源是：机位由「角色位置 + 固定偏移」直接算出，这条
 * 计算里没有世界的存在，于是角色贴着树或者走进屋檐下时，机位就落在了几何体
 * 内部——近裁剪面把模型切开，或者干脆看见背面。
 *
 * 悬臂的做法是把机位当成一根从角色伸出去的杆子：每帧沿杆子扫掠一个球，
 * 撞上东西就把杆子缩到撞击点之前。杆子的方向不变，所以镜头朝向、鼠标射线
 * 投影这些都不受影响，只有距离在变。
 *
 * 收放不对称是刻意的：
 * - **收（撞上障碍）立即生效**。晚一帧就是穿模一帧，这是这套东西存在的理由。
 * - **放（障碍让开）按 extendSpeed 平滑**。瞬间弹回去会让画面猛地一跳，
 *   贴着树跑动时更会变成来回抽搐。
 */
export class CameraBoom {
  private readonly probeRadius: number;
  private readonly minimumRatio: number;
  private readonly extendSpeed: number;
  private ratio = 1;

  public constructor(options: CameraBoomOptions = {}) {
    this.probeRadius = Math.max(0, options.probeRadius ?? DEFAULT_PROBE_RADIUS);
    this.minimumRatio = Math.min(1, Math.max(0, options.minimumRatio ?? DEFAULT_MINIMUM_RATIO));
    this.extendSpeed = Math.max(0, options.extendSpeed ?? DEFAULT_EXTEND_SPEED);
  }

  /** 当前悬臂水平距离占原长的比例；TopDown 的配置高度由调用方独立保留。 */
  public get distanceRatio(): number {
    return this.ratio;
  }

  /** 传送、切换场景或重新出生后调用，避免把上一处的收缩量带到新位置。 */
  public reset(): void {
    this.ratio = 1;
  }

  /**
   * 解算这一帧的悬臂长度。
   * @param pivot 悬臂支点，通常是角色胸口高度的一点
   * @param offset 无遮挡时机位相对支点的偏移
   * @param deltaSeconds 帧时长
   * @param probe 场景探针；没有探针（例如还没进房间）时悬臂保持全长
   */
  public solve(
    pivot: Vec3,
    offset: Vec3,
    deltaSeconds: number,
    probe?: CameraProbe,
  ): number {
    if (!probe) {
      this.ratio = 1;
      return this.ratio;
    }

    // 始终按「全长」扫掠，而不是按当前收缩后的长度：只有这样，障碍让开之后
    // 悬臂才知道自己可以再伸出去多远。
    const desired: Vec3 = [
      pivot[0] + offset[0],
      pivot[1] + offset[1],
      pivot[2] + offset[2],
    ];
    const hit = probe(pivot, desired, this.probeRadius);
    const target = Math.min(1, Math.max(this.minimumRatio, Number.isFinite(hit) ? hit : 1));

    if (target <= this.ratio) {
      this.ratio = target;
    } else {
      const step = Math.min(1, Math.max(0, deltaSeconds) * this.extendSpeed);
      this.ratio += (target - this.ratio) * step;
    }
    return this.ratio;
  }
}

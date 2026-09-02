/**
 * 蒙皮体积流动：胡克蒙皮本身只有“各自回到锚点”的局部弹性，
 * 一处被压凹、被拉出或被地形掏空时，其余部分完全不知情，空隙就会一直留在那里。
 * 这一层给整张外壳补上流体才有的全局耦合：
 * 把蒙皮相对静止形状丢失/多出的体积按重力权重重新分配回锚点，
 * 缺体积时下侧优先向外下方补（空隙自动下坠填充），多体积时上侧优先回抽并塌陷。
 *
 * 成本只与固定的外壳顶点数相关，与世界尺寸、Actor 数量无关；
 * 静止时体积误差为 0，补偿量随之衰减到 0，因此不会阻止蒙皮休眠。
 */

/** 体积误差到径向补偿的增益；闭环由 RESPONSE_RATE 限速，取值偏保守以免过冲。 */
const FILL_GAIN = 0.62;
/** 补偿量的一阶跟随速率，约 0.33 秒到达目标的 90%，读起来像黏稠流体而非弹簧。 */
const RESPONSE_RATE = 6.5;
/** 单顶点补偿的硬上限，避免低帧率或极端拖拽把外壳翻出去。 */
const MAX_OFFSET_RADIUS_RATIO = 0.24;
/** 体积误差的截断比例；超过此值只按上限持续补偿，不会指数放大。 */
const MAX_VOLUME_ERROR_RATIO = 0.42;
/** 补偿里沿重力方向下坠的比例，其余沿法线向外/向内。 */
const DOWNWARD_FLOW_RATIO = 0.42;
/** 补偿权重的各向同性底噪，保证极点附近也参与流动。 */
const ISOTROPIC_WEIGHT = 0.3;
/** 局部空隙对分配权重的占比：材料优先流向真正缺料的那一侧，而不是整圈均匀鼓胀。 */
const LOCAL_ROOM_WEIGHT = 0.65;

export interface HybridSlimeVolumeFlowOptions {
  readonly radius: number;
  readonly floorY: number;
}

export class HybridSlimeVolumeFlow {
  /** 逐顶点的有符号径向补偿量；正数向外补，负数向内抽。 */
  public readonly offsets: Float32Array;

  private readonly vertexCount: number;
  /** 归一化立体角权重：经纬球拓扑在两极堆点，等权求和会严重高估极区体积。 */
  private readonly solidAngles: Float32Array;
  /** 缺体积时的分配权重，下半球更大：流体先往低处补。 */
  private readonly fillWeights: Float32Array;
  /** 多体积时的抽取权重，上半球更大：材料先从顶部塌下来。 */
  private readonly drainWeights: Float32Array;
  /** 每步重算的实际分配权重：重力权重 × 局部缺料程度。 */
  private readonly flowWeights: Float32Array;
  private readonly anchorRadii: Float32Array;
  private readonly shellRadii: Float32Array;
  private volumeError = 0;

  public constructor(
    private readonly directions: Float32Array,
    private readonly options: HybridSlimeVolumeFlowOptions,
  ) {
    this.vertexCount = directions.length / 3;
    if (!Number.isInteger(this.vertexCount) || this.vertexCount <= 0) {
      throw new Error('蒙皮体积流动需要非空的三维蒙皮方向');
    }
    this.offsets = new Float32Array(this.vertexCount);
    this.solidAngles = new Float32Array(this.vertexCount);
    this.fillWeights = new Float32Array(this.vertexCount);
    this.drainWeights = new Float32Array(this.vertexCount);
    this.flowWeights = new Float32Array(this.vertexCount);
    this.anchorRadii = new Float32Array(this.vertexCount);
    this.shellRadii = new Float32Array(this.vertexCount);

    let solidAngleSum = 0;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const directionY = directions[offset + 1];
      const solidAngle = Math.max(
        1e-3,
        Math.hypot(directions[offset], directions[offset + 2]),
      );
      this.solidAngles[vertex] = solidAngle;
      solidAngleSum += solidAngle;
      const lower = (1 - directionY) * 0.5;
      this.fillWeights[vertex] = ISOTROPIC_WEIGHT + (1 - ISOTROPIC_WEIGHT) * lower;
      this.drainWeights[vertex] = ISOTROPIC_WEIGHT + (1 - ISOTROPIC_WEIGHT) * (1 - lower);
    }
    const inverseSum = 1 / solidAngleSum;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      this.solidAngles[vertex] *= inverseSum;
    }
    this.normalizeWeights(this.fillWeights);
    this.normalizeWeights(this.drainWeights);
  }

  /** 上一次求解出的体积误差比例；正数表示外壳内部还有未填满的空隙。 */
  public get lastVolumeError(): number {
    return this.volumeError;
  }

  public reset(): void {
    this.offsets.fill(0);
    this.volumeError = 0;
  }

  /**
   * 用当前蒙皮与静止锚点的体积差，把锚点改写成“流体应该在的位置”。
   * 传入的 anchors 必须是本步刚重建、尚未被补偿过的静止形状。
   */
  public apply(
    anchors: Float32Array,
    positions: Float32Array,
    center: Float32Array,
    deltaSeconds: number,
  ): void {
    if (!(deltaSeconds > 0)) return;
    const restVolume = this.measureVolume(anchors, center, this.anchorRadii);
    if (!(restVolume > 1e-9)) return;
    const shellVolume = this.measureVolume(positions, center, this.shellRadii);
    const rawError = (restVolume - shellVolume) / restVolume;
    this.volumeError = Math.max(
      -MAX_VOLUME_ERROR_RATIO,
      Math.min(MAX_VOLUME_ERROR_RATIO, Number.isFinite(rawError) ? rawError : 0),
    );

    const weights = this.buildFlowWeights(this.volumeError >= 0);
    const targetScale = this.volumeError * FILL_GAIN * this.options.radius;
    const maximumOffset = this.options.radius * MAX_OFFSET_RADIUS_RATIO;
    const follow = 1 - Math.exp(-RESPONSE_RATE * deltaSeconds);
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const target = Math.max(
        -maximumOffset,
        Math.min(maximumOffset, targetScale * weights[vertex]),
      );
      const value = this.offsets[vertex] + (target - this.offsets[vertex]) * follow;
      this.offsets[vertex] = Math.max(-maximumOffset, Math.min(maximumOffset, value));
      const offset = vertex * 3;
      const amount = this.offsets[vertex];
      const radial = amount * (1 - DOWNWARD_FLOW_RATIO);
      anchors[offset] += this.directions[offset] * radial;
      // 补进去和抽走的材料都往下走：补是下坠填空隙，抽是顶部塌陷，因此按绝对值取符号。
      // 下限取“地面”与该顶点原有高度中更低的一个：贴地时不穿地，
      // 离地形态的闭合椭球下半球本就低于地面高度，此时只保证流动不再额外向下。
      const minimumY = Math.min(anchors[offset + 1], this.options.floorY);
      anchors[offset + 1] = Math.max(
        minimumY,
        anchors[offset + 1]
          + this.directions[offset + 1] * radial
          - Math.abs(amount) * DOWNWARD_FLOW_RATIO,
      );
      anchors[offset + 2] += this.directions[offset + 2] * radial;
    }
  }

  /**
   * 以固定方向上的投影半径估算封闭外壳体积（省略公共系数 4π/3）。
   * 顶点方向是常量，因此这里不需要三角形遍历也能保持单调、可比较的体积度量。
   */
  public measureVolume(
    shell: Float32Array,
    center: Float32Array,
    radiiOutput?: Float32Array,
  ): number {
    let volume = 0;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const radius = Math.max(
        0,
        (shell[offset] - center[0]) * this.directions[offset]
        + (shell[offset + 1] - center[1]) * this.directions[offset + 1]
        + (shell[offset + 2] - center[2]) * this.directions[offset + 2],
      );
      if (radiiOutput) radiiOutput[vertex] = radius;
      volume += this.solidAngles[vertex] * radius * radius * radius;
    }
    return volume;
  }

  /**
   * 重力权重再乘上局部材料分布：
   * 缺体积时材料流向空隙最大的一侧，空隙由就近的蒙皮下坠填上，而不是整只史莱姆一起鼓胀；
   * 多体积时材料从没有被外力拉住的本体抽走，被拖出的那块自己不会再供料，于是本体塌下去。
   */
  private buildFlowWeights(filling: boolean): Float32Array {
    const base = filling ? this.fillWeights : this.drainWeights;
    let maximumLocal = 0;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const local = filling
        ? this.anchorRadii[vertex] - this.shellRadii[vertex]
        : this.shellRadii[vertex] - this.anchorRadii[vertex];
      this.flowWeights[vertex] = Math.max(0, local);
      maximumLocal = Math.max(maximumLocal, this.flowWeights[vertex]);
    }
    const inverseMaximum = maximumLocal > 1e-6 ? 1 / maximumLocal : 0;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      const normalizedLocal = this.flowWeights[vertex] * inverseMaximum;
      const localFactor = filling ? normalizedLocal : 1 - normalizedLocal;
      this.flowWeights[vertex] = base[vertex] * (
        1 - LOCAL_ROOM_WEIGHT + LOCAL_ROOM_WEIGHT * localFactor
      );
    }
    this.normalizeWeights(this.flowWeights);
    return this.flowWeights;
  }

  private normalizeWeights(weights: Float32Array): void {
    let weightedSum = 0;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      weightedSum += this.solidAngles[vertex] * weights[vertex];
    }
    if (!(weightedSum > 1e-9)) return;
    const inverse = 1 / weightedSum;
    for (let vertex = 0; vertex < this.vertexCount; vertex += 1) {
      weights[vertex] *= inverse;
    }
  }
}

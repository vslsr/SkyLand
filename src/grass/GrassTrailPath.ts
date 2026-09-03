/**
 * 一条被压过的草地路径。
 *
 * 为什么是「路径」而不是继续往一张纹理里累积：纹理是 GPU 上的历史，
 * 换窗口要重投影、会在边缘丢失，更关键的是它没法过网络。路径是**数据**——
 * 一串定长的世界坐标点，谁拿到都能算出同一片被压倒的草，因此
 *
 * - 弯曲纹理每帧都能从零重建，滑动窗口移动或大幅传送都不需要重投影；
 * - 新流进来的 chunk 立刻带着已经存在的脚印，而不是从中性状态开始；
 * - 点数有上界，可以直接编码进快照（见 `encodeGrassTrailPath`）。
 *
 * 长度上界是设计约束不是优化：每条路径最多 `capacity` 个点，写满之后覆盖
 * 最旧的一个，所以单条路径的内存、网络字节数和绘制开销都与玩家走了多远无关。
 */

/** 每条路径的默认点数上界。24 点 × 0.3 米间距 ≈ 7 米可见足迹。 */
export const GRASS_TRAIL_POINT_CAPACITY = 24;

/** 相邻两点的最小世界间距（米）。更近的输入合并进最新点，站着不动不吃点数。 */
export const GRASS_TRAIL_MINIMUM_SPACING = 0.3;

/** 压痕回弹的时间常数（秒）：强度按 exp(-age / 这个值) 衰减。 */
export const GRASS_TRAIL_RECOVERY_SECONDS = 1.8;

/** 衰减到这个强度以下的点直接丢弃，免得留一串看不见但还要绘制的尾巴。 */
export const GRASS_TRAIL_MINIMUM_STRENGTH = 0.02;

/** 网络编码的字节布局版本。改布局必须同时改这个数。 */
export const GRASS_TRAIL_WIRE_VERSION = 1;

const WIRE_HEADER_BYTES = 12;
const WIRE_BYTES_PER_POINT = 8;
/**
 * 坐标按厘米量化，且是**相对路径锚点**的增量。
 *
 * 存绝对坐标的话 int16 就把世界锁死在 ±327 米以内，世界一放大就会在远处
 * 静默截断成错误的足迹。改成相对锚点之后，量程只需要覆盖一条路径自己的
 * 跨度（上界是点数 × 单步上限，几十米），与世界尺寸无关。
 */
const POSITION_QUANTIZATION = 100;
/** 半径量化到 2 厘米，uint8 覆盖 5.1 米，比交互半径的上限还宽。 */
const RADIUS_QUANTIZATION = 50;
/** 年龄量化到 20 毫秒，uint8 覆盖 5.1 秒，超出的点本来就已经被丢弃。 */
const AGE_QUANTIZATION = 50;
const MAXIMUM_QUANTIZED_AGE = 255 / AGE_QUANTIZATION;
/** 线格式的点数是一个字节，容量因此不能超过它。 */
const MAXIMUM_WIRE_POINTS = 255;

export interface GrassTrailPoint {
  x: number;
  z: number;
  radius: number;
  /** 刚压下时的强度，0..1。当前可见强度还要乘上年龄衰减。 */
  strength: number;
  /** 压下之后经过的秒数。 */
  age: number;
}

export interface GrassTrailPathOptions {
  capacity?: number;
  minimumSpacing?: number;
  recoverySeconds?: number;
}

export class GrassTrailPath {
  public readonly capacity: number;
  public readonly minimumSpacing: number;
  public readonly recoverySeconds: number;

  private readonly positionsX: Float32Array;
  private readonly positionsZ: Float32Array;
  private readonly radii: Float32Array;
  private readonly strengths: Float32Array;
  private readonly ages: Float32Array;
  /** 环形缓冲里最旧的一个点。 */
  private oldestIndex = 0;
  private pointCount = 0;

  public constructor(options: GrassTrailPathOptions = {}) {
    // 上界卡在 255：编码时点数就是一个字节，容量不能大到编不下。
    this.capacity = Math.min(MAXIMUM_WIRE_POINTS, Math.max(2, Math.floor(
      positiveFiniteOr(options.capacity, GRASS_TRAIL_POINT_CAPACITY),
    )));
    this.minimumSpacing = positiveFiniteOr(
      options.minimumSpacing,
      GRASS_TRAIL_MINIMUM_SPACING,
    );
    this.recoverySeconds = positiveFiniteOr(
      options.recoverySeconds,
      GRASS_TRAIL_RECOVERY_SECONDS,
    );
    this.positionsX = new Float32Array(this.capacity);
    this.positionsZ = new Float32Array(this.capacity);
    this.radii = new Float32Array(this.capacity);
    this.strengths = new Float32Array(this.capacity);
    this.ages = new Float32Array(this.capacity);
  }

  public get length(): number {
    return this.pointCount;
  }

  public get isEmpty(): boolean {
    return this.pointCount === 0;
  }

  /** 最新一个点的世界坐标；空路径返回 undefined。 */
  public get head(): Readonly<{ x: number; z: number }> | undefined {
    if (this.pointCount === 0) return undefined;
    const index = this.slotOf(this.pointCount - 1);
    return { x: this.positionsX[index], z: this.positionsZ[index] };
  }

  /**
   * 追加一次踩踏。
   *
   * 距离最新点不到 `minimumSpacing` 时不新开点，而是把最新点挪过去、取更大的
   * 强度并把年龄归零：原地踏步应该让脚下这一处一直塌着，而不是把整条路径的
   * 点数吃光，让身后的足迹凭空消失。
   *
   * `age` 只给解码用：本地录制永远从 0 开始，解码要还原发端记下的年龄，
   * 否则整条同步过来的路径会在收端一起「重新被踩」。
   */
  public push(
    x: number,
    z: number,
    radius: number,
    strength: number,
    age = 0,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const safeRadius = clampFinite(radius, 0.05, 5, 0.65);
    const safeStrength = clampFinite(strength, 0, 1, 1);
    const safeAge = clampFinite(age, 0, MAXIMUM_QUANTIZED_AGE, 0);
    if (safeStrength <= 0) return;

    if (this.pointCount > 0) {
      const headSlot = this.slotOf(this.pointCount - 1);
      const distance = Math.hypot(
        x - this.positionsX[headSlot],
        z - this.positionsZ[headSlot],
      );
      if (distance < this.minimumSpacing) {
        this.positionsX[headSlot] = x;
        this.positionsZ[headSlot] = z;
        this.radii[headSlot] = Math.max(this.radii[headSlot], safeRadius);
        this.strengths[headSlot] = Math.max(
          this.currentStrengthAtSlot(headSlot),
          safeStrength,
        );
        this.ages[headSlot] = Math.min(this.ages[headSlot], safeAge);
        return;
      }
    }

    const slot = this.slotOf(this.pointCount);
    this.positionsX[slot] = x;
    this.positionsZ[slot] = z;
    this.radii[slot] = safeRadius;
    this.strengths[slot] = safeStrength;
    this.ages[slot] = safeAge;
    if (this.pointCount < this.capacity) {
      this.pointCount += 1;
    } else {
      // 写满之后覆盖最旧的一格，路径长度因此恒定。
      this.oldestIndex = (this.oldestIndex + 1) % this.capacity;
    }
  }

  /**
   * 推进时间并丢弃已经回弹完的点。
   *
   * 年龄沿路径从旧到新单调递减（只有最新点会被 push 归零），所以只需要从
   * 最旧的一端连续丢弃，不用整条扫描。
   */
  public advance(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    for (let index = 0; index < this.pointCount; index += 1) {
      this.ages[this.slotOf(index)] += deltaSeconds;
    }
    while (this.pointCount > 0) {
      const slot = this.slotOf(0);
      if (this.currentStrengthAtSlot(slot) > GRASS_TRAIL_MINIMUM_STRENGTH) break;
      this.oldestIndex = (this.oldestIndex + 1) % this.capacity;
      this.pointCount -= 1;
    }
  }

  /** 按从旧到新的顺序读取第 index 个点，写进 out 以避免每帧分配。 */
  public readPoint(index: number, out: GrassTrailPoint): GrassTrailPoint {
    const slot = this.slotOf(clampIndex(index, this.pointCount));
    out.x = this.positionsX[slot];
    out.z = this.positionsZ[slot];
    out.radius = this.radii[slot];
    out.strength = this.strengths[slot];
    out.age = this.ages[slot];
    return out;
  }

  /** 第 index 个点当前还剩多少压痕强度。 */
  public currentStrength(index: number): number {
    if (this.pointCount === 0) return 0;
    return this.currentStrengthAtSlot(this.slotOf(clampIndex(index, this.pointCount)));
  }

  public clear(): void {
    this.oldestIndex = 0;
    this.pointCount = 0;
  }

  /** 路径整体是否与这个世界矩形相交，用于把窗口外的路径整条跳过。 */
  public intersectsBounds(
    minimumX: number,
    minimumZ: number,
    maximumX: number,
    maximumZ: number,
  ): boolean {
    for (let index = 0; index < this.pointCount; index += 1) {
      const slot = this.slotOf(index);
      const radius = this.radii[slot];
      if (
        this.positionsX[slot] + radius >= minimumX
        && this.positionsX[slot] - radius <= maximumX
        && this.positionsZ[slot] + radius >= minimumZ
        && this.positionsZ[slot] - radius <= maximumZ
      ) return true;
    }
    return false;
  }

  private currentStrengthAtSlot(slot: number): number {
    return this.strengths[slot] * Math.exp(-this.ages[slot] / this.recoverySeconds);
  }

  private slotOf(index: number): number {
    return (this.oldestIndex + index) % this.capacity;
  }
}

/** 编码一条路径所需的字节数上界；用来给快照预留固定预算。 */
export function grassTrailWireSize(capacity = GRASS_TRAIL_POINT_CAPACITY): number {
  return WIRE_HEADER_BYTES + capacity * WIRE_BYTES_PER_POINT;
}

/**
 * 把路径量化成紧凑字节。
 *
 * 字节数只与点数上界有关（24 点 = 204 字节），因此可以无条件塞进快照，
 * 不会因为玩家跑得久而变长，也不随世界尺寸增长。
 */
export function encodeGrassTrailPath(path: GrassTrailPath): Uint8Array {
  const bytes = new Uint8Array(WIRE_HEADER_BYTES + path.length * WIRE_BYTES_PER_POINT);
  const view = new DataView(bytes.buffer);
  const point: GrassTrailPoint = { x: 0, z: 0, radius: 0, strength: 0, age: 0 };
  // 锚点取最旧的一个点；空路径没有锚点，写 0 让 pointCount 自己说明一切。
  if (path.length > 0) path.readPoint(0, point);
  const anchorX = path.length > 0 ? point.x : 0;
  const anchorZ = path.length > 0 ? point.z : 0;
  view.setUint8(0, GRASS_TRAIL_WIRE_VERSION);
  view.setUint8(1, path.length);
  view.setUint16(2, Math.round(Math.min(65_535, path.recoverySeconds * 1000)), true);
  view.setFloat32(4, anchorX, true);
  view.setFloat32(8, anchorZ, true);

  for (let index = 0; index < path.length; index += 1) {
    path.readPoint(index, point);
    const offset = WIRE_HEADER_BYTES + index * WIRE_BYTES_PER_POINT;
    view.setInt16(offset, quantizeSigned(point.x - anchorX, POSITION_QUANTIZATION), true);
    view.setInt16(offset + 2, quantizeSigned(point.z - anchorZ, POSITION_QUANTIZATION), true);
    view.setUint8(offset + 4, quantizeUnsigned(point.radius, RADIUS_QUANTIZATION));
    view.setUint8(offset + 5, quantizeUnsigned(point.strength, 255));
    view.setUint8(offset + 6, quantizeUnsigned(point.age, AGE_QUANTIZATION));
    view.setUint8(offset + 7, 0);
  }
  return bytes;
}

/**
 * 还原一条路径。容量不足时只保留最新的那些点——收端的显示预算由收端决定，
 * 发端可以有更长的路径而不会把收端撑爆。
 */
export function decodeGrassTrailPath(
  bytes: Uint8Array,
  into: GrassTrailPath = new GrassTrailPath(),
): GrassTrailPath {
  into.clear();
  if (bytes.byteLength < WIRE_HEADER_BYTES) return into;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== GRASS_TRAIL_WIRE_VERSION) return into;

  const declaredCount = view.getUint8(1);
  const anchorX = view.getFloat32(4, true);
  const anchorZ = view.getFloat32(8, true);
  const availableCount = Math.floor(
    (bytes.byteLength - WIRE_HEADER_BYTES) / WIRE_BYTES_PER_POINT,
  );
  const pointCount = Math.min(declaredCount, availableCount);
  const firstIndex = Math.max(0, pointCount - into.capacity);

  for (let index = firstIndex; index < pointCount; index += 1) {
    const offset = WIRE_HEADER_BYTES + index * WIRE_BYTES_PER_POINT;
    const x = anchorX + view.getInt16(offset, true) / POSITION_QUANTIZATION;
    const z = anchorZ + view.getInt16(offset + 2, true) / POSITION_QUANTIZATION;
    const radius = view.getUint8(offset + 4) / RADIUS_QUANTIZATION;
    const strength = view.getUint8(offset + 5) / 255;
    const age = view.getUint8(offset + 6) / AGE_QUANTIZATION;
    // 先按原强度写入再补上年龄，push 的合并规则因此与本地录制完全一致。
    into.push(x, z, radius, strength, age);
  }
  return into;
}

function quantizeSigned(value: number, scale: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value * scale)));
}

function quantizeUnsigned(value: number, scale: number): number {
  return Math.max(0, Math.min(255, Math.round(value * scale)));
}

function clampIndex(index: number, count: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(index)));
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

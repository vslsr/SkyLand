import { allocateSharedBytes, isSharedBytes } from '../platform/index';

/**
 * 相机过边界的那一段字节（引擎迁移路线图 第 3 步）。
 *
 * 相机是**玩法侧算出来的**：镜头跟随、悬臂避障、模式切换过渡全都要读玩家位置和
 * 输入。但画面是渲染侧出的。canvas 交给渲染线程之后，`render(frame)` 那种
 * 「把一个 JS 对象递过去」的写法就不成立了。
 *
 * 形状和 transform SoA 一样：双缓冲 + `publish()` 翻面，读的一侧永远看到完整的
 * 一帧，不会读到写到一半的机位。
 *
 * ```text
 * [ Int32 header ×2 ][ Float32 2×9 ]
 *   readBank frameId   x y z  fx fy fz  ux uy uz
 * ```
 *
 * **为什么不并进 `RenderTransformBuffer`**：那一段是**场景的**——换地图就换一个，
 * 容量跟着 proxy 槽位涨。相机比场景活得久（大厅 → 房间 → 大厅 都是同一个相机），
 * 而且它是每帧一条固定记录，不是每槽位一条。并进去只会让那段字节多一个和容量
 * 无关的尾巴，以及一个「换场景时相机怎么办」的问题。
 *
 * 代价是两次 `publish()`，理论上存在「相机是第 N 帧、世界是第 N-1 帧」的撕裂窗口。
 * 实际不会：两次翻面都发生在同一个 tick 里（见 `GrasslandScene.update`）。真要
 * 让它成为不可能而不只是不会发生，就把两段字节合成一段——那时这个类整个消失。
 *
 * **只送对面真正要的**：位置、前向、上向，九个 f32。`CameraFrame` 里还有
 * `right` 和 `viewMatrix`，但渲染侧拿到位置和朝向之后自己会算——视图矩阵是
 * 后端的事（Three 用 `lookAt`，别的后端未必），送过去等于替它做主。
 */

/** 每一面的浮点数个数：位置 3 + 前向 3 + 上向 3。 */
export const RENDER_CAMERA_STRIDE = 9;

const HEADER_INT32_COUNT = 2;
const HEADER_READ_BANK = 0;
const HEADER_FRAME_ID = 1;
const HEADER_BYTES = HEADER_INT32_COUNT * Int32Array.BYTES_PER_ELEMENT;

export interface RenderCamera {
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
}

export function createRenderCamera(): RenderCamera {
  // 缺省是「站在原点朝 -Z 看」——还没有人写过相机时读到的就是它，
  // 而不是一个全 0 的退化朝向（那会让 lookAt 算出 NaN）。
  return { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] };
}

export class RenderCameraBuffer {
  readonly #bytes: ArrayBufferLike;
  readonly #header: Int32Array<ArrayBufferLike>;
  readonly #values: Float32Array<ArrayBufferLike>;

  public constructor() {
    this.#bytes = allocateSharedBytes(
      HEADER_BYTES + 2 * RENDER_CAMERA_STRIDE * Float32Array.BYTES_PER_ELEMENT,
    );
    this.#header = new Int32Array(this.#bytes, 0, HEADER_INT32_COUNT);
    this.#values = new Float32Array(this.#bytes, HEADER_BYTES, 2 * RENDER_CAMERA_STRIDE);
    this.#header[HEADER_READ_BANK] = 0;
    this.#header[HEADER_FRAME_ID] = 0;
    const initial = createRenderCamera();
    // 两面都填成缺省朝向：第一帧就算没人写过也画得出东西。
    for (const bank of [0, 1]) this.#writeBank(bank, initial.position, initial.forward, initial.up);
  }

  /** 跨线程投递的就是这一段字节；SAB 时零拷贝。 */
  public get bytes(): ArrayBufferLike {
    return this.#bytes;
  }

  public get isShared(): boolean {
    return isSharedBytes(this.#bytes);
  }

  /** 递增的帧号。渲染侧靠它判断这一帧的机位是不是新的。 */
  public get frameId(): number {
    return Atomics.load(this.#header, HEADER_FRAME_ID);
  }

  public write(
    position: readonly [number, number, number],
    forward: readonly [number, number, number],
    up: readonly [number, number, number],
  ): void {
    this.#writeBank(1 - this.#readBank, position, forward, up);
  }

  /**
   * 翻面。和 transform 那一段一样：发布之后把新的读面复制到写面，
   * 所以下一帧没人写相机就保持上一帧的机位，而不是回到两帧前。
   */
  public publish(): void {
    const published = 1 - this.#readBank;
    Atomics.store(this.#header, HEADER_READ_BANK, published);
    Atomics.add(this.#header, HEADER_FRAME_ID, 1);
    this.#values.copyWithin(
      (1 - published) * RENDER_CAMERA_STRIDE,
      published * RENDER_CAMERA_STRIDE,
      (published + 1) * RENDER_CAMERA_STRIDE,
    );
  }

  public read(out: RenderCamera): RenderCamera {
    const base = this.#readBank * RENDER_CAMERA_STRIDE;
    out.position[0] = this.#values[base];
    out.position[1] = this.#values[base + 1];
    out.position[2] = this.#values[base + 2];
    out.forward[0] = this.#values[base + 3];
    out.forward[1] = this.#values[base + 4];
    out.forward[2] = this.#values[base + 5];
    out.up[0] = this.#values[base + 6];
    out.up[1] = this.#values[base + 7];
    out.up[2] = this.#values[base + 8];
    return out;
  }

  get #readBank(): number {
    return Atomics.load(this.#header, HEADER_READ_BANK);
  }

  #writeBank(
    bank: number,
    position: readonly [number, number, number],
    forward: readonly [number, number, number],
    up: readonly [number, number, number],
  ): void {
    const base = bank * RENDER_CAMERA_STRIDE;
    this.#values[base] = position[0];
    this.#values[base + 1] = position[1];
    this.#values[base + 2] = position[2];
    this.#values[base + 3] = forward[0];
    this.#values[base + 4] = forward[1];
    this.#values[base + 5] = forward[2];
    this.#values[base + 6] = up[0];
    this.#values[base + 7] = up[1];
    this.#values[base + 8] = up[2];
  }
}

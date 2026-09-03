import { allocateSharedBytes, isSharedBytes } from '../platform/index';
import { NULL_PROXY_ID, type ProxyId } from './RenderScene';
import { RENDER_VISUAL_PARAM_COUNT } from './RenderVisualParams';

/**
 * 坐在 Game World 与 Render World 之间的 transform 双缓冲（路线图 §2 / 第 1 步）。
 *
 * ```text
 *  Game World                         Render World
 *   写 world transform                 读 world transform
 *          │                                 ▲
 *          ▼                                 │
 *   ┌──────────────────────────────────────────────┐
 *   │  SharedArrayBuffer · bank0 / bank1 · 定长 SoA │ ← 边界在这里
 *   └──────────────────────────────────────────────┘
 * ```
 *
 * 布局是一整段字节，一次 `postMessage` 就能交给 worker：
 *
 * ```text
 * [ Int32 header ×4 ][ Float32 transforms 2×cap×4 ][ Int32 parents 2×cap ][ Float32 params 2×cap×N ]
 *   readBank frameId   x y z yaw ...                 parentSlot ...         见 RenderVisualParams
 * ```
 *
 * 表现参数和 transform 同段、同一次 `publish()`：分开两个缓冲会撕裂——
 * 强度来自第 N 帧、位置来自第 N+1 帧。
 *
 * 三条约定：
 *
 * 1. **写的是世界坐标。** 父子关系只以 `parentSlot` 的形式过边界；「局部坐标怎么
 *    算」是渲染世界自己的事（Three 的场景图需要它，别的后端未必）。
 * 2. **每帧写满所有存活槽位。** 双缓冲不做脏标记；`publish()` 之后新的写面是
 *    刚发布那一面的副本，所以漏写一帧退化成「保持上一帧」，不会读到两帧前的值。
 * 3. **视图只在 `#adopt()` 里重建。** 现在只有自己的扩容会重新分配，所以这样够用；
 *    等 Emscripten 开了 pthreads，WASM heap 是 SAB、别的线程增长堆会让所有
 *    JS 侧视图失效，那时这个类要改成「每次访问重取视图」——接口不变，
 *    调用方不受影响。这是把那个坑关在一个文件里的原因。
 */

/** 每个槽位的 transform 分量：x, y, z, yaw。 */
export const RENDER_TRANSFORM_STRIDE = 4;

const HEADER_INT32_COUNT = 4;
const HEADER_READ_BANK = 0;
const HEADER_FRAME_ID = 1;
const HEADER_CAPACITY = 2;
const HEADER_BYTES = HEADER_INT32_COUNT * Int32Array.BYTES_PER_ELEMENT;

const DEFAULT_CAPACITY = 256;

export interface RenderTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function bytesFor(capacity: number): number {
  return HEADER_BYTES
    + 2 * capacity * RENDER_TRANSFORM_STRIDE * Float32Array.BYTES_PER_ELEMENT
    + 2 * capacity * Int32Array.BYTES_PER_ELEMENT
    + 2 * capacity * RENDER_VISUAL_PARAM_COUNT * Float32Array.BYTES_PER_ELEMENT;
}

export class RenderTransformBuffer {
  #capacity = 0;
  #bytes: ArrayBufferLike = new ArrayBuffer(0);
  #header: Int32Array<ArrayBufferLike> = new Int32Array(0);
  #transforms: Float32Array<ArrayBufferLike> = new Float32Array(0);
  #parents: Int32Array<ArrayBufferLike> = new Int32Array(0);
  #params: Float32Array<ArrayBufferLike> = new Float32Array(0);

  public constructor(capacity = DEFAULT_CAPACITY) {
    this.#adopt(allocateSharedBytes(bytesFor(Math.max(1, capacity))), Math.max(1, capacity));
    this.#header[HEADER_READ_BANK] = 0;
    this.#header[HEADER_FRAME_ID] = 0;
    this.#header[HEADER_CAPACITY] = this.#capacity;
    this.#parents.fill(NULL_PROXY_ID);
  }

  /**
   * 接住另一条线程投递过来的同一段字节（引擎迁移路线图 第 3 步）。
   *
   * 容量写在表头里，所以只凭这段字节就能还原出全部视图——渲染线程不需要额外
   * 被告知任何东西。SAB 时两侧看的是同一块内存，没有拷贝。
   *
   * **注意扩容**：`ensureSlot` 会重新分配一整段新字节，那一刻这一侧接住的旧段
   * 就成了孤儿。所以跨线程用的时候，要么一开始就按上界开够，要么在扩容之后
   * 把新的 `bytes` 再投递一次。这个坑关在这个类里，见类注释第 3 条。
   */
  public static fromBytes(bytes: ArrayBufferLike): RenderTransformBuffer {
    const capacity = new Int32Array(bytes, 0, HEADER_INT32_COUNT)[HEADER_CAPACITY];
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`这段字节不像 RenderTransformBuffer：表头里的容量是 ${capacity}`);
    }
    // 先按最小容量正常构造再换视图：私有字段只有构造器装得上，
    // `Object.create` 出来的壳子调不了 `#adopt`。那一小段字节随即被丢掉。
    const buffer = new RenderTransformBuffer(1);
    // 只换视图，不碰表头——表头归写入的那一侧。
    buffer.#adopt(bytes, capacity);
    return buffer;
  }

  public get capacity(): number {
    return this.#capacity;
  }

  /** 递增的帧号。渲染侧靠它判断「这一帧的数据是不是新的」。 */
  public get frameId(): number {
    return Atomics.load(this.#header, HEADER_FRAME_ID);
  }

  /** 跨线程投递的就是这一段字节；SAB 时零拷贝。 */
  public get bytes(): ArrayBufferLike {
    return this.#bytes;
  }

  public get isShared(): boolean {
    return isSharedBytes(this.#bytes);
  }

  /** 保证槽位 `slot` 可写。容量按 2 的倍数增长，两个 bank 的内容都会搬过去。 */
  public ensureSlot(slot: number): void {
    if (slot < this.#capacity) return;
    let capacity = Math.max(1, this.#capacity);
    while (capacity <= slot) capacity *= 2;
    this.#grow(capacity);
  }

  /** 写入这一帧的世界 transform。`parent` 传 NULL_PROXY_ID 表示挂在世界根下。 */
  public write(
    id: ProxyId,
    x: number,
    y: number,
    z: number,
    yaw: number,
    parent: ProxyId = NULL_PROXY_ID,
  ): void {
    this.ensureSlot(id);
    const base = this.#transformBase(this.#writeBank, id);
    this.#transforms[base] = x;
    this.#transforms[base + 1] = y;
    this.#transforms[base + 2] = z;
    this.#transforms[base + 3] = yaw;
    this.#parents[this.#parentBase(this.#writeBank, id)] = parent;
  }

  /** 槽位回收：两个 bank 一起清，避免复用槽位时读到上一个 proxy 的残留。 */
  public clear(id: ProxyId): void {
    if (id < 0 || id >= this.#capacity) return;
    for (const bank of [0, 1]) {
      const base = this.#transformBase(bank, id);
      this.#transforms.fill(0, base, base + RENDER_TRANSFORM_STRIDE);
      this.#parents[this.#parentBase(bank, id)] = NULL_PROXY_ID;
      const paramBase = this.#paramBase(bank, id);
      this.#params.fill(0, paramBase, paramBase + RENDER_VISUAL_PARAM_COUNT);
    }
  }

  /**
   * 翻面。发布之后把新的读面复制到写面，所以下一帧漏写的槽位保持上一帧的值，
   * 而不是回到两帧前。
   */
  public publish(): void {
    const published = this.#writeBank;
    Atomics.store(this.#header, HEADER_READ_BANK, published);
    Atomics.add(this.#header, HEADER_FRAME_ID, 1);
    const next = 1 - published;
    const stride = this.#capacity * RENDER_TRANSFORM_STRIDE;
    this.#transforms.copyWithin(next * stride, published * stride, (published + 1) * stride);
    this.#parents.copyWithin(
      next * this.#capacity,
      published * this.#capacity,
      (published + 1) * this.#capacity,
    );
    const paramStride = this.#capacity * RENDER_VISUAL_PARAM_COUNT;
    this.#params.copyWithin(next * paramStride, published * paramStride, (published + 1) * paramStride);
  }

  public readTransform(id: ProxyId, out: RenderTransform): RenderTransform {
    const bank = this.#readBank;
    const base = this.#transformBase(bank, id);
    out.x = this.#transforms[base];
    out.y = this.#transforms[base + 1];
    out.z = this.#transforms[base + 2];
    out.yaw = this.#transforms[base + 3];
    return out;
  }

  /** 写这一帧的表现参数。下标见 `RenderVisualParams`。 */
  public writeParam(id: ProxyId, param: number, value: number): void {
    this.ensureSlot(id);
    this.#params[this.#paramBase(this.#writeBank, id) + param] = value;
  }

  public readParam(id: ProxyId, param: number): number {
    if (id < 0 || id >= this.#capacity) return 0;
    return this.#params[this.#paramBase(this.#readBank, id) + param];
  }

  public readParent(id: ProxyId): ProxyId {
    if (id < 0 || id >= this.#capacity) return NULL_PROXY_ID;
    return this.#parents[this.#parentBase(this.#readBank, id)] as ProxyId;
  }

  get #readBank(): number {
    return Atomics.load(this.#header, HEADER_READ_BANK);
  }

  get #writeBank(): number {
    return 1 - this.#readBank;
  }

  #transformBase(bank: number, slot: number): number {
    return (bank * this.#capacity + slot) * RENDER_TRANSFORM_STRIDE;
  }

  #parentBase(bank: number, slot: number): number {
    return bank * this.#capacity + slot;
  }

  #paramBase(bank: number, slot: number): number {
    return (bank * this.#capacity + slot) * RENDER_VISUAL_PARAM_COUNT;
  }

  #grow(capacity: number): void {
    const previousCapacity = this.#capacity;
    const previousTransforms = this.#transforms;
    const previousParents = this.#parents;
    const previousParams = this.#params;
    const readBank = this.#readBank;
    const frameId = this.frameId;

    this.#adopt(allocateSharedBytes(bytesFor(capacity)), capacity);
    this.#header[HEADER_READ_BANK] = readBank;
    this.#header[HEADER_FRAME_ID] = frameId;
    this.#header[HEADER_CAPACITY] = capacity;
    this.#parents.fill(NULL_PROXY_ID);
    for (const bank of [0, 1]) {
      const sourceTransform = bank * previousCapacity * RENDER_TRANSFORM_STRIDE;
      this.#transforms.set(
        previousTransforms.subarray(
          sourceTransform,
          sourceTransform + previousCapacity * RENDER_TRANSFORM_STRIDE,
        ),
        bank * capacity * RENDER_TRANSFORM_STRIDE,
      );
      const sourceParent = bank * previousCapacity;
      this.#parents.set(
        previousParents.subarray(sourceParent, sourceParent + previousCapacity),
        bank * capacity,
      );
      const sourceParam = bank * previousCapacity * RENDER_VISUAL_PARAM_COUNT;
      this.#params.set(
        previousParams.subarray(
          sourceParam,
          sourceParam + previousCapacity * RENDER_VISUAL_PARAM_COUNT,
        ),
        bank * capacity * RENDER_VISUAL_PARAM_COUNT,
      );
    }
  }

  /** 唯一重建视图的地方。任何可能重新分配的操作都必须经过它。 */
  #adopt(bytes: ArrayBufferLike, capacity: number): void {
    this.#bytes = bytes;
    this.#capacity = capacity;
    this.#header = new Int32Array(bytes, 0, HEADER_INT32_COUNT);
    const transformOffset = HEADER_BYTES;
    const transformCount = 2 * capacity * RENDER_TRANSFORM_STRIDE;
    this.#transforms = new Float32Array(bytes, transformOffset, transformCount);
    const parentOffset = transformOffset + transformCount * Float32Array.BYTES_PER_ELEMENT;
    this.#parents = new Int32Array(bytes, parentOffset, 2 * capacity);
    this.#params = new Float32Array(
      bytes,
      parentOffset + 2 * capacity * Int32Array.BYTES_PER_ELEMENT,
      2 * capacity * RENDER_VISUAL_PARAM_COUNT,
    );
  }
}

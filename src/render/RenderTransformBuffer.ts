import { allocateSharedBytes, isSharedBytes } from '../platform/index';
import { NULL_PROXY_ID, type ProxyId } from './RenderScene';

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
 * [ Int32 header ×4 ][ Float32 transforms 2×capacity×4 ][ Int32 parents 2×capacity ]
 *   readBank frameId   x y z yaw ...                      parentSlot ...
 * ```
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
    + 2 * capacity * Int32Array.BYTES_PER_ELEMENT;
}

export class RenderTransformBuffer {
  #capacity = 0;
  #bytes: ArrayBufferLike = new ArrayBuffer(0);
  #header: Int32Array<ArrayBufferLike> = new Int32Array(0);
  #transforms: Float32Array<ArrayBufferLike> = new Float32Array(0);
  #parents: Int32Array<ArrayBufferLike> = new Int32Array(0);

  public constructor(capacity = DEFAULT_CAPACITY) {
    this.#adopt(allocateSharedBytes(bytesFor(Math.max(1, capacity))), Math.max(1, capacity));
    this.#header[HEADER_READ_BANK] = 0;
    this.#header[HEADER_FRAME_ID] = 0;
    this.#header[HEADER_CAPACITY] = this.#capacity;
    this.#parents.fill(NULL_PROXY_ID);
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

  #grow(capacity: number): void {
    const previousCapacity = this.#capacity;
    const previousTransforms = this.#transforms;
    const previousParents = this.#parents;
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
    this.#parents = new Int32Array(
      bytes,
      transformOffset + transformCount * Float32Array.BYTES_PER_ELEMENT,
      2 * capacity,
    );
  }
}

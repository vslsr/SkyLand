/**
 * 高数量合批内容的实例通道（路线图 §4.5 的 `PropInstances`）。
 *
 * `Meshes[]` 那条路（`ProxyId` + transform SoA）不适用于掉落堆、树上果子这类内容：
 * 它们**没有单独的 proxy**——要么 `createReplica` 见到 `itemStack` 就提前返回，
 * 要么它们根本不是 Actor（果子是从树的放置记录里推出来的）。整批由渲染侧一次
 * 实例化画掉，所以它们需要自己的一条通道。
 *
 * 形状是**每帧重建的定长记录数组**，不是「谁变了就发谁」：
 *
 * - 内容每帧都可能变（捡拾、掉落、果子熟没熟），增量的记账成本高于直接重铺；
 * - 定长意味着上 worker 之后这两段字节可以直接是 `SharedArrayBuffer` 视图，
 *   和 transform SoA 同一个套路。
 *
 * 离散字段走 `Int32Array`，连续量走 `Float32Array`。分两段而不是把整数塞进 f32
 * 再读回来，是因为那种事早晚会在某个边界上咬人一次。
 *
 * **布局不在这里**：这个类只管字节，字段下标由各自的通道模块定义
 * （`propInstanceLayout.ts`、`fruitInstanceLayout.ts`）。两条通道形状不同，
 * 但没必要各写一份扩容与回收。
 */

const DEFAULT_CAPACITY = 256;

/**
 * 一帧的实例列表。玩法侧 `beginFrame()` → 若干次 `push()`；渲染侧按 `count` 读。
 *
 * 没有双缓冲：合批是在同一帧里写完就读的（`ClientActorSystem.update` 里紧挨着），
 * 而 transform SoA 要双缓冲是因为它要跨线程。等这一条也跨线程了再补翻面——
 * 那时它和 transform 段用同一套 `publish()`。
 */
export class RenderInstanceBuffer {
  #integers: Int32Array;
  #floats: Float32Array;
  #count = 0;

  public constructor(
    /** 每条记录的离散字段个数。 */
    public readonly intStride: number,
    /** 每条记录的连续字段个数。 */
    public readonly floatStride: number,
    capacity = DEFAULT_CAPACITY,
  ) {
    if (intStride < 0 || floatStride < 0) throw new Error('实例通道的 stride 不能为负');
    this.#integers = new Int32Array(Math.max(1, capacity) * intStride);
    this.#floats = new Float32Array(Math.max(1, capacity) * floatStride);
  }

  public get count(): number {
    return this.#count;
  }

  public get capacity(): number {
    // stride 为 0 的那一段撑不出容量，用另一段量。
    if (this.intStride > 0) return this.#integers.length / this.intStride;
    if (this.floatStride > 0) return this.#floats.length / this.floatStride;
    return 0;
  }

  public beginFrame(): void {
    this.#count = 0;
  }

  public push(integers: readonly number[], floats: readonly number[]): void {
    if (integers.length !== this.intStride || floats.length !== this.floatStride) {
      throw new Error(
        `实例记录字段数不符：期望 ${this.intStride}／${this.floatStride}，`
        + `收到 ${integers.length}／${floats.length}`,
      );
    }
    this.#ensure(this.#count + 1);
    const intBase = this.#count * this.intStride;
    for (let index = 0; index < this.intStride; index += 1) {
      this.#integers[intBase + index] = integers[index];
    }
    const floatBase = this.#count * this.floatStride;
    for (let index = 0; index < this.floatStride; index += 1) {
      this.#floats[floatBase + index] = floats[index];
    }
    this.#count += 1;
  }

  public readInt(instance: number, field: number): number {
    return this.#integers[instance * this.intStride + field];
  }

  public readFloat(instance: number, field: number): number {
    return this.#floats[instance * this.floatStride + field];
  }

  #ensure(count: number): void {
    if (count <= this.capacity) return;
    let capacity = Math.max(1, this.capacity);
    while (capacity < count) capacity *= 2;
    const integers = new Int32Array(capacity * this.intStride);
    integers.set(this.#integers);
    this.#integers = integers;
    const floats = new Float32Array(capacity * this.floatStride);
    floats.set(this.#floats);
    this.#floats = floats;
  }
}

/**
 * Actor id → 稳定实例号。槽位回收后复用，和渲染世界那张 proxy 槽位表同一个套路。
 *
 * 放在玩法侧：只有它知道 Actor 什么时候不见了。渲染侧只认号码。
 */
export class InstanceIdTable {
  readonly #ids = new Map<string, number>();
  readonly #free: number[] = [];
  #next = 0;

  public acquire(actorId: string): number {
    const existing = this.#ids.get(actorId);
    if (existing !== undefined) return existing;
    const id = this.#free.pop() ?? this.#next++;
    this.#ids.set(actorId, id);
    return id;
  }

  /** 把这一帧没出现过的 Actor 的号码收回去。 */
  public retainOnly(live: ReadonlySet<string>): void {
    for (const [actorId, id] of this.#ids) {
      if (live.has(actorId)) continue;
      this.#ids.delete(actorId);
      this.#free.push(id);
    }
  }

  public get size(): number {
    return this.#ids.size;
  }

  public clear(): void {
    this.#ids.clear();
    this.#free.length = 0;
    this.#next = 0;
  }
}

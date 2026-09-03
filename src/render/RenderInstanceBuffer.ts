/**
 * 高数量合批内容的实例通道（路线图 §4.5 的 `PropInstances`）。
 *
 * `Meshes[]` 那条路（`ProxyId` + transform SoA）不适用于掉落堆这类内容：它们**没有
 * 单独的 proxy**——`createReplica` 见到 `itemStack` 就提前返回，整批由
 * `HighCountActorBatchSystem` 一次实例化画掉。所以它们需要自己的一条通道。
 *
 * 形状是**每帧重建的定长记录数组**，不是「谁变了就发谁」：
 *
 * - 掉落堆的数量随捡拾/掉落每帧都可能变，增量的记账成本高于直接重铺；
 * - 定长意味着上 worker 之后这两段字节可以直接是 `SharedArrayBuffer` 视图，
 *   和 transform SoA 同一个套路。
 *
 * 离散字段（原型、驻留态、燃烧、单个还是一堆）走 `Int32Array`，连续量走
 * `Float32Array`。分两段而不是混在一个 f32 里，是因为把整数塞进 f32 再读回来
 * 这种事早晚会在某个边界上咬人一次。
 */

/** 每个实例的离散字段个数，见 `INSTANCE_*` 下标。 */
export const INSTANCE_INT_STRIDE = 5;
/** 每个实例的连续字段个数。 */
export const INSTANCE_FLOAT_STRIDE = 6;

/** 原型在场景原型表里的下标。渲染侧据此找到 render 定义、建材质与模板。 */
export const INSTANCE_ARCHETYPE = 0;
/** 驻留态（`ActorResidencyComponent.state`），按注册顺序编号。 */
export const INSTANCE_RESIDENCY = 1;
export const INSTANCE_BURNING = 2;
/** 单个还是一堆：果子与原木在数量为 1 时换一套模板。 */
export const INSTANCE_SINGLE = 3;
/**
 * 稳定的实例编号。
 *
 * 渲染侧的滚动姿态是**从位移累积出来的**，所以必须能把这一帧的实例认成
 * 「上一帧那一个」。Actor id 是字符串，过不了字节边界；玩法侧因此给每个
 * 被合批的 Actor 分一个槽位号，和 `ProxyId` 一个套路——离开视野就还回去复用。
 */
export const INSTANCE_ID = 4;

export const INSTANCE_X = 0;
export const INSTANCE_Y = 1;
export const INSTANCE_Z = 2;
export const INSTANCE_YAW = 3;
export const INSTANCE_QUANTITY = 4;
/** 刚体半径；> 0 才有滚动姿态。 */
export const INSTANCE_ROLL_RADIUS = 5;

/**
 * 驻留态的两侧共用编号。字符串过不了字节边界，所以定一份顺序。
 *
 * 放在通道定义里而不是写入方那边：读的一侧要靠它把编号翻回可读的名字
 * （合批的调试对象名就是这么拼的），两边必须是同一份。
 *
 * 只有这两个态：`ActorResidencyComponent.setState` 只认 `active` 与 `sleeping`。
 * dormant 不在这里——它表示这个 Actor **已经离开 ActorWorld**，也就不会有实例记录。
 */
export const INSTANCE_RESIDENCY_STATES = ['active', 'sleeping'] as const;

export function residencyCode(state: string | undefined): number {
  const index = INSTANCE_RESIDENCY_STATES.indexOf(
    state as typeof INSTANCE_RESIDENCY_STATES[number],
  );
  return index < 0 ? 0 : index;
}

export function residencyName(code: number): string {
  return INSTANCE_RESIDENCY_STATES[code] ?? INSTANCE_RESIDENCY_STATES[0];
}

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

  public constructor(capacity = DEFAULT_CAPACITY) {
    this.#integers = new Int32Array(Math.max(1, capacity) * INSTANCE_INT_STRIDE);
    this.#floats = new Float32Array(Math.max(1, capacity) * INSTANCE_FLOAT_STRIDE);
  }

  public get count(): number {
    return this.#count;
  }

  public get capacity(): number {
    return this.#integers.length / INSTANCE_INT_STRIDE;
  }

  public beginFrame(): void {
    this.#count = 0;
  }

  public push(
    integers: readonly [number, number, number, number, number],
    floats: readonly [number, number, number, number, number, number],
  ): void {
    this.#ensure(this.#count + 1);
    const intBase = this.#count * INSTANCE_INT_STRIDE;
    for (let index = 0; index < INSTANCE_INT_STRIDE; index += 1) {
      this.#integers[intBase + index] = integers[index];
    }
    const floatBase = this.#count * INSTANCE_FLOAT_STRIDE;
    for (let index = 0; index < INSTANCE_FLOAT_STRIDE; index += 1) {
      this.#floats[floatBase + index] = floats[index];
    }
    this.#count += 1;
  }

  public readInt(instance: number, field: number): number {
    return this.#integers[instance * INSTANCE_INT_STRIDE + field];
  }

  public readFloat(instance: number, field: number): number {
    return this.#floats[instance * INSTANCE_FLOAT_STRIDE + field];
  }

  #ensure(count: number): void {
    if (count <= this.capacity) return;
    let capacity = Math.max(1, this.capacity);
    while (capacity < count) capacity *= 2;
    const integers = new Int32Array(capacity * INSTANCE_INT_STRIDE);
    integers.set(this.#integers);
    this.#integers = integers;
    const floats = new Float32Array(capacity * INSTANCE_FLOAT_STRIDE);
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

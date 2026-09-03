/**
 * GPU 资源所有权表（引擎迁移路线图 §8.2 / §8.4）。
 *
 * 现在全仓 `.dispose()` 出现 143 次、散在 56 个文件里，分属三套互不一致的
 * 手写约定，其中一套（遍历整棵场景树无差别 dispose）和另外两套的哲学直接冲突。
 * 后果是共享资源被非拥有者释放：删掉一个 Actor 就会顺手 dispose 掉整个进程
 * 共用的轮廓线材质。
 *
 * 现在它只表现为一次着色器重编译的毛刺——Three 会在下次使用时重建 program
 * 与 VBO。自研渲染器自己管 GL 对象之后**没有这层兜底**：同一段代码，那时是
 * use-after-free，要么黑屏，要么驱动崩。所以这张表必须排在换掉 Three 之前。
 *
 * 最小核心就三个方法，配一条规则：**谁 acquire 谁 release；遍历场景树永远不
 * dispose。**
 *
 * 这一层刻意**不知道资产是什么**（§8.4：它属于 CoreLayer），所以这个文件里没有
 * 一个 Three 类型：它只知道有人持有、持有几份、归零时该调谁。加载、烘焙产物
 * 解码、key 的命名是 ResourceLayer 的事，建在这张表之上。
 *
 * 和第 1 步的 `ProxyId` 是同构的——都是「跨线程只传句柄，实体留在拥有它的那一侧」。
 */

/**
 * 资源句柄。类型参数只用来在编译期把「句柄」和「它指向的东西」绑在一起，
 * 运行时它就是一个整数——和 `ProxyId` 一样，跨线程只传这个数。
 */
export type AssetHandle<T> = number & {
  readonly __asset: unique symbol;
  readonly __assetValue?: T;
};

interface AssetEntry {
  key: string;
  value: unknown;
  destroy: (value: never) => void;
  refCount: number;
}

export class AssetOwner {
  private readonly entries: (AssetEntry | undefined)[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly freeSlots: number[] = [];
  /** 反查「这个东西是不是这张表管的」。遍历式释放靠它避让。 */
  private readonly owned = new Map<unknown, number>();

  /**
   * 同 key 复用同一份资源，引用计数 +1。
   *
   * `create` 只在首次 acquire 时执行；`destroy` 记在条目上，只有归零时才调用，
   * 而且调用的是**首次登记**的那一个——避免同一份资源被两种释放方式处理。
   */
  public acquire<T>(key: string, create: () => T, destroy: (value: T) => void): AssetHandle<T> {
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const entry = this.entries[existing] as AssetEntry;
      entry.refCount += 1;
      return existing as AssetHandle<T>;
    }
    const value = create();
    const slot = this.freeSlots.pop() ?? this.entries.length;
    this.entries[slot] = {
      key,
      value,
      destroy: destroy as (value: never) => void,
      refCount: 1,
    };
    this.byKey.set(key, slot);
    this.owned.set(value, slot);
    return slot as AssetHandle<T>;
  }

  public get<T>(handle: AssetHandle<T>): T {
    const entry = this.entries[handle];
    if (!entry) throw new Error(`资源句柄已失效：${handle}`);
    return entry.value as T;
  }

  /** 引用计数归零才真正 destroy。多释放一次会立刻报错，而不是留一个悬空句柄。 */
  public release<T>(handle: AssetHandle<T>): void {
    const entry = this.entries[handle];
    if (!entry) throw new Error(`释放了不存在的资源句柄：${handle}`);
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    this.entries[handle] = undefined;
    this.byKey.delete(entry.key);
    this.owned.delete(entry.value);
    this.freeSlots.push(handle);
    (entry.destroy as (value: unknown) => void)(entry.value);
  }

  /**
   * 这个值是不是由所有权表管的。
   *
   * 「遍历场景树永远不 dispose」这条规则的落地形式：还没转成 acquire/release
   * 的遍历式释放路径靠它避让共享资源。等所有 GPU 资源都走了句柄，这个方法连同
   * 那些遍历一起删掉。
   */
  public owns(value: unknown): boolean {
    return this.owned.has(value);
  }

  /** 调试与测试用：某个 key 当前的持有者数量，没登记过就是 0。 */
  public refCount(key: string): number {
    const slot = this.byKey.get(key);
    return slot === undefined ? 0 : (this.entries[slot] as AssetEntry).refCount;
  }

  /** 当前登记的资源数。场景切换之后它应当回到基线，否则就是漏了 release。 */
  public get size(): number {
    return this.byKey.size;
  }
}

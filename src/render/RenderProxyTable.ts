import {
  toProxyId,
  type ProxyId,
  type RenderCommandSink,
  type RenderScene,
  type GuidePathState,
} from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';

/**
 * Game World 这一侧的 proxy 槽位表（引擎迁移路线图 第 3 步）。
 *
 * 槽位号原来由渲染世界分配、**通过返回值交回来**。返回值是 canvas 进渲染线程的
 * 阻塞点：函数调用要等对面回话，而线程边界上没有「等一下」。
 *
 * 所以分配挪到这一侧。渲染世界收到的是「在 3 号槽位建这个模型」，
 * 而不是「建一个然后告诉我编号」——`createMeshProxy` 因此变成一条单向命令。
 *
 * 这个类同时是命令口（`RenderCommandSink`），不是巧合：**销毁和回收槽位是同一件事**。
 * 拆成两个调用就一定会有人只写一半，然后下一个 Actor 拿到一个还挂着模型的槽位。
 * 包在一起之后 `RenderProxyComponent` 一个字都不用改——它拿到的仍然只是一个命令口。
 *
 * 槽位从 0 开始连续分配、释放后复用，和渲染世界原来那张自由表是同一套语义
 * （槽位号同时是 transform SoA 的下标，所以它必须紧凑）。
 *
 * **释放后隔一帧才复用。** 渲染线程每拍等主线程翻面之后自己兑现 transform
 * （`RenderWorldRuntime.consumePublishedFrame`），而销毁命令要等这一帧的报文到了
 * 才生效——画这一帧时旧 proxy 还在。同一帧里把刚释放的槽位交给新 Actor，新 Actor
 * 的位置就会写进旧 proxy 还在读的那个下标，旧模型在新位置上闪一帧。隔到下一帧
 * 翻面之后再复用，那时销毁命令已经先于新位置到了渲染线程。
 */
export class RenderProxyTable implements RenderCommandSink {
  readonly #free: number[] = [];
  /** 刚释放、还不能复用的槽位，以及释放时的帧号。 */
  readonly #retiring: { id: number; frameId: number }[] = [];
  #next = 0;

  public constructor(
    private readonly commands: RenderCommandSink,
    /**
     * 帧号来源，就是那段 transform SoA（每 `publish()` 涨一）。
     * 不给就不隔离，释放即复用——单线程或测试里没有另一条线程在读。
     */
    private readonly frames?: { readonly frameId: number },
  ) {}

  /** 取一个槽位。调用方随后必须用它建一个 proxy，否则这个槽位就漏了。 */
  public acquire(): ProxyId {
    this.#releaseRetired();
    return toProxyId(this.#free.pop() ?? this.#next++);
  }

  /** 已经发出去、还没还回来的槽位数。隔离中的槽位已经销毁，不算活的。 */
  public get liveCount(): number {
    return this.#next - this.#free.length - this.#retiring.length;
  }

  public destroyMeshProxy(id: ProxyId): void {
    this.commands.destroyMeshProxy(id);
    if (this.frames) this.#retiring.push({ id, frameId: this.frames.frameId });
    else this.#free.push(id);
  }

  /** 释放那一帧已经翻过面的槽位可以复用了。每次分配前扫一遍，不需要每帧钩子。 */
  #releaseRetired(): void {
    if (!this.frames || this.#retiring.length === 0) return;
    const current = this.frames.frameId;
    let kept = 0;
    for (const entry of this.#retiring) {
      if (entry.frameId < current) this.#free.push(entry.id);
      else this.#retiring[kept++] = entry;
    }
    this.#retiring.length = kept;
  }

  public setGuidePath(id: ProxyId, state: GuidePathState, pathChanged: boolean): void {
    this.commands.setGuidePath(id, state, pathChanged);
  }

  /** 换场景：渲染世界那边整个清掉了，这一侧的编号也从头开始。 */
  public reset(): void {
    this.#free.length = 0;
    this.#retiring.length = 0;
    this.#next = 0;
  }
}

/**
 * Game World 那一侧握着渲染世界所需要的全部东西：命令口、那段字节、那张槽位表。
 *
 * 三样合成一个句柄，是因为它们的生命周期完全一样——换地图三个一起换。
 * 玩家实体（本地与远端）不是 Replica，但必须和 Actor 用同一份，否则就是两套编号，
 * 也就没有边界可言了。
 */
export interface RenderWorldHandle<TScene extends RenderScene = RenderScene> {
  /**
   * 后端参数化：绝大多数持有方只需要边界接口，但**还留在主线程的那几处**
   * （鼠标拖蒙皮）要够到 Three 后端自己的方法。渲染循环真进线程之后那几处会消失，
   * 这个类型参数也跟着消失。
   */
  readonly scene: TScene;
  readonly transforms: RenderTransformBuffer;
  readonly proxyIds: RenderProxyTable;
}

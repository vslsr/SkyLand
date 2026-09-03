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
 */
export class RenderProxyTable implements RenderCommandSink {
  readonly #free: number[] = [];
  #next = 0;

  public constructor(private readonly commands: RenderCommandSink) {}

  /** 取一个槽位。调用方随后必须用它建一个 proxy，否则这个槽位就漏了。 */
  public acquire(): ProxyId {
    return toProxyId(this.#free.pop() ?? this.#next++);
  }

  /** 已经发出去、还没还回来的槽位数。 */
  public get liveCount(): number {
    return this.#next - this.#free.length;
  }

  public destroyMeshProxy(id: ProxyId): void {
    this.commands.destroyMeshProxy(id);
    this.#free.push(id);
  }

  public setGuidePath(id: ProxyId, state: GuidePathState, pathChanged: boolean): void {
    this.commands.setGuidePath(id, state, pathChanged);
  }

  /** 换场景：渲染世界那边整个清掉了，这一侧的编号也从头开始。 */
  public reset(): void {
    this.#free.length = 0;
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

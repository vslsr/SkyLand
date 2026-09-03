import type {
  GuidePathState,
  MeshProxyDesc,
  PlayerProxyDesc,
  ProxyId,
  RenderScene,
} from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import type { ChunkViewMountRequest, ChunkViewSink } from '../../world/ChunkViewHost';

/**
 * 渲染世界的命令编码（引擎迁移路线图 第 3 步）。
 *
 * 前面几步把 `RenderScene` 与 `ChunkViewSink` 上**每一个方法都改成了返回 `void`**，
 * 为的就是这一刻：一次调用能原样变成一条报文，不需要等对面回话。
 *
 * 参数全都是结构化克隆过得去的东西——数字、字符串、配置对象、类型化数组。
 * 这不是巧合，是「过边界的是描述不是对象」那条约定的直接结果：
 * `MeshProxyDesc` 本来就是一份 JSON 形状的配置，不是 `Object3D`。
 *
 * **按帧成批**：每帧几百个 proxy 各发一条 `postMessage` 会把结构化克隆的开销放大到
 * 比渲染本身还贵。所以代理只往数组里堆，一帧 `flush()` 一次——和 transform SoA
 * 的 `publish()` 同一个节奏。
 */

export type RenderCommand =
  | { readonly kind: 'createMeshProxy'; readonly id: ProxyId; readonly desc: MeshProxyDesc }
  | { readonly kind: 'createPlayerProxy'; readonly id: ProxyId; readonly desc: PlayerProxyDesc }
  | { readonly kind: 'destroyMeshProxy'; readonly id: ProxyId }
  | {
    readonly kind: 'setGuidePath';
    readonly id: ProxyId;
    readonly state: GuidePathState;
    readonly pathChanged: boolean;
  }
  | { readonly kind: 'setInteractionMarker'; readonly id: ProxyId; readonly label: string }
  | { readonly kind: 'setHoveredProxy'; readonly id: ProxyId }
  | { readonly kind: 'setTemperatureMarkersVisible'; readonly visible: boolean }
  | { readonly kind: 'setSimpleCollisionVisible'; readonly visible: boolean }
  /**
   * 注意这里**不带那段字节**：worker 一开始就拿到了同一个 `SharedArrayBuffer`，
   * 每帧再传一次视图是白费。过来的只有两个时间量。
   */
  | { readonly kind: 'updateVisuals'; readonly deltaSeconds: number; readonly elapsedSeconds: number }
  /**
   * 同样不带那段字节：这条命令的意思只是「刚翻了一面，去读」。
   * 排在 `updateVisuals` 之前，和单线程下的调用顺序一致。
   */
  | { readonly kind: 'submitTransforms' }
  | { readonly kind: 'disposeRenderScene' }
  | { readonly kind: 'mountChunk'; readonly request: ChunkViewMountRequest }
  | { readonly kind: 'unmountChunk'; readonly key: string }
  | { readonly kind: 'clearChunks' };

/** 一帧攒下来的命令。 */
export interface RenderCommandBatch {
  readonly commands: readonly RenderCommand[];
  /** 这一批里可以转移而不是复制的缓冲区（地形覆盖）。 */
  readonly transfer: readonly ArrayBufferLike[];
}

/**
 * 玩法侧那一端：把调用堆成一批。
 *
 * 它同时实现 `RenderScene` 与 `ChunkViewSink`——玩法侧本来就是拿这两个接口说话的，
 * 所以换成跨线程时调用方一个字都不用改。
 */
export class RenderCommandQueue implements RenderScene, ChunkViewSink {
  #commands: RenderCommand[] = [];
  #transfer: ArrayBufferLike[] = [];
  readonly #generatorReady: ((kind: string) => void)[] = [];
  #generatorKind?: string;

  /** 取走这一帧攒下的命令。空批返回 undefined，省掉一次 `postMessage`。 */
  public flush(): RenderCommandBatch | undefined {
    if (this.#commands.length === 0) return undefined;
    const batch = { commands: this.#commands, transfer: this.#transfer };
    this.#commands = [];
    this.#transfer = [];
    return batch;
  }

  public get pendingCount(): number {
    return this.#commands.length;
  }

  // --- RenderScene ---

  public createMeshProxy(id: ProxyId, desc: MeshProxyDesc): void {
    this.#commands.push({ kind: 'createMeshProxy', id, desc });
  }

  public createPlayerProxy(id: ProxyId, desc: PlayerProxyDesc): void {
    this.#commands.push({ kind: 'createPlayerProxy', id, desc });
  }

  public destroyMeshProxy(id: ProxyId): void {
    this.#commands.push({ kind: 'destroyMeshProxy', id });
  }

  public setGuidePath(id: ProxyId, state: GuidePathState, pathChanged: boolean): void {
    this.#commands.push({ kind: 'setGuidePath', id, state, pathChanged });
  }

  public setInteractionMarker(id: ProxyId, label: string): void {
    this.#commands.push({ kind: 'setInteractionMarker', id, label });
  }

  public setHoveredProxy(id: ProxyId): void {
    this.#commands.push({ kind: 'setHoveredProxy', id });
  }

  public setTemperatureMarkersVisible(visible: boolean): void {
    this.#commands.push({ kind: 'setTemperatureMarkersVisible', visible });
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    this.#commands.push({ kind: 'setSimpleCollisionVisible', visible });
  }

  public submitTransforms(_transforms: RenderTransformBuffer): void {
    this.#commands.push({ kind: 'submitTransforms' });
  }

  public updateVisuals(
    _transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    // 那段字节 worker 一开始就有；这里只送时间量。
    this.#commands.push({ kind: 'updateVisuals', deltaSeconds, elapsedSeconds });
  }

  public dispose(): void {
    this.#commands.push({ kind: 'disposeRenderScene' });
  }

  // --- ChunkViewSink ---

  public mount(request: ChunkViewMountRequest): void {
    this.#commands.push({ kind: 'mountChunk', request });
    // 覆盖数组这一侧发完就不再用，转移比复制便宜；空数组不值得登记。
    if (request.terrainOverrides.length > 0) this.#transfer.push(request.terrainOverrides.buffer);
  }

  public unmount(key: string): void {
    this.#commands.push({ kind: 'unmountChunk', key });
  }

  public clear(): void {
    this.#commands.push({ kind: 'clearChunks' });
  }

  /**
   * 生成后端就位的通知是**反向**的，所以它不走命令队列，走 `generatorReady()`——
   * 由持有这个队列的那一端在收到 worker 报文时调用。
   */
  public onGeneratorReady(listener: (kind: string) => void): void {
    if (this.#generatorKind !== undefined) listener(this.#generatorKind);
    else this.#generatorReady.push(listener);
  }

  /** worker 报告生成后端就位。 */
  public generatorReady(kind: string): void {
    if (this.#generatorKind !== undefined) return;
    this.#generatorKind = kind;
    for (const listener of this.#generatorReady) listener(kind);
    this.#generatorReady.length = 0;
  }
}

/** 渲染侧那一端：把一条命令兑现到真正的渲染世界。 */
export function applyRenderCommand(
  command: RenderCommand,
  target: {
    readonly scene: RenderScene;
    readonly transforms: RenderTransformBuffer;
    readonly chunkViews?: ChunkViewSink;
  },
): void {
  switch (command.kind) {
    case 'createMeshProxy':
      target.scene.createMeshProxy(command.id, command.desc);
      return;
    case 'createPlayerProxy':
      target.scene.createPlayerProxy(command.id, command.desc);
      return;
    case 'destroyMeshProxy':
      target.scene.destroyMeshProxy(command.id);
      return;
    case 'setGuidePath':
      target.scene.setGuidePath(command.id, command.state, command.pathChanged);
      return;
    case 'setInteractionMarker':
      target.scene.setInteractionMarker(command.id, command.label);
      return;
    case 'setHoveredProxy':
      target.scene.setHoveredProxy(command.id);
      return;
    case 'setTemperatureMarkersVisible':
      target.scene.setTemperatureMarkersVisible(command.visible);
      return;
    case 'setSimpleCollisionVisible':
      target.scene.setSimpleCollisionVisible(command.visible);
      return;
    case 'submitTransforms':
      target.scene.submitTransforms(target.transforms);
      return;
    case 'updateVisuals':
      target.scene.updateVisuals(target.transforms, command.deltaSeconds, command.elapsedSeconds);
      return;
    case 'disposeRenderScene':
      target.scene.dispose();
      return;
    case 'mountChunk':
      target.chunkViews?.mount(command.request);
      return;
    case 'unmountChunk':
      target.chunkViews?.unmount(command.key);
      return;
    case 'clearChunks':
      target.chunkViews?.clear();
      return;
    default:
      // 命令种类加了却忘了兑现，会在这里变成一个编译错误。
      command satisfies never;
  }
}

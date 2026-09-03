import { publishRenderThreadReport } from '../../debug/renderThreadTimings';
import { isSharedBytes } from '../../platform/index';
import { isJavaScriptChunkGeneratorForced } from '../../world/loadChunkGenerator';
import type { SceneDefinition } from '../../scenes/data/SceneDefinition';
import type { ChunkViewSink } from '../../world/ChunkViewHost';
import { RenderCameraBuffer } from '../RenderCameraBuffer';
import type { RenderScene } from '../RenderScene';
import { RenderTransformBuffer } from '../RenderTransformBuffer';
import type { RenderWorldConnection, RenderWorldPort } from '../RenderWorldRuntime';
import { RenderCommandQueue } from './renderCommands';
import type { RenderWorkerFromMain, RenderWorkerToMain } from './renderWorkerProtocol';

/**
 * 渲染世界在另一条线程上的那一版连接（引擎迁移路线图 第 3 步）。
 *
 * 和 `connectRenderWorldInProcess` 是同一个返回类型，所以要换掉的只有 `GrasslandScene`
 * 里那一行。`port` 从「真对象」换成「命令队列」，`camera` 从「本地那块字节」换成
 * 「两侧共享的那块」——拿着它们的那几个类一个字都不用改。
 *
 * 三样东西在开工时就交过去，之后再不重发：
 *
 * | | 怎么过去 |
 * | --- | --- |
 * | 画布 | `transferControlToOffscreen()`，**转移**，只能一次 |
 * | 相机 | `SharedArrayBuffer`，两侧同一块内存 |
 * | transform SoA | 同上；扩容时补一条 `adoptTransforms` |
 *
 * 之后每帧只有一次 `postMessage`：这一帧攒下的命令成批过去，空帧不发。
 */
export function connectRenderWorldInWorker(
  canvas: HTMLCanvasElement,
): RenderWorldConnection & { readonly worker: Worker } {
  if (typeof canvas.transferControlToOffscreen !== 'function') {
    throw new Error('这个浏览器没有 OffscreenCanvas，渲染循环搬不进线程');
  }
  const camera = new RenderCameraBuffer();
  const transforms = new RenderTransformBuffer();
  if (!camera.isShared || !isSharedBytes(transforms.bytes)) {
    // 没有 SAB 就只能每帧把整段字节复制过去——那比留在主线程还慢。
    throw new Error('拿不到 SharedArrayBuffer（页面没有跨源隔离？），渲染循环搬不进线程');
  }

  const worker = new Worker(new URL('./renderWorker.worker.ts', import.meta.url), {
    type: 'module',
    name: 'skyland-render',
  });
  const port = new WorkerRenderWorldPort(worker, transforms);
  const offscreen = canvas.transferControlToOffscreen();
  const start: RenderWorkerFromMain = {
    kind: 'start',
    canvas: offscreen,
    camera: camera.bytes,
    transforms: transforms.bytes,
    forceJavaScriptChunkGenerator: isJavaScriptChunkGeneratorForced(),
  };
  worker.postMessage(start, [offscreen]);
  // 扩容会重新分配，渲染侧还拿着旧的那一块——补一条命令把新的送过去。
  transforms.onGrow((bytes) => port.adoptTransforms(bytes));

  worker.addEventListener('message', (event: MessageEvent<RenderWorkerToMain>) => {
    const message = event.data;
    if (message.kind === 'slimeSurfaceDrag') {
      port.slimeSurfaceDragChanged(message.report);
      return;
    }
    if (message.kind === 'generatorReady') {
      port.generatorReady(message.generator);
      return;
    }
    if (message.kind === 'frameReport') {
      // 落进那份全局，调试面板从那里读。这里不判断面板开没开：一秒一条报文，
      // 而「开面板之前的那一秒」恰恰是最想看的那一秒。
      publishRenderThreadReport(message.report);
      return;
    }
    if (message.kind === 'failed') {
      throw new Error(`渲染线程起不来：${message.message}`);
    }
  });

  return { port, camera, worker };
}

/**
 * 主线程手上的渲染世界：一个命令队列，加上「这一帧发一次」。
 *
 * 继承而不是包一层，是因为 `RenderCommandQueue` 用的是 `#` 私有字段——那种字段
 * 复制不出去，包装对象上的方法一调就炸。子类则拿得到。
 *
 * `update()` 是空的：表现系统与 `updateVisuals` 都跑在渲染线程上，按那边的时钟。
 * `render()` 也不画画，它是「这一帧的命令攒完了，发过去」。
 */
class WorkerRenderWorldPort extends RenderCommandQueue implements RenderWorldPort {
  /**
   * 这两个跟着 `loadRenderScene` / `clearRenderScene` 走。
   *
   * 判据取自场景定义本身（`renderer.world` 决定这张图流不流式），不是回头去问渲染
   * 线程要一个答案——那又会变成一次等回话。两侧看的是同一份 JSON，结论必然一致。
   */
  #hasScene = false;
  #streams = false;

  public constructor(
    private readonly worker: Worker,
    public readonly transforms: RenderTransformBuffer,
  ) {
    super();
  }

  public get scene(): RenderScene | undefined {
    return this.#hasScene ? this : undefined;
  }

  public get chunkViews(): ChunkViewSink | undefined {
    return this.#streams ? this : undefined;
  }

  public override loadRenderScene(definition: SceneDefinition, worldSeed?: number): void {
    this.#hasScene = true;
    this.#streams = Boolean(definition.renderer.world);
    super.loadRenderScene(definition, worldSeed);
  }

  public override clearRenderScene(): void {
    this.#hasScene = false;
    this.#streams = false;
    super.clearRenderScene();
  }

  public update(): void {
    // 空的：这一帧的表现在渲染线程上跑。
  }

  public render(): void {
    const batch = this.flush();
    if (!batch) return;
    this.worker.postMessage(
      { kind: 'batch', batch } satisfies RenderWorkerFromMain,
      [...batch.transfer] as Transferable[],
    );
  }
}

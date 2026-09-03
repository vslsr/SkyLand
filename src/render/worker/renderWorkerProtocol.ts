import type { ProxyId } from '../RenderScene';
import type { RenderCommandBatch } from './renderCommands';

/**
 * 主线程 ↔ 渲染线程之间的两种报文（引擎迁移路线图 第 3 步）。
 *
 * 只有两种，而且是不对称的：过去的是命令，回来的是**通知**。这条不对称正是
 * §2 那条「边界是单向的」在线程上的样子——渲染侧从不被问话，只被告知，
 * 以及在两处它独有的事实上主动开口。
 */

export type RenderWorkerFromMain =
  | {
      readonly kind: 'start';
      /** `transferControlToOffscreen()` 的产物。只能转移一次。 */
      readonly canvas: OffscreenCanvas;
      /** 相机与 transform 两段 `SharedArrayBuffer`：不转移，两侧看同一块内存。 */
      readonly camera: ArrayBufferLike;
      readonly transforms: ArrayBufferLike;
      /**
       * `?chunkgen=js` 那个开关。
       *
       * worker 的 `location` 是它自己脚本的地址，读不到页面的查询串，所以由主线程
       * 读好交过去——否则这个调试开关会静默失效。
       */
      readonly forceJavaScriptChunkGenerator: boolean;
    }
  | { readonly kind: 'batch'; readonly batch: RenderCommandBatch };

export type RenderWorkerToMain =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string }
  /** 蒙皮拖拽抓住了没有。判据只有渲染侧有，所以它必须自己开口。 */
  | { readonly kind: 'slimeSurfaceDrag'; readonly id: ProxyId; readonly dragging: boolean }
  /**
   * chunk 生成后端（WASM 还是 JS）就位了。
   *
   * 同样是渲染侧独有的事实：模板要 THREE，所以生成器住在那一边。`ChunkStreamer`
   * 在收到它之前一个 chunk 都不规划——先规划会注册出「踩得到但看不见」的碰撞体。
   */
  | { readonly kind: 'generatorReady'; readonly generator: string };

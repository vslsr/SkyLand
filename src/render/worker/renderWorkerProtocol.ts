import type { FrameTimingReport } from '../../platform/index';
import type { SlimeSurfaceDragReport } from '../RenderScene';
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
      /**
       * `?renderpace=free` 那个开关：渲染线程不等主线程翻面，每拍读最新一面。
       *
       * 默认是等（'locked'）。留这个开关是为了在面板上对照：不等的话「重复／跳过」
       * 会随两条线程的相位漂动，那正是「两边都满帧、画面却一顿一顿」的来源。
       */
      readonly renderPacing: RenderPacingMode;
    }
  | { readonly kind: 'batch'; readonly batch: RenderCommandBatch };

/** 'locked'：渲染线程每拍等主线程翻面，一帧画一次；'free'：读最新一面，老行为。 */
export type RenderPacingMode = 'locked' | 'free';

export type RenderWorkerToMain =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string }
  /** 蒙皮拖拽抓住了没有。判据只有渲染侧有，所以它必须自己开口。 */
  | { readonly kind: 'slimeSurfaceDrag'; readonly report: SlimeSurfaceDragReport }
  /**
   * chunk 生成后端（WASM 还是 JS）就位了。
   *
   * 同样是渲染侧独有的事实：模板要 THREE，所以生成器住在那一边。`ChunkStreamer`
   * 在收到它之前一个 chunk 都不规划——先规划会注册出「踩得到但看不见」的碰撞体。
   */
  | { readonly kind: 'generatorReady'; readonly generator: string }
  /**
   * 渲染线程自己那一份帧计时，每秒一条。
   *
   * 帧循环搬过来之后，主线程那份报表只剩下「发命令」几十微秒，画面卡不卡在它上面
   * 完全看不出来——真正的每帧开销（绘制、chunk 几何、草）全在这一侧。所以这条
   * 通知和另外两条一样，是**只有渲染侧知道的事实**，必须由它主动开口。
   *
   * 一秒一条、约两百字节，生产构建里也照发：调试面板一打开就有数，不必等开关
   * 生效后再攒一秒。
   */
  | {
      readonly kind: 'frameReport';
      readonly report: FrameTimingReport;
      readonly pacing: FramePacing;
    };

/**
 * 两条循环的配对情况。
 *
 * 玩法每帧写满 transform 双缓冲并 `publish()`，渲染线程按自己的 rAF 画。两条循环
 * 都挂在同一个 vsync 上，但谁先跑完没有保证：相位一交叉，就会出现「同一份
 * transform 被画了两遍」紧跟着「有一份根本没被画出来」。两条线程各自都是满帧，
 * 画面却在这对重复/跳过上一顿。光看 fps 和耗时永远看不出来，所以单独数出来。
 *
 * 现在渲染线程默认在每拍里**等主线程翻面**再画（`RenderFramePacer`），这几个数
 * 因此应当接近零；不为零时，`waitTimeouts` 说的是主线程这一拍没赶上。
 *
 * 数的是**画出来的**那一帧：原来按读到的帧号数，而画面用的是命令到达时兑现的
 * 位置，两者差一帧，那个数字看不见真正的重复与跳过。
 */
export interface FramePacing {
  /** 这一秒画了多少帧。 */
  readonly frames: number;
  /** 其中有多少帧画的 transform 与上一帧完全相同（玩法没赶上）。 */
  readonly duplicated: number;
  /** 有多少帧跨过了不止一次 publish（玩法赶超了，中间那份没被画出来）。 */
  readonly skipped: number;
  /**
   * 有多少帧里相机与世界不是同一帧的。
   *
   * 相机与 transform 是两段字节、两次翻面。原来一个在命令到达时兑现、一个在画的
   * 那一刻读，中间主线程再翻一次面，相机就比世界新一帧——玩家在屏幕上倒退一步
   * 再追上来。现在两样在同一处一起读，这个数应当恒为 0。
   */
  readonly torn: number;
  /** 这一秒里渲染线程等主线程翻面等了多久：中位数与最大值（毫秒）。 */
  readonly waitMedianMs: number;
  readonly waitMaximumMs: number;
  /** 等到上限主线程还没翻面的帧数——主线程这一拍没赶上，这一帧只能画上一帧。 */
  readonly waitTimeouts: number;
  /**
   * 最近十秒里最慢的那一帧，以及它是几秒前的事。
   *
   * 报表本身每秒清一次，卡顿却常常是几秒一次的——只看当前这一秒，十有八九
   * 正好错过。这一项跨窗口留着，"我卡了一下但面板上什么都没有"就不会再发生。
   */
  readonly worstMilliseconds: number;
  readonly worstSecondsAgo: number;
  /**
   * 画面里的东西**动得匀不匀**。
   *
   * 帧发得再准，如果每帧推进的距离忽大忽小，看上去照样是一顿一顿的——固定步模拟
   * 不插值就是这个毛病：这一帧走了两步、下一帧一步没走，fps 完美，人却在抽搐。
   * 这里逐帧量相机位移（跟随相机的位移就是眼睛看到的位移）：
   *
   * - `motionFrames` 相机确实在动的帧数
   * - `motionStalls` 其中位移不到中位数一成的帧数——「这一帧画面基本没动」
   * - `motionMedian` / `motionMaximum` 每帧位移的中位数与最大值（米）
   */
  readonly motionFrames: number;
  readonly motionStalls: number;
  readonly motionMedian: number;
  readonly motionMaximum: number;
}

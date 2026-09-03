import { isDevelopmentRuntime } from './developmentRuntime';

/**
 * 开发期常驻的帧率面板。
 *
 * 它补的是 `FrameTimeline` 拿不到的那一半。`FrameTimeline` 量的是主线程各阶段
 * 的自耗时，每 10 秒往控制台打一份分位数报表——那是**回头看**的证据；面板回答
 * 的是**此刻**跑多少帧。更要紧的是 GPU 那一列：`performance.now()` 只能量到
 * 命令提交为止，量不到显卡真正画完，所以「主线程明明很闲，帧率却上不去」这类
 * 问题在 FrameTimeline 里是看不见的。这里用 `EXT_disjoint_timer_query_webgl2`
 * 把它读出来。
 *
 * 只在开发运行时装载：`stats-gl` 走动态 import，生产构建会把它切成一个永远
 * 不会被请求的独立 chunk，玩家既下载不到也看不到这块面板。
 */
export interface FrameStatsPanel {
  /** 帧首调用：开一个跨整帧的 GPU 计时查询。 */
  begin(): void;
  /** 帧尾调用：结束查询、读回上一帧的结果并刷新面板。 */
  end(): void;
  dispose(): void;
}

/** game-layer 与 common-ui-root 最高用到 5；面板压在它们之上。 */
const PANEL_Z_INDEX = '40';

export interface FrameStatsPanelOptions {
  /** 渲染器正在用的那块画布。 */
  canvas: HTMLCanvasElement;
  /** 面板挂载点，默认 `document.body`。 */
  host?: HTMLElement;
}

/**
 * 装一块帧率面板；不在开发运行时就返回 undefined。
 *
 * **必须在 `WebGLRenderer` 建好之后调用。** 面板拿 GPU 时间的方式是
 * `canvas.getContext('webgl2')`——浏览器对同一块画布只会给出同一个上下文，
 * 谁先调用谁的 attributes 生效。抢在渲染器前面调用，会让 `antialias`、
 * `alpha`、`powerPreference` 这些参数被静默丢弃。
 *
 * **渲染循环进 worker 之后这块面板装不上了**，而且这不是一个可以绕过去的实现细节：
 * 画布的控制权被 `transferControlToOffscreen()` 转移走了，主线程这一侧再也拿不到
 * 那个上下文——`getContext` 会直接抛 `InvalidStateError`。GPU 计时只能在渲染线程上
 * 读（`EXT_disjoint_timer_query_webgl2` 在那边），而 `stats-gl` 的面板是 DOM，
 * 只能在主线程上画。要恢复它得把「读」和「画」拆开：worker 读、报文回来、主线程画。
 * 那是一件独立的事，所以这里先老实地退让并说清楚原因。
 */
export async function createFrameStatsPanel(
  options: FrameStatsPanelOptions,
): Promise<FrameStatsPanel | undefined> {
  if (!isDevelopmentRuntime()) return undefined;

  const { default: Stats } = await import('stats-gl');
  const stats = new Stats({ trackGPU: true, trackFPS: true, horizontal: true, precision: 1 });
  try {
    // init 是异步的（WebGPU 那条路要等设备），WebGL2 这条路里它同步就走完了。
    await stats.init(options.canvas);
  } catch (error) {
    console.info(
      '[debug] 帧率面板没装：画布的控制权已经交给渲染线程，主线程这边拿不到 WebGL 上下文。'
      + ' GPU 计时要恢复，得由 worker 读了再发回来。',
      error,
    );
    stats.dispose();
    return undefined;
  }

  const panel = stats.dom;
  panel.style.position = 'fixed';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.zIndex = PANEL_Z_INDEX;
  const host = options.host ?? document.body;
  host.appendChild(panel);

  let disposed = false;
  return {
    begin: () => {
      if (!disposed) stats.begin();
    },
    end: () => {
      if (disposed) return;
      stats.end();
      stats.update();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      panel.remove();
      stats.dispose();
    },
  };
}

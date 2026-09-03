import './style.css';
import './ui/scrollbars.css';
import { initRapier } from '../shared/physics/RapierRuntime.mjs';
import {
  describeThreadingCapabilities,
  formatFrameTimingReport,
  frameTimeline,
} from './platform/index';
import { createFrameStatsPanel } from './debug/FrameStatsPanel';
import { beginMainFrame, endMainFrame } from './debug/mainThreadPacing';
import { suppressBrowserContextMenu } from './input/contextMenu';
import { GrasslandScene } from './scenes/GrasslandScene';
import { SceneManager } from './scenes/SceneManager';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
}

const errorPanel = document.getElementById('webgl-error');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWebGLContextError(error: unknown): boolean {
  const message = errorMessage(error);
  return /webgl.*context|context.*webgl|error creating webgl/i.test(message);
}

function showStartupError(error: unknown): void {
  console.error(error);
  if (!errorPanel) return;
  errorPanel.textContent = isWebGLContextError(error)
    ? '当前浏览器无法创建 WebGL 上下文，请检查硬件加速、显卡驱动或浏览器设置。'
    : `客户端初始化失败：${errorMessage(error)}`;
  errorPanel.hidden = false;
}

// 隔离没打开是个静默降级：SharedArrayBuffer 会直接不可用，而不是报错。
// 把能力集打在启动日志的第一行，线上排查时不必再去猜响应头。
console.info(`SkyLand platform: ${describeThreadingCapabilities()}`);

// 右键属于游戏输入，浏览器菜单不该抢走它。放在 try 之外：这条和 WebGL、
// 物理运行时都没关系，启动失败时的错误面板上右键也不该弹菜单。
suppressBrowserContextMenu();

try {
  await initRapier(() => import('@dimforge/rapier3d'));
  const sceneManager = new SceneManager();
  const canvas = requireElement<HTMLCanvasElement>('scene');
  const grasslandScene = new GrasslandScene({
    canvas,
    sceneRoot: requireElement<HTMLElement>('app-shell'),
    baseLayer: requireElement<HTMLElement>('game-layer'),
    overlayRoot: requireElement<HTMLElement>('common-ui-root'),
  });
  sceneManager.switchTo(grasslandScene);
  // 必须排在场景之后：渲染器要先拿走这块画布的 WebGL2 上下文，面板才只是
  // 搭个便车读 GPU 计时，而不是抢先用默认 attributes 把上下文建出来。
  const frameStats = await createFrameStatsPanel({ canvas });

  let previousTime = performance.now();
  const startedAt = previousTime;
  // 帧时间报表每隔一段打一次。第 2 步的判断全靠它，所以它是常开的：
  // 每帧多两次 performance.now()，代价可以忽略，而「上线之后才发现没打点」不行。
  const FRAME_REPORT_INTERVAL_SECONDS = 10;
  let nextReportAt = FRAME_REPORT_INTERVAL_SECONDS;

  const frame = (now: number): void => {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.05);
    const elapsedSeconds = (now - startedAt) / 1000;
    previousTime = now;
    frameStats?.begin();
    // 丢拍与画过头记在回调外面：各阶段耗时看不见回调之间的空洞。
    beginMainFrame(now);
    // 帧边界在这里，不在场景里：整帧减去各阶段之和就是还没打点的地方
    // （引擎迁移路线图 第 2 步——先有证据，再拆线程）。
    frameTimeline.beginFrame();
    sceneManager.update(deltaSeconds, elapsedSeconds);
    sceneManager.render(elapsedSeconds);
    frameTimeline.endFrame();
    endMainFrame(now);
    frameStats?.end();
    if (elapsedSeconds >= nextReportAt) {
      nextReportAt = elapsedSeconds + FRAME_REPORT_INTERVAL_SECONDS;
      console.info(`[frame]\n${formatFrameTimingReport(frameTimeline.report())}`);
      frameTimeline.reset();
    }
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
} catch (error) {
  showStartupError(error);
}

import './style.css';
import './ui/scrollbars.css';
import { initRapier } from '../shared/physics/RapierRuntime.mjs';
import { describeThreadingCapabilities } from './platform/index';
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

try {
  await initRapier(() => import('@dimforge/rapier3d'));
  const sceneManager = new SceneManager();
  const grasslandScene = new GrasslandScene({
    canvas: requireElement<HTMLCanvasElement>('scene'),
    sceneRoot: requireElement<HTMLElement>('app-shell'),
    baseLayer: requireElement<HTMLElement>('game-layer'),
    overlayRoot: requireElement<HTMLElement>('common-ui-root'),
  });
  sceneManager.switchTo(grasslandScene);

  let previousTime = performance.now();
  const startedAt = previousTime;

  const frame = (now: number): void => {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.05);
    const elapsedSeconds = (now - startedAt) / 1000;
    previousTime = now;
    sceneManager.update(deltaSeconds, elapsedSeconds);
    sceneManager.render(elapsedSeconds);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
} catch (error) {
  showStartupError(error);
}

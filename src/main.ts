import './style.css';
import { GrasslandScene } from './scenes/GrasslandScene';
import { SceneManager } from './scenes/SceneManager';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
}

const errorPanel = document.getElementById('webgl-error');

try {
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
  console.error(error);
  if (errorPanel) errorPanel.hidden = false;
}

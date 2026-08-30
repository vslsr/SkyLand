import './style.css';
import { FlyController } from './camera/FlyController';
import { SceneRenderer } from './rendering/SceneRenderer';
import { HudController } from './ui/HudController';

const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
const errorPanel = document.getElementById('webgl-error');

if (!canvas) throw new Error('缺少场景 canvas');

try {
  const hud = new HudController();
  const renderer = new SceneRenderer(canvas);
  const controller = new FlyController(canvas, {
    position: [0, 4.2, 13.5],
    yaw: 0,
    pitch: -0.12,
    onLockChange: (locked) => hud.setLocked(locked),
  });

  let previousTime = performance.now();

  hud.onEnter(() => controller.requestLock());
  const frame = (now: number): void => {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.05);
    previousTime = now;
    controller.update(deltaSeconds);
    renderer.render(controller.frame);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
} catch (error) {
  console.error(error);
  if (errorPanel) errorPanel.hidden = false;
}

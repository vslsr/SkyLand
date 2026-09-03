/// <reference lib="webworker" />
import { RenderCameraBuffer } from '../RenderCameraBuffer';
import { RenderInstanceBuffer } from '../RenderInstanceBuffer';
import { RenderTransformBuffer } from '../RenderTransformBuffer';
import { RenderWorldRuntime } from '../RenderWorldRuntime';
import { FRUIT_FLOAT_STRIDE, FRUIT_INT_STRIDE } from '../fruitInstanceLayout';
import { PROP_FLOAT_STRIDE, PROP_INT_STRIDE } from '../propInstanceLayout';
import { forceJavaScriptChunkGenerator } from '../../world/loadChunkGenerator';
import { applyRenderCommand } from './renderCommands';
import type { RenderWorkerFromMain, RenderWorkerToMain } from './renderWorkerProtocol';

/**
 * 渲染线程（引擎迁移路线图 第 3 步）。
 *
 * 这个文件很短，而那正是这一整步的结论：`RenderWorldRuntime` 从一开始就是照
 * 「只吃画布 + 命令 + 字节」写的，所以搬进来不需要给它开任何后门。这里只做三件事——
 * 接画布、兑现命令、按自己的时钟画。
 *
 * **帧循环在这一侧。** 主线程发命令、写字节，什么时候画由这边的 `requestAnimationFrame`
 * 决定。玩法卡一帧不会让画面跟着卡，这就是搬进来的全部意义。
 */

const post = (message: RenderWorkerToMain): void => {
  (self as unknown as Worker).postMessage(message);
};

let runtime: RenderWorldRuntime | undefined;
let transforms: RenderTransformBuffer | undefined;
const propInstances = new RenderInstanceBuffer(PROP_INT_STRIDE, PROP_FLOAT_STRIDE);
const fruitInstances = new RenderInstanceBuffer(FRUIT_INT_STRIDE, FRUIT_FLOAT_STRIDE);
/** 上一帧的时刻，用来算这一侧自己的 dt。 */
let previous = 0;
let elapsed = 0;

self.addEventListener('message', (event: MessageEvent<RenderWorkerFromMain>) => {
  const message = event.data;
  if (message.kind === 'start') {
    forceJavaScriptChunkGenerator(message.forceJavaScriptChunkGenerator);
    start(message.canvas, message.camera, message.transforms);
    return;
  }
  if (!runtime || !transforms) return;
  for (const command of message.batch.commands) {
    applyRenderCommand(command, {
      scene: runtime.scene ?? NO_SCENE,
      transforms,
      propInstances,
      fruitInstances,
      chunkViews: runtime.chunkViews,
      runtime,
      adoptTransforms: (bytes) => { transforms = RenderTransformBuffer.fromBytes(bytes); },
    });
  }
});

function start(
  canvas: OffscreenCanvas,
  cameraBytes: ArrayBufferLike,
  transformBytes: ArrayBufferLike,
): void {
  try {
    transforms = RenderTransformBuffer.fromBytes(transformBytes);
    runtime = new RenderWorldRuntime(
      canvas,
      RenderCameraBuffer.fromBytes(cameraBytes),
      transforms,
    );
    // 两条反向通知：都是只有这一侧知道的事实，走 postMessage，不进命令队列。
    runtime.setSlimeSurfaceDragListener((id, dragging) => {
      post({ kind: 'slimeSurfaceDrag', id, dragging });
    });
    runtime.setGeneratorReadyListener((generator) => post({ kind: 'generatorReady', generator }));
    post({ kind: 'ready' });
    (self as unknown as Window).requestAnimationFrame(frame);
  } catch (error) {
    post({
      kind: 'failed',
      message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    });
  }
}

function frame(now: number): void {
  (self as unknown as Window).requestAnimationFrame(frame);
  if (!runtime) return;
  // 第一帧没有前一帧可减；之后钳到 100ms，切标签页回来时不要一次跳一大步。
  const deltaSeconds = previous === 0 ? 1 / 60 : Math.min((now - previous) / 1000, 0.1);
  previous = now;
  elapsed += deltaSeconds;
  runtime.update(deltaSeconds, elapsed);
  runtime.render();
}

/**
 * 还没加载地图时命令的去处。
 *
 * 主线程发命令与这一侧建好渲染世界之间有一段窗口（换场景那一瞬），把命令丢给它
 * 比让 `applyRenderCommand` 每条都判空干净——渲染世界还没有，这些命令本来就没有意义。
 */
const NO_SCENE = new Proxy({}, { get: () => () => undefined }) as never;

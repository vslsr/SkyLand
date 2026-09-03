/// <reference lib="webworker" />
import { createRenderCamera, RenderCameraBuffer } from '../RenderCameraBuffer';
import { RenderInstanceBuffer } from '../RenderInstanceBuffer';
import { RenderTransformBuffer } from '../RenderTransformBuffer';
import { RenderWorldRuntime } from '../RenderWorldRuntime';
import { FRUIT_FLOAT_STRIDE, FRUIT_INT_STRIDE } from '../fruitInstanceLayout';
import { PROP_FLOAT_STRIDE, PROP_INT_STRIDE } from '../propInstanceLayout';
import { forceJavaScriptChunkGenerator } from '../../world/loadChunkGenerator';
import { frameTimeline } from '../../platform/index';
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
let cameraBuffer: RenderCameraBuffer | undefined;
const propInstances = new RenderInstanceBuffer(PROP_INT_STRIDE, PROP_FLOAT_STRIDE);
const fruitInstances = new RenderInstanceBuffer(FRUIT_INT_STRIDE, FRUIT_FLOAT_STRIDE);
/** 上一帧的时刻，用来算这一侧自己的 dt。 */
let previous = 0;
let elapsed = 0;
/** 上一次把帧计时报表发回主线程的时刻。 */
let reportedAt = 0;

/** 帧计时报表的发送间隔。一秒一条足够看清趋势，又不会把 postMessage 变成负担。 */
const FRAME_REPORT_INTERVAL_MS = 1000;

/** 上一帧读到的玩法帧号，用来数重复与跳过。 */
let lastTransformFrameId = -1;
let pacingFrames = 0;
let pacingDuplicated = 0;
let pacingSkipped = 0;
/** 跨报表窗口保留的最差帧。卡顿几秒一次，只看当前这一秒会正好错过。 */
let worstFrameMilliseconds = 0;
let worstFrameAt = 0;
const WORST_FRAME_WINDOW_MS = 10_000;

/** 上一帧的相机位置，用来逐帧量画面到底推进了多少。复用一个读出对象，不每帧新建。 */
const cameraSample = createRenderCamera();
let previousCamera: [number, number, number] | undefined;
const motionSamples: number[] = [];
/** 位移小于中位数这个比例的帧算「基本没动」。 */
const MOTION_STALL_RATIO = 0.1;
/** 低于这个位移就认为相机是静止的，不计入统计（站着不动时没有匀不匀可言）。 */
const MOTION_IDLE_METERS = 0.0005;

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
    cameraBuffer = RenderCameraBuffer.fromBytes(cameraBytes);
    runtime = new RenderWorldRuntime(canvas, cameraBuffer, transforms);
    // 两条反向通知：都是只有这一侧知道的事实，走 postMessage，不进命令队列。
    // 回报里的那份逐帧复用，`postMessage` 会结构化克隆，所以摊平成一条报文。
    runtime.setSlimeSurfaceDragListener((report) => post({
      kind: 'slimeSurfaceDrag',
      report: { ...report },
    }));
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
  // 帧边界打在这里，不在 runtime 里：整帧减去各阶段之和，剩下的就是还没打点的地方。
  // 帧循环搬进这条线程之后，这才是「一帧到底多久」的唯一现场。
  const startedAt = (globalThis.performance ?? Date).now();
  frameTimeline.beginFrame();
  frameTimeline.measure('render-update', () => runtime?.update(deltaSeconds, elapsed));
  frameTimeline.measure('render-draw', () => runtime?.render());
  frameTimeline.endFrame();
  const frameMilliseconds = (globalThis.performance ?? Date).now() - startedAt;
  if (frameMilliseconds >= worstFrameMilliseconds || now - worstFrameAt > WORST_FRAME_WINDOW_MS) {
    worstFrameMilliseconds = frameMilliseconds;
    worstFrameAt = now;
  }

  // 这一帧画的是玩法的第几帧。两条循环各跑各的 rAF，相位一漂就会「同一份画两遍」
  // 接着「有一份没画」——两边都还是满帧，画面却在这对上一顿。
  // 相机每帧推进了多远。帧再准，位移忽大忽小照样看着顿。
  const camera = cameraBuffer?.read(cameraSample);
  if (camera) {
    const [x, y, z] = camera.position;
    if (previousCamera) {
      const moved = Math.hypot(x - previousCamera[0], y - previousCamera[1], z - previousCamera[2]);
      if (moved > MOTION_IDLE_METERS) motionSamples.push(moved);
    }
    previousCamera = [x, y, z];
  }

  const frameId = transforms?.frameId ?? -1;
  if (frameId >= 0) {
    pacingFrames += 1;
    if (lastTransformFrameId >= 0) {
      const advanced = frameId - lastTransformFrameId;
      if (advanced === 0) pacingDuplicated += 1;
      else if (advanced > 1) pacingSkipped += 1;
    }
    lastTransformFrameId = frameId;
  }

  if (reportedAt === 0) reportedAt = now;
  if (now - reportedAt >= FRAME_REPORT_INTERVAL_MS) {
    reportedAt = now;
    // 报完就清：面板看的是「最近一秒」，而不是从进图到现在的平均——
    // 卡顿是一阵一阵的，累计平均会把它抹平。
    post({
      kind: 'frameReport',
      report: frameTimeline.report(),
      pacing: {
        frames: pacingFrames,
        duplicated: pacingDuplicated,
        skipped: pacingSkipped,
        worstMilliseconds: worstFrameMilliseconds,
        worstSecondsAgo: Math.max(0, (now - worstFrameAt) / 1000),
        ...summarizeMotion(),
      },
    });
    frameTimeline.reset();
    pacingFrames = 0;
    pacingDuplicated = 0;
    pacingSkipped = 0;
    motionSamples.length = 0;
  }
}

/** 把这一秒的逐帧位移收成四个数。样本量只有几十，直接排序即可。 */
function summarizeMotion(): {
  motionFrames: number;
  motionStalls: number;
  motionMedian: number;
  motionMaximum: number;
} {
  if (motionSamples.length === 0) {
    return { motionFrames: 0, motionStalls: 0, motionMedian: 0, motionMaximum: 0 };
  }
  const sorted = [...motionSamples].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    motionFrames: sorted.length,
    motionStalls: sorted.filter((value) => value < median * MOTION_STALL_RATIO).length,
    motionMedian: median,
    motionMaximum: sorted[sorted.length - 1],
  };
}

/**
 * 还没加载地图时命令的去处。
 *
 * 主线程发命令与这一侧建好渲染世界之间有一段窗口（换场景那一瞬），把命令丢给它
 * 比让 `applyRenderCommand` 每条都判空干净——渲染世界还没有，这些命令本来就没有意义。
 */
const NO_SCENE = new Proxy({}, { get: () => () => undefined }) as never;

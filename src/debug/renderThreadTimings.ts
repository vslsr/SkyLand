import type { FrameTimingReport } from '../platform/index';

/**
 * 渲染线程最近一份帧计时。
 *
 * 帧循环搬进 worker 之后，主线程那份 `frameTimeline` 只剩下「发命令」几十微秒——
 * 画面卡不卡在它上面完全看不出来。渲染线程每秒把自己那份报表发回来，落在这里，
 * 调试面板从这里读。
 *
 * 和 `frameTimeline` 一样是进程内唯一的一份：写它的是 worker 连接，读它的是调试
 * 面板，中间穿一层 listener 只会让两个不相干的类互相认识。
 */

let latest: FrameTimingReport | undefined;
let receivedAt = 0;

const now = (): number => (globalThis.performance ?? Date).now();

export function publishRenderThreadReport(report: FrameTimingReport): void {
  latest = report;
  receivedAt = now();
}

/**
 * 最近一份报表，以及它有多旧。
 *
 * 「有多旧」不是装饰：渲染线程崩了或者卡死时它就不再发了，面板必须显示成陈旧，
 * 而不是把最后一份好数据一直挂在那儿假装一切正常。
 */
export function readRenderThreadReport(): {
  report: FrameTimingReport;
  ageMilliseconds: number;
} | undefined {
  if (!latest) return undefined;
  return { report: latest, ageMilliseconds: now() - receivedAt };
}

/** 换地图或断开连接时清掉，避免上一张图的数字留在面板上。 */
export function clearRenderThreadReport(): void {
  latest = undefined;
  receivedAt = 0;
}

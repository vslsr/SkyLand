/**
 * 主线程这一侧的节拍账：rAF 有没有丢拍、帧有没有画过头、和解拉回了几次。
 *
 * `frameTimeline` 量的是回调**里面**的耗时，看不见回调**之间**的空洞：一次 GC、
 * 一条长报文、浏览器合成器少发一拍，主线程这一帧的 dt 就是 33ms，模拟一口气走两步，
 * 画面跳一下——而各阶段的耗时全都正常。所以这里单独记三样：
 *
 * - **丢拍**：相邻两次 rAF 时间戳之差超过一拍半。时间戳对齐 vsync，差多少拍就是丢了多少拍。
 * - **超时**：回调结束时已经过了下一个 vsync——这一帧的机位与 transform 会晚一拍才被画出来。
 * - **和解**：快照把预测拉回了几次、最远多少、有没有瞬移。走着走着被拉回一下，
 *   在配对与耗时上一个数字都不会变，只有这里看得见。
 *
 * 和 `renderThreadTimings` 一样是进程内唯一的一份：主循环与场景往里写，面板每秒读一次并清零。
 */

export interface MainThreadPacingReport {
  /** 这一秒的 rAF 回调次数。 */
  readonly frames: number;
  /** 相邻 rAF 时间戳之差超过一拍半的次数，以及最长的那一次（毫秒）。 */
  readonly droppedFrames: number;
  readonly longestGapMs: number;
  /** 回调结束已经过了下一个 vsync 的次数，以及过得最多的那一次（毫秒）。 */
  readonly overrunFrames: number;
  readonly worstOverrunMs: number;
  /** 快照和解：拉回（超出容差、走可见修正）的次数、最大残差（米）、瞬移次数。 */
  readonly corrections: number;
  readonly worstResidualMeters: number;
  readonly snaps: number;
}

/** rAF 间隔取最近这么多拍的中位数，一次长帧不会把「一拍」估长。 */
const INTERVAL_SAMPLES = 8;
const DEFAULT_INTERVAL_MS = 1000 / 60;
/** 超过这个比例的间隔算丢拍。 */
const DROPPED_RATIO = 1.5;

const clock = (): number => (globalThis.performance ?? Date).now();

let intervalMs = DEFAULT_INTERVAL_MS;
const intervals: number[] = [];
let lastFrameAt: number | undefined;
let frames = 0;
let droppedFrames = 0;
let longestGapMs = 0;
let overrunFrames = 0;
let worstOverrunMs = 0;
let corrections = 0;
let worstResidualMeters = 0;
let snaps = 0;

/** 一拍开始。`now` 是 rAF 给的时间戳，对齐 vsync。 */
export function beginMainFrame(now: number): void {
  frames += 1;
  if (lastFrameAt !== undefined) {
    const gap = now - lastFrameAt;
    // 切标签页回来那一拍会隔很久；超过 100ms 的间隔不算刷新率，但算一次丢拍。
    if (gap > 0 && gap < 100) {
      intervals.push(gap);
      if (intervals.length > INTERVAL_SAMPLES) intervals.shift();
      const sorted = [...intervals].sort((left, right) => left - right);
      intervalMs = sorted[Math.floor(sorted.length / 2)];
    }
    if (gap > intervalMs * DROPPED_RATIO) {
      droppedFrames += 1;
      longestGapMs = Math.max(longestGapMs, gap);
    }
  }
  lastFrameAt = now;
}

/** 一拍结束：回调结束时比下一个 vsync 晚了多少。 */
export function endMainFrame(now: number): void {
  const overrun = clock() - (now + intervalMs);
  if (overrun > 0) {
    overrunFrames += 1;
    worstOverrunMs = Math.max(worstOverrunMs, overrun);
  }
}

/** 一次快照和解的结果。容差内的收敛不算拉回；`corrected` 才是画面上看得见的那种。 */
export function recordReconciliation(result: {
  readonly corrected?: boolean;
  readonly snapped?: boolean;
  readonly residualDistance?: number;
}): void {
  if (result.corrected) corrections += 1;
  if (result.snapped) snaps += 1;
  if (Number.isFinite(result.residualDistance)) {
    worstResidualMeters = Math.max(worstResidualMeters, result.residualDistance as number);
  }
}

/** 这一秒的账；报完清零。 */
export function reportMainThreadPacing(): MainThreadPacingReport {
  const report: MainThreadPacingReport = {
    frames,
    droppedFrames,
    longestGapMs,
    overrunFrames,
    worstOverrunMs,
    corrections,
    worstResidualMeters,
    snaps,
  };
  frames = 0;
  droppedFrames = 0;
  longestGapMs = 0;
  overrunFrames = 0;
  worstOverrunMs = 0;
  corrections = 0;
  worstResidualMeters = 0;
  snaps = 0;
  return report;
}

/** 测试用：连间隔估计一起归零。 */
export function resetMainThreadPacing(): void {
  reportMainThreadPacing();
  intervals.length = 0;
  intervalMs = DEFAULT_INTERVAL_MS;
  lastFrameAt = undefined;
}

/** 当前估计的一拍长度（毫秒）。 */
export function mainFrameIntervalMs(): number {
  return intervalMs;
}

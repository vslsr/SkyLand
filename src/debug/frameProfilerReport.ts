import type { FrameTimingReport } from '../platform/index';

/**
 * 帧计时的纯文本排版。
 *
 * 单独一个文件是为了能在没有 DOM 的地方测：面板本身只是把这里产出的行贴进去。
 */

export interface ProfilerThreadSample {
  /** 线程名，显示用。 */
  readonly label: string;
  /**
   * 这一秒的帧数。渲染线程直接用报表里的 frames（它每秒清一次），
   * 主线程由面板自己数——它那份 `frameTimeline` 的窗口是十秒，帧数不等于 fps。
   */
  readonly fps?: number;
  readonly report?: FrameTimingReport;
  /** 报表的年龄，超过阈值就标成陈旧。只有跨线程来的那份需要。 */
  readonly ageMilliseconds?: number;
  /** 没有报表时显示的原因，例如「渲染循环在主线程上」。 */
  readonly absentReason?: string;
}

/** 超过这个年龄就认为渲染线程已经不发了。它每秒发一条，两秒没来必然有问题。 */
export const STALE_REPORT_MILLISECONDS = 2500;

/** 每条线程最多列几个阶段。列全了面板会盖住半个屏幕，而排在后面的都是零点几毫秒。 */
export const DEFAULT_PHASE_LIMIT = 5;

function milliseconds(value: number): string {
  return `${value.toFixed(2)}ms`.padStart(8);
}

/**
 * 把若干条线程的帧计时排成等宽文本。
 *
 * 每条线程一行抬头（fps + 整帧的 p50/p95/max），下面跟着最耗时的几个阶段。
 * 阶段记的是**自耗时**，所以「各阶段之和 < 整帧」剩下的就是还没打点的地方。
 */
export function formatFrameProfiler(
  threads: readonly ProfilerThreadSample[],
  phaseLimit = DEFAULT_PHASE_LIMIT,
): string[] {
  const lines: string[] = [];
  for (const thread of threads) {
    const stale = thread.ageMilliseconds !== undefined
      && thread.ageMilliseconds > STALE_REPORT_MILLISECONDS;
    if (!thread.report || stale) {
      const reason = stale
        ? `没有新数据（${(thread.ageMilliseconds! / 1000).toFixed(1)}s 前）`
        : thread.absentReason ?? '没有数据';
      lines.push(`${thread.label}  ${reason}`);
      continue;
    }
    const { report } = thread;
    const fps = thread.fps ?? report.frames;
    lines.push(
      `${thread.label}  ${fps.toFixed(0).padStart(3)} fps`
      + `  帧 p50=${milliseconds(report.frameMedian)}`
      + `  p95=${milliseconds(report.frameP95)}`
      + `  max=${milliseconds(report.frameMaximum)}`,
    );
    for (const phase of report.phases.slice(0, phaseLimit)) {
      lines.push(
        `   ${phase.phase.padEnd(16)} p50=${milliseconds(phase.median)}`
        + `  p95=${milliseconds(phase.p95)}`
        + `  max=${milliseconds(phase.maximum)}`
        + `  n=${String(phase.frames).padStart(3)}`,
      );
    }
  }
  return lines;
}

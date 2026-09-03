import { frameTimeline } from '../platform/index';
import {
  formatFrameProfiler,
  type ProfilerThreadSample,
} from './frameProfilerReport';
import { readRenderThreadReport } from './renderThreadTimings';

/**
 * 游戏内的帧耗时面板（开发运行时，F8 里开关）。
 *
 * 存在的理由很具体：帧循环搬进渲染线程之后，页面上再没有任何地方能看出一帧的时间
 * 花在哪儿了——stats-gl 的帧率面板拿不到已经转移走的画布上下文，主线程那份
 * `frameTimeline` 又只剩下发命令的几十微秒。卡顿的时候只能靠猜。
 *
 * 面板自己不做统计：数字来自两条线程各自的 `frameTimeline`，它一秒刷新几次，
 * 把最近一秒的分位数贴出来。
 */

/** DOM 刷新间隔。数字每秒跳四次已经足够读，再快只是让人眼花并且白烧主线程。 */
const REFRESH_INTERVAL_SECONDS = 0.25;

export class PerformanceOverlay {
  private readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private visibleState = false;
  /** 主线程 fps 自己数：那份 `frameTimeline` 的窗口是十秒，帧数不等于 fps。 */
  private frames = 0;
  private accumulatedSeconds = 0;
  private mainFps = 0;
  private sinceRefresh = 0;

  public constructor(root: HTMLElement, document: Document = globalThis.document) {
    this.element = document.createElement('section');
    this.element.className = 'frame-profiler';
    this.element.id = 'frame-profiler';
    this.element.hidden = true;
    // 面板只是读数，不该抢走画布的指针事件（CSS 里也写了 pointer-events: none）。
    this.element.setAttribute('aria-hidden', 'true');

    const heading = document.createElement('h2');
    heading.className = 'frame-profiler__title';
    heading.textContent = 'FRAME PROFILER';
    this.body = document.createElement('pre');
    this.body.className = 'frame-profiler__body';
    this.element.append(heading, this.body);
    root.append(this.element);
  }

  public get visible(): boolean {
    return this.visibleState;
  }

  public setVisible(visible: boolean): void {
    if (this.visibleState === visible) return;
    this.visibleState = visible;
    this.element.hidden = !visible;
    if (visible) {
      // 打开时立刻出数，不要等到下一次刷新窗口。
      this.sinceRefresh = REFRESH_INTERVAL_SECONDS;
      this.refresh();
    }
  }

  /**
   * 每帧调用。关着的时候只数帧——统计本身在两条线程的 `frameTimeline` 里，
   * 这里不做任何额外采样，所以关掉面板等于零开销。
   */
  public update(deltaSeconds: number): void {
    this.frames += 1;
    this.accumulatedSeconds += deltaSeconds;
    if (this.accumulatedSeconds >= 1) {
      this.mainFps = this.frames / this.accumulatedSeconds;
      this.frames = 0;
      this.accumulatedSeconds = 0;
    }
    if (!this.visibleState) return;
    this.sinceRefresh += deltaSeconds;
    if (this.sinceRefresh < REFRESH_INTERVAL_SECONDS) return;
    this.sinceRefresh = 0;
    this.refresh();
  }

  public dispose(): void {
    this.element.remove();
  }

  private refresh(): void {
    const renderThread = readRenderThreadReport();
    const threads: ProfilerThreadSample[] = [
      {
        label: '渲染线程',
        report: renderThread?.report,
        pacing: renderThread?.pacing,
        ageMilliseconds: renderThread?.ageMilliseconds,
        absentReason: '渲染循环没在独立线程上（或还没画出第一帧）',
      },
      {
        label: '主线程　',
        fps: this.mainFps,
        report: frameTimeline.report(),
      },
    ];
    this.body.textContent = formatFrameProfiler(threads).join('\n');
  }
}

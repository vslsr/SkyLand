/**
 * 渲染线程消费玩法帧的节拍器（引擎迁移路线图 第 3 步的补丁）。
 *
 * 两条循环都挂在同一个 vsync 上，但**谁先跑完**没有保证：主线程在这一拍里
 * 算完并翻面的时刻在 2–10ms 之间漂，渲染线程开始读那段字节的时刻也在漂。两个
 * 时刻一交叉，就会出现「这一拍读到的还是上一帧」紧跟着「下一拍跨过了两帧」——
 * 两条线程都满帧，画面却一顿一顿。录像里逐帧量出来的正是这个：每 33ms 推进的
 * 世界位移在 0、1、2、3、4 步之间乱跳，平均正好是 2 步。
 *
 * 解法不是插值，也不是让两条循环互相等：渲染线程在自己的 rAF 里**等主线程这一拍
 * 翻面**（`Atomics.wait` 在共享表头的帧号上），等到就画这一帧，等不到（主线程真的
 * 卡了）就画上一帧。主线程每拍翻一次面，渲染线程每拍画一次——一对一。
 *
 * 等多久有上限：这一拍剩下的时间要够画完，否则等到了也来不及。上限按最近的
 * rAF 间隔和上一帧自己的耗时算，144Hz 的屏幕上会自动收紧。
 *
 * 这个类只做决定与记账，不碰 `Atomics`：等待本身由调用方注入，因此能在 Node 里
 * 单测，也能在 `?renderpace=free` 下整个关掉（退回「读最新一面」的老行为）。
 */

import type { FrameWaitResult } from '../RenderTransformBuffer';

export type { FrameWaitResult };

export interface FrameWaitSource {
  /** 当前已发布的帧号。 */
  readonly frameId: number;
  /**
   * 帧号仍等于 `frameId` 时阻塞，最多 `timeoutMs` 毫秒。
   * 主线程翻面时 `notify`，这里立刻醒来。
   */
  waitForFrame(frameId: number, timeoutMs: number): FrameWaitResult;
}

export interface FramePacerOptions {
  /** 一拍里留给「画」以外的安全余量（毫秒）。 */
  readonly marginMs?: number;
  /** 等待上限不超过 rAF 间隔的这个比例——主线程太慢时不要把整拍都等掉。 */
  readonly maximumWaitFraction?: number;
  /** 还没量到 rAF 间隔之前按这个值算（60Hz）。 */
  readonly initialIntervalMs?: number;
  /** 关掉等待：只记账，行为退回「读最新一面」。 */
  readonly waitEnabled?: boolean;
}

export interface FrameAcquisition {
  /** 这一帧要画的玩法帧号。 */
  readonly frameId: number;
  /** 比上一次画的推进了几帧：0 重复，1 正好，>1 跳过。 */
  readonly advanced: number;
  /** 这一拍等了多久（毫秒）。没等为 0。 */
  readonly waitedMs: number;
  /** 等待结果。没等时是 'not-equal'（帧早就到了）。 */
  readonly wait: FrameWaitResult;
}

export interface FramePacerReport {
  readonly frames: number;
  readonly duplicated: number;
  readonly skipped: number;
  /** 等待时长的中位数与最大值（毫秒），只统计真的等过的帧。 */
  readonly waitMedianMs: number;
  readonly waitMaximumMs: number;
  /** 等到上限还没等到主线程翻面的帧数。 */
  readonly waitTimeouts: number;
}

const DEFAULT_MARGIN_MS = 1;
const DEFAULT_MAXIMUM_WAIT_FRACTION = 0.75;
const DEFAULT_INTERVAL_MS = 1000 / 60;
/** rAF 间隔取最近这么多拍的中位数，一次长帧不会把上限拉长。 */
const INTERVAL_SAMPLES = 8;

export class RenderFramePacer {
  private readonly marginMs: number;
  private readonly maximumWaitFraction: number;
  private readonly waitEnabled: boolean;
  private readonly intervals: number[] = [];
  private intervalMs: number;
  private lastFrameAt?: number;
  private lastFrameCostMs = 0;
  private lastConsumed = -1;
  private frames = 0;
  private duplicated = 0;
  private skipped = 0;
  private waitTimeouts = 0;
  private readonly waits: number[] = [];

  public constructor(options: FramePacerOptions = {}) {
    this.marginMs = Math.max(0, options.marginMs ?? DEFAULT_MARGIN_MS);
    this.maximumWaitFraction = Math.min(1, Math.max(0, options.maximumWaitFraction ?? DEFAULT_MAXIMUM_WAIT_FRACTION));
    this.intervalMs = Math.max(1, options.initialIntervalMs ?? DEFAULT_INTERVAL_MS);
    this.waitEnabled = options.waitEnabled ?? true;
  }

  /** 最近量到的 rAF 间隔（毫秒）。 */
  public get rafIntervalMs(): number {
    return this.intervalMs;
  }

  /** 上一次画的玩法帧号；还没画过是 -1。 */
  public get lastConsumedFrameId(): number {
    return this.lastConsumed;
  }

  /**
   * 一拍开始：记下时刻，更新 rAF 间隔的估计。
   * `now` 是 rAF 给的时间戳，它对齐 vsync，所以相邻两拍之差就是屏幕的刷新间隔。
   */
  public beginFrame(now: number): void {
    if (this.lastFrameAt !== undefined) {
      const delta = now - this.lastFrameAt;
      // 切标签页回来那一拍会隔很久；超过 100ms 的间隔不算刷新率。
      if (delta > 0 && delta < 100) {
        this.intervals.push(delta);
        if (this.intervals.length > INTERVAL_SAMPLES) this.intervals.shift();
        const sorted = [...this.intervals].sort((left, right) => left - right);
        this.intervalMs = sorted[Math.floor(sorted.length / 2)];
      }
    }
    this.lastFrameAt = now;
  }

  /** 这一拍自己画了多久。下一拍的等待上限要给它留位置。 */
  public endFrame(frameCostMs: number): void {
    this.lastFrameCostMs = Math.max(0, frameCostMs);
  }

  /**
   * 这一拍最多等主线程多久。
   *
   * 间隔减去上一帧的绘制耗时再减余量：等到之后还得画得完。另外封在间隔的一个
   * 比例之内——主线程慢到每拍都要等大半拍时，剩下的那点时间本来也画不完，
   * 与其拖着不如早画早交。
   */
  public waitBudgetMs(): number {
    if (!this.waitEnabled) return 0;
    const remaining = this.intervalMs - this.lastFrameCostMs - this.marginMs;
    return Math.max(0, Math.min(remaining, this.intervalMs * this.maximumWaitFraction));
  }

  /**
   * 取这一拍要画的帧。
   *
   * 已经有比上次更新的帧就直接用；没有就按预算等主线程翻面。记账按**画出来的**
   * 帧号算，不按读到的帧号算——面板上原来那个「帧配对一对一」量的是读到的帧号，
   * 而画面用的是消息到达时兑现的位置，两者能差一帧，所以它看不见真正的重复与跳过。
   */
  public acquire(source: FrameWaitSource, clock: { now(): number }): FrameAcquisition {
    const before = source.frameId;
    let wait: FrameWaitResult = 'not-equal';
    let waitedMs = 0;
    if (before <= this.lastConsumed) {
      const budget = this.waitBudgetMs();
      if (budget > 0) {
        const startedAt = clock.now();
        wait = source.waitForFrame(before, budget);
        waitedMs = Math.max(0, clock.now() - startedAt);
        this.waits.push(waitedMs);
        if (wait === 'timed-out') this.waitTimeouts += 1;
      }
    }
    const frameId = source.frameId;
    const advanced = this.lastConsumed < 0 ? 1 : frameId - this.lastConsumed;
    this.frames += 1;
    if (this.lastConsumed >= 0) {
      if (advanced <= 0) this.duplicated += 1;
      else if (advanced > 1) this.skipped += 1;
    }
    this.lastConsumed = frameId;
    return { frameId, advanced, waitedMs, wait };
  }

  /** 这一秒的账；报完清零。 */
  public report(): FramePacerReport {
    const sorted = [...this.waits].sort((left, right) => left - right);
    const report: FramePacerReport = {
      frames: this.frames,
      duplicated: this.duplicated,
      skipped: this.skipped,
      waitMedianMs: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
      waitMaximumMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      waitTimeouts: this.waitTimeouts,
    };
    this.frames = 0;
    this.duplicated = 0;
    this.skipped = 0;
    this.waitTimeouts = 0;
    this.waits.length = 0;
    return report;
  }
}

/**
 * PlatformLayer · 帧时间打点（引擎迁移路线图 第 2 步）。
 *
 * 第 2 步的价值是**证据**：在写第一行 worker 代码之前，先知道主线程的时间到底
 * 花在哪儿。路线图对瓶颈的猜测是「chunk 生成／合批 + 软体求解」，但那是猜的——
 * 这个文件的存在就是为了不靠猜。
 *
 * 它属于 PlatformLayer 而不是某个场景：Sim Worker 里也要打同一套点，两边的报表
 * 才能放在一起看。所以这里不碰 DOM，也不碰 `performance` 以外的宿主 API。
 *
 * **记的是自耗时（self time）。** 阶段可以嵌套：子阶段的耗时从父阶段里扣掉，
 * 所以「各阶段之和」始终有意义——剩下的那部分就是还没打点的地方。
 * 不这样做的话，`createReplica` 里那次建模型会同时算进 `sim-actors` 和
 * `render-spawn`，让「搬进 worker 能省多少」凭空翻倍。
 */

/** 取时钟。`performance` 在浏览器与 Node 里都有；测试可以喂一个假的。 */
export interface FrameClock {
  now(): number;
}

export interface PhaseTiming {
  readonly phase: string;
  /** 窗口内的中位数、95 分位与最大值，单位毫秒；**自耗时**，不含子阶段。 */
  readonly median: number;
  readonly p95: number;
  readonly maximum: number;
  /** 这个阶段在窗口内出现过的帧数——不是每帧都有 chunk 要建。 */
  readonly frames: number;
}

export interface FrameTimingReport {
  /** 窗口里实际统计到的帧数。 */
  readonly frames: number;
  readonly frameMedian: number;
  readonly frameP95: number;
  readonly frameMaximum: number;
  /** 按 p95 从大到小排。 */
  readonly phases: readonly PhaseTiming[];
}

const DEFAULT_CAPACITY = 240;

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/**
 * 一帧的分阶段耗时。
 *
 * 用法是 `measure(phase, body)`：把打点和被测代码绑在一起，异常路径上也不会
 * 漏掉 `end()`——漏一次就会让那一帧的这个阶段永远挂着。
 */
export class FrameTimeline {
  /** phase → 最近 capacity 帧的耗时环。缺席的帧不占位置（见 PhaseTiming.frames）。 */
  readonly #phases = new Map<string, number[]>();
  /** 当前这一帧各阶段的自耗时累计。同一阶段一帧内被 measure 多次就累加。 */
  readonly #current = new Map<string, number>();
  /** 正在计时的嵌套栈；`childMilliseconds` 是要从自耗时里扣掉的那部分。 */
  readonly #stack: { startedAt: number; childMilliseconds: number }[] = [];
  readonly #frames: number[] = [];
  #frameStart: number | undefined;
  #enabled = true;

  public constructor(
    private readonly clock: FrameClock = globalThis.performance ?? Date,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {}

  public get enabled(): boolean {
    return this.#enabled;
  }

  public setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.reset();
  }

  /** 一帧的开始。没调用它也能用——那样只有各阶段，没有整帧的数。 */
  public beginFrame(): void {
    if (!this.#enabled) return;
    this.#frameStart = this.clock.now();
  }

  /** 一帧的结束：把这一帧攒下的各阶段推进环里。 */
  public endFrame(): void {
    if (!this.#enabled) return;
    if (this.#frameStart !== undefined) {
      this.#push(this.#frames, this.clock.now() - this.#frameStart);
      this.#frameStart = undefined;
    }
    for (const [phase, milliseconds] of this.#current) {
      let ring = this.#phases.get(phase);
      if (!ring) {
        ring = [];
        this.#phases.set(phase, ring);
      }
      this.#push(ring, milliseconds);
    }
    this.#current.clear();
    // 正常路径下 try/finally 会把栈清空；这一句兜住「异常穿过了 endFrame」的路径，
    // 免得一次意外让后面每一帧的自耗时都被扣错。
    this.#stack.length = 0;
  }

  public measure<T>(phase: string, body: () => T): T {
    if (!this.#enabled) return body();
    const entry = { startedAt: this.clock.now(), childMilliseconds: 0 };
    this.#stack.push(entry);
    try {
      return body();
    } finally {
      const elapsed = this.clock.now() - entry.startedAt;
      this.#stack.pop();
      // 父阶段扣掉子阶段的**整段**耗时，不是它的自耗时——父的墙钟时间里
      // 包含子的整棵子树。
      const parent = this.#stack.at(-1);
      if (parent) parent.childMilliseconds += elapsed;
      const self = elapsed - entry.childMilliseconds;
      this.#current.set(phase, (this.#current.get(phase) ?? 0) + self);
    }
  }

  public reset(): void {
    this.#phases.clear();
    this.#current.clear();
    this.#frames.length = 0;
    this.#stack.length = 0;
    this.#frameStart = undefined;
  }

  public report(): FrameTimingReport {
    const frames = [...this.#frames].sort((left, right) => left - right);
    const phases: PhaseTiming[] = [];
    for (const [phase, ring] of this.#phases) {
      const sorted = [...ring].sort((left, right) => left - right);
      phases.push({
        phase,
        median: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        maximum: sorted.at(-1) ?? 0,
        frames: sorted.length,
      });
    }
    phases.sort((left, right) => right.p95 - left.p95);
    return {
      frames: frames.length,
      frameMedian: quantile(frames, 0.5),
      frameP95: quantile(frames, 0.95),
      frameMaximum: frames.at(-1) ?? 0,
      phases,
    };
  }

  #push(ring: number[], value: number): void {
    ring.push(value);
    if (ring.length > this.capacity) ring.shift();
  }
}

/** 一行一个阶段的纯文本报表，给控制台和调试面板共用。 */
export function formatFrameTimingReport(report: FrameTimingReport): string {
  const milliseconds = (value: number): string => value.toFixed(2).padStart(6);
  const lines = [
    `frame  n=${report.frames}  p50=${milliseconds(report.frameMedian)}ms`
      + `  p95=${milliseconds(report.frameP95)}ms  max=${milliseconds(report.frameMaximum)}ms`,
  ];
  for (const phase of report.phases) {
    lines.push(
      `  ${phase.phase.padEnd(16)} p50=${milliseconds(phase.median)}ms`
        + `  p95=${milliseconds(phase.p95)}ms  max=${milliseconds(phase.maximum)}ms`
        + `  n=${phase.frames}`,
    );
  }
  return lines.join('\n');
}

/**
 * 进程内唯一的那一份。打点散落在场景、流送、渲染各处，让它们各自拿一个实例
 * 反而要多穿一层参数；Sim Worker 里会有它自己的那一份，报表按线程分开看。
 */
export const frameTimeline = new FrameTimeline();

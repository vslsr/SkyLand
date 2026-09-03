/**
 * 渲染线程上的 GPU 帧耗时（`EXT_disjoint_timer_query_webgl2`）。
 *
 * `performance.now()` 只能量到命令提交为止，量不到显卡真正画完。渲染线程 CPU 侧
 * 一帧 6ms、显卡却要 15ms 的时候，两条线程都是满帧、面板上什么都看不出来，画面
 * 却在每一次显卡没赶上 vsync 的地方顿一下。画布交给渲染线程之后 `stats-gl` 那块
 * 面板装不上了（主线程拿不到上下文），所以这一段在渲染线程上自己读，随帧报表
 * 发回去。
 *
 * 一次只能有一个 `TIME_ELAPSED_EXT` 查询在飞，所以每帧开一个、结束、排队；结果
 * 几帧之后才可读，`poll()` 每帧收一次已经好了的。`GPU_DISJOINT_EXT` 期间（显卡
 * 切频、别的进程抢占）那一批结果作废，照规范丢掉。
 *
 * `gl` 与扩展都按最小接口注入，Node 里用假对象就能测。
 */

export interface GpuTimerGl {
  getExtension(name: string): GpuTimerExtension | null;
  createQuery(): GpuTimerQuery | null;
  deleteQuery(query: GpuTimerQuery): void;
  beginQuery(target: number, query: GpuTimerQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: GpuTimerQuery, pname: number): number | boolean;
  getParameter(pname: number): unknown;
  readonly QUERY_RESULT: number;
  readonly QUERY_RESULT_AVAILABLE: number;
}

export interface GpuTimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GpuTimerQuery {}

export interface GpuFrameReport {
  /** 这一秒收到结果的帧数。0 表示扩展不可用或还没有结果。 */
  readonly gpuFrames: number;
  readonly gpuMedianMs: number;
  readonly gpuMaximumMs: number;
}

/** 在飞的查询最多留这么多；显卡卡死时不会无限堆。 */
const MAXIMUM_PENDING = 8;

export class GpuFrameTimer {
  readonly #gl?: GpuTimerGl;
  readonly #extension?: GpuTimerExtension;
  readonly #pending: GpuTimerQuery[] = [];
  #active?: GpuTimerQuery;
  #samples: number[] = [];

  public constructor(gl: GpuTimerGl | undefined) {
    const extension = gl?.getExtension('EXT_disjoint_timer_query_webgl2') ?? undefined;
    if (!gl || !extension) return;
    this.#gl = gl;
    this.#extension = extension;
  }

  /** 扩展在不在。不在时 `begin`/`end`/`poll` 都是空操作，报表里 `gpuFrames` 恒为 0。 */
  public get available(): boolean {
    return this.#extension !== undefined;
  }

  /** 帧首：开一个查询。在飞的太多就这一帧不量（显卡落后太多时结果本来也没意义）。 */
  public begin(): void {
    const gl = this.#gl;
    const extension = this.#extension;
    if (!gl || !extension || this.#active || this.#pending.length >= MAXIMUM_PENDING) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    this.#active = query;
  }

  /** 帧尾：结束查询、排队等结果。 */
  public end(): void {
    const gl = this.#gl;
    const extension = this.#extension;
    if (!gl || !extension || !this.#active) return;
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    this.#pending.push(this.#active);
    this.#active = undefined;
  }

  /** 收已经好了的结果。按提交顺序收，前面的没好后面的不看。 */
  public poll(): void {
    const gl = this.#gl;
    const extension = this.#extension;
    if (!gl || !extension) return;
    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) === true;
    while (this.#pending.length > 0) {
      const query = this.#pending[0];
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) break;
      this.#pending.shift();
      const nanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
      gl.deleteQuery(query);
      // 不连续期间的结果不可信，规范要求丢掉。
      if (!disjoint && Number.isFinite(nanoseconds)) this.#samples.push(nanoseconds / 1e6);
    }
  }

  /** 这一秒的账；报完清零。 */
  public report(): GpuFrameReport {
    const sorted = [...this.#samples].sort((left, right) => left - right);
    this.#samples = [];
    return {
      gpuFrames: sorted.length,
      gpuMedianMs: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
      gpuMaximumMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    };
  }

  public dispose(): void {
    const gl = this.#gl;
    if (!gl) return;
    for (const query of this.#pending) gl.deleteQuery(query);
    this.#pending.length = 0;
    if (this.#active) {
      gl.endQuery(this.#extension!.TIME_ELAPSED_EXT);
      gl.deleteQuery(this.#active);
      this.#active = undefined;
    }
  }
}

import type {
  HealthDisplayState,
  HealthSource,
  HealthView,
} from './HealthDisplay';

/** 显示上的几条口径。都是「几种样式必须一致」的东西，所以只有这一份。 */
export interface HealthDisplayOptions {
  /** 低于这个比例算警戒。默认三成。 */
  readonly criticalRatio?: number;
  /** 掉血之后残影先停多久再开始退。默认 0.45 秒：够看清少了多少，又不拖沓。 */
  readonly trailingDelaySeconds?: number;
  /** 残影每秒退多少（按满条的比例算）。默认 0.55，即最长约 1.8 秒退完一整条。 */
  readonly trailingSpeed?: number;
  /** 一次结算保留多久还算「刚刚发生」。默认 1.2 秒，超过就不再往下发。 */
  readonly changeMemorySeconds?: number;
}

const DEFAULTS = {
  criticalRatio: 0.3,
  trailingDelaySeconds: 0.45,
  trailingSpeed: 0.55,
  changeMemorySeconds: 1.2,
} as const;

/**
 * 把一个 `HealthSource` 每帧翻译成一份显示状态，再发给挂在上面的所有视图。
 *
 * 它是这条链上唯一做判断的一环：警戒线、残影退到哪、一次结算算「刚刚」到什么时候，
 * 全在这里定。**视图一条都不重复判断**——同一个结论算两遍，两种样式迟早会在某一帧
 * 说出两句话（一条已经变红、另一条还差一点）。
 *
 * 它不认识 DOM，也不认识 `HealthComponent`；两头都只经过 `HealthDisplay.ts` 里的接口。
 *
 * 成本与世界大小无关：每帧只问一次来源、造一个状态对象、遍历一遍视图表，而视图表
 * 的长度是「屏幕上有几种血条画法」——不是「世界里有几个带血的东西」。
 */
export class HealthDisplayController {
  private readonly views: HealthView[] = [];
  private readonly criticalRatio: number;
  private readonly trailingDelaySeconds: number;
  private readonly trailingSpeed: number;
  private readonly changeMemorySeconds: number;

  /** 上一帧交出去过状态没有。没有的话这一帧就是「第一次看见」。 */
  private observed = false;
  private trailingRatio = 0;
  private previousRatio = 0;
  /** 残影还要停多久才开始退。每次掉血重新计，连着挨打就一直停在最高的那条线上。 */
  private trailingHoldSeconds = 0;
  /** 上一次见到的结算计数。`undefined` = 还没见过这条命。 */
  private eventRevision?: number;
  private changeAmount = 0;
  private changeAgeSeconds = 0;
  private hasChange = false;

  public constructor(
    private readonly source: HealthSource,
    options: HealthDisplayOptions = {},
  ) {
    this.criticalRatio = clamp01(options.criticalRatio ?? DEFAULTS.criticalRatio);
    this.trailingDelaySeconds = Math.max(0, options.trailingDelaySeconds ?? DEFAULTS.trailingDelaySeconds);
    this.trailingSpeed = Math.max(0, options.trailingSpeed ?? DEFAULTS.trailingSpeed);
    this.changeMemorySeconds = Math.max(0, options.changeMemorySeconds ?? DEFAULTS.changeMemorySeconds);
  }

  /**
   * 挂一种画法上来。返回摘下它的函数。
   *
   * 想同时显示几种样式就挂几个：它们收到同一份状态。挂上来的这一帧还没有状态可发，
   * 视图会在下一次 `update` 收到第一份——血条每帧都在重画，不值得为这一帧补一次。
   */
  public addView(view: HealthView): () => void {
    this.views.push(view);
    return () => {
      const index = this.views.indexOf(view);
      if (index >= 0) this.views.splice(index, 1);
    };
  }

  /** 每帧一次。 */
  public update(deltaSeconds: number): void {
    const reading = this.source.readHealth();
    if (!reading) {
      // 没有可显示的对象。已经交出过状态的话要收一次尾：视图得知道该收起来了，
      // 内部的残影与事件也不能留到下一个角色身上。
      if (this.observed) this.reset();
      return;
    }

    const step = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    // 两个数都在这里夹一次，视图那边就不必各自防 NaN、负数与超出上限——同一份
    // 防御写在几种样式里，迟早有一种漏掉，屏幕上就出现「NaN / 100」。
    const maximum = reading.maximum > 0 ? reading.maximum : 0;
    const current = Number.isFinite(reading.current)
      ? Math.max(0, Math.min(maximum, reading.current))
      : 0;
    const ratio = maximum > 0 ? clamp01(current / maximum) : 0;

    // 先把上一条结算老化一帧，再看这一帧有没有新的：顺序反过来的话，刚发生的
    // 那一次会带着一帧的年龄发出去，闪光从一开始就缺了一截。
    this.advanceChange(step);

    if (!this.observed) {
      // 第一次看见这条命：残影直接贴上，别从满条退一遍——中途进房间、或者刚
      // 接管一个已经挨过打的角色，都不该把它过去掉的血当场补演一次。
      this.observed = true;
      this.trailingRatio = ratio;
      this.previousRatio = ratio;
      this.eventRevision = reading.eventRevision;
    } else if (reading.eventRevision !== this.eventRevision) {
      // 计数变了才是「刚刚结算过一次」。同一条规矩下，`lastDelta` 为 0 的那次
      // （例如满血再治疗）不值得闪，直接不记。
      this.eventRevision = reading.eventRevision;
      if (reading.lastDelta) {
        this.changeAmount = reading.lastDelta;
        this.changeAgeSeconds = 0;
        this.hasChange = true;
      }
    }

    this.advanceTrailing(ratio, step);

    this.publish({
      current,
      maximum,
      ratio,
      trailingRatio: this.trailingRatio,
      dead: reading.dead === true,
      // 死了之后没有「快没血了」这回事：那时要说的是已经倒下，不是还剩一点。
      critical: reading.dead !== true && ratio <= this.criticalRatio,
      lastChange: this.hasChange
        ? { amount: this.changeAmount, ageSeconds: this.changeAgeSeconds }
        : undefined,
    });
  }

  /**
   * 忘掉这条命：换角色、重生、离开房间时调用。
   *
   * 会顺手让视图收起来。不清的话，下一个角色的第一帧会从上一个的残影和上一次
   * 挨打的闪光开始——两条命之间没有任何关系，却看起来像是接着掉。
   */
  public reset(): void {
    this.observed = false;
    this.trailingRatio = 0;
    this.previousRatio = 0;
    this.trailingHoldSeconds = 0;
    this.eventRevision = undefined;
    this.changeAmount = 0;
    this.changeAgeSeconds = 0;
    this.hasChange = false;
    this.publish(undefined);
  }

  /** 摘掉所有视图。视图本身归创建它的那一方释放，这里不代劳。 */
  public dispose(): void {
    this.views.length = 0;
  }

  /**
   * 推进残影。
   *
   * 压住计时器看的是「比上一帧低」，不看结算计数：一次掉血会被 10Hz 的快照分几帧
   * 送到，每一帧都该把残影重新按住，否则后半段还没到，前半段的残影已经开始退了。
   */
  private advanceTrailing(ratio: number, deltaSeconds: number): void {
    const healed = ratio > this.previousRatio;
    if (ratio < this.previousRatio) this.trailingHoldSeconds = this.trailingDelaySeconds;
    this.previousRatio = ratio;

    if (healed || ratio >= this.trailingRatio) {
      // 残影只讲损失。一治疗它就没有可讲的了，立刻贴合——留在原处的话，血已经回来
      // 的那一截上还挂着一条红影子，看起来像是又掉了一次。
      this.trailingRatio = ratio;
      this.trailingHoldSeconds = 0;
      return;
    }
    // 停顿与退让分账，不让「这一帧在停顿里」把整帧都吃掉：一帧 0.2 秒而只剩
    // 0.05 秒停顿时，剩下的 0.15 秒该退就退。掉帧时残影因此不会一次卡住半秒。
    let remaining = deltaSeconds;
    if (this.trailingHoldSeconds > 0) {
      const held = Math.min(this.trailingHoldSeconds, remaining);
      this.trailingHoldSeconds -= held;
      remaining -= held;
      if (remaining <= 0) return;
    }
    this.trailingRatio = Math.max(ratio, this.trailingRatio - this.trailingSpeed * remaining);
  }

  private advanceChange(deltaSeconds: number): void {
    if (!this.hasChange) return;
    this.changeAgeSeconds += deltaSeconds;
    if (this.changeAgeSeconds < this.changeMemorySeconds) return;
    this.hasChange = false;
    this.changeAmount = 0;
    this.changeAgeSeconds = 0;
  }

  private publish(state: HealthDisplayState | undefined): void {
    for (const view of this.views) view.render(state);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

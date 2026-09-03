export interface InteractionPromptFadeOptions {
  /** 停手之后要安静多久，提示才开始淡回来。 */
  readonly idleDelaySeconds?: number;
  readonly fadeInSeconds?: number;
  readonly fadeOutSeconds?: number;
}

/**
 * 安静期比淡入还短：提示要跟得上「刚停下」这个动作，又不能让连按之间的空档
 * 把它勾出来。淡出比淡入快一倍——玩家一动就该让开画面，回来时则慢慢来。
 */
export const INTERACTION_PROMPT_FADE_DEFAULTS = {
  idleDelaySeconds: 0.4,
  fadeInSeconds: 0.28,
  fadeOutSeconds: 0.14,
} as const;

/**
 * 交互提示的「停手才现身」淡入淡出。
 *
 * 玩家只要还在操作，提示就一路退到透明；操作停下、并且安静过一段延迟之后，提示
 * 才淡回来。延迟不是手感调料而是必需：连续按键之间总有几十毫秒的空档，没有它
 * 提示会在跑动中一闪一闪。
 *
 * 延迟窗口里保持当前不透明度而不是继续淡出：轻点一下不该让整条提示消失再重来。
 *
 * 这里只算一个不透明度，不知道提示画在哪。HUD 那条文字和世界里的按键牌因此读的
 * 是同一个值，两处的淡入淡出永远同步。
 */
export class InteractionPromptFade {
  private readonly idleDelaySeconds: number;
  private readonly fadeInRate: number;
  private readonly fadeOutRate: number;
  private idleSeconds = 0;
  private currentOpacity = 0;

  public constructor(options: InteractionPromptFadeOptions = {}) {
    this.idleDelaySeconds = Math.max(
      0,
      options.idleDelaySeconds ?? INTERACTION_PROMPT_FADE_DEFAULTS.idleDelaySeconds,
    );
    this.fadeInRate = toRatePerSecond(
      options.fadeInSeconds ?? INTERACTION_PROMPT_FADE_DEFAULTS.fadeInSeconds,
    );
    this.fadeOutRate = toRatePerSecond(
      options.fadeOutSeconds ?? INTERACTION_PROMPT_FADE_DEFAULTS.fadeOutSeconds,
    );
  }

  public get opacity(): number {
    return this.currentOpacity;
  }

  /**
   * 推进一帧并返回这一帧的不透明度。
   * `active` 表示玩家正在操作；界面操作不算，调用方负责把它排除在外。
   */
  public update(deltaSeconds: number, active: boolean): number {
    const step = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    if (active) {
      this.idleSeconds = 0;
      if (step > 0) {
        this.currentOpacity = Math.max(0, this.currentOpacity - step * this.fadeOutRate);
      }
      return this.currentOpacity;
    }
    this.idleSeconds += step;
    if (step > 0 && this.idleSeconds >= this.idleDelaySeconds) {
      this.currentOpacity = Math.min(1, this.currentOpacity + step * this.fadeInRate);
    }
    return this.currentOpacity;
  }

  /** 回到「刚进场景」的状态：完全透明，并重新开始等待安静期。 */
  public reset(): void {
    this.idleSeconds = 0;
    this.currentOpacity = 0;
  }
}

/** 淡入淡出时长配成 0 表示「立刻」，用无穷速率表示；步长为 0 的帧不会走到这里。 */
function toRatePerSecond(durationSeconds: number): number {
  return durationSeconds > 0 ? 1 / durationSeconds : Number.POSITIVE_INFINITY;
}

/**
 * 倒下那一段的曲线，渲染侧独有（设计稿 `doc/designer-toolandweapon.md`「生命值系统」）。
 *
 * 过边界的只有一个自增的死亡计数（`PARAM_HEALTH_DEATH_REVISION`）。这一段从
 * 「计数变了」到「摊平到百分之几」的积分全在这里，和吃东西那段
 * （`src/player/chewAnimation.ts`）同一个取向：**玩法侧给一个量，表现自己走完**。
 *
 * 两种史莱姆读同一个计时器、各自不同的时长与形变，所以曲线放在一处、
 * 形变留在各自的 Visual 里——两边各写一套计时的话，一具尸体的身体和腿迟早
 * 会停在不同的进度上。
 *
 * 这个文件不 import three：它只有数。
 */

/** 软体史莱姆摊成一滩用多久，秒。 */
export const PBF_DEATH_COLLAPSE_SECONDS = 0.9;

/** 骨骼腿史莱姆倒下用多久，秒。 */
export const LEGGED_DEATH_COLLAPSE_SECONDS = 0.6;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 摊开用的 easeOut：一开始塌得快，最后 0.2 秒几乎不动。 */
export function deathCollapseEaseOut(progress: number): number {
  const ratio = clamp01(progress);
  return 1 - (1 - ratio) * (1 - ratio) * (1 - ratio);
}

/**
 * 倒下用的自由落体：髋部按 g 加速掉下去，所以是二次的而不是 easeOut。
 * 触地那一刻正好是 1。
 */
export function deathFreeFall(progress: number): number {
  const ratio = clamp01(progress);
  return ratio * ratio;
}

/**
 * 触地那一下的压扁量 [0, 1]：落地瞬间跳到 1，再在 `settleRatio` 这段里
 * 松回一部分——它是趴下了，不是弹回来，所以松回之后不再恢复。
 */
export function deathImpactSquash(progress: number, settleRatio = 0.25): number {
  const ratio = clamp01(progress);
  if (ratio < 1 - settleRatio) return 0;
  const settle = clamp01((ratio - (1 - settleRatio)) / Math.max(1e-6, settleRatio));
  return 1 - settle * 0.45;
}

/**
 * 一次性死亡动画的计时器。
 *
 * **第一次看到一个非零计数就直接跳到结尾**：走进视野时早就死透的那一具是尸体，
 * 不该当着玩家的面重演一遍倒下——AOI 进出会让这件事每次都发生。只有「先看着它
 * 活着（计数 0），再看到计数变了」才是真的死在眼前。
 */
export class DeathCollapseTimer {
  private seenRevision?: number;
  private elapsedSeconds = 0;
  private collapsing = false;
  private finished = false;

  /** 返回这一帧的进度 [0, 1]；0 表示还活着。 */
  public update(revision: number, deltaSeconds: number, durationSeconds: number): number {
    const safeRevision = Number.isFinite(revision) ? Math.max(0, Math.round(revision)) : 0;
    if (this.seenRevision === undefined) {
      this.seenRevision = safeRevision;
      // 出生就是一具尸体：直接摆成塌完的样子。
      this.finished = safeRevision > 0;
      this.collapsing = false;
      return this.finished ? 1 : 0;
    }
    if (safeRevision !== this.seenRevision) {
      this.seenRevision = safeRevision;
      if (safeRevision > 0) {
        this.collapsing = true;
        this.finished = false;
        this.elapsedSeconds = 0;
      } else {
        // 计数归零只发生在槽位被回收给另一个 proxy 时；那一份表现要从头开始。
        this.collapsing = false;
        this.finished = false;
        this.elapsedSeconds = 0;
        return 0;
      }
    }
    if (this.finished) return 1;
    if (!this.collapsing) return 0;
    const frameSeconds = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.1));
    this.elapsedSeconds += frameSeconds;
    const duration = Math.max(1e-3, durationSeconds);
    if (this.elapsedSeconds >= duration) {
      this.finished = true;
      this.collapsing = false;
      return 1;
    }
    return this.elapsedSeconds / duration;
  }

  /** 这一具已经死了（正在塌或者塌完了）。 */
  public get dead(): boolean {
    return this.collapsing || this.finished;
  }
}

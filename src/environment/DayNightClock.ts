import {
  advanceTimeOfDay,
  normalizeTimeOfDay,
  shortestTimeOfDayDelta,
} from '../../shared/dayNight.mjs';

/** 与权威时间差得比这更多时直接跳过去：重连、切场景或调试跳时段。 */
const SNAP_THRESHOLD_HOURS = 0.75;

/** 小偏差每次快照追回的比例；本地推进速率和服务端一致，所以偏差只会很小。 */
const CORRECTION_RATIO = 0.25;

/**
 * 房间权威昼夜时钟在客户端的镜像。
 *
 * 快照只带「现在几点」和「一天走多少真实秒」两个数，两帧之间由这里用同一份
 * 共享数学继续推进，所以时间是连续的；每次收到快照再把偏差追回去，避免
 * 长时间运行后本地时钟漂移。
 */
export class DayNightClock {
  private currentTimeOfDay: number;
  private dayLengthSeconds: number;

  public constructor(startHour: number, dayLengthSeconds: number) {
    this.currentTimeOfDay = normalizeTimeOfDay(startHour);
    this.dayLengthSeconds = Math.max(0, dayLengthSeconds);
  }

  public get timeOfDay(): number {
    return this.currentTimeOfDay;
  }

  /** 时钟是否真的在走；冻结或关闭昼夜的房间返回 false。 */
  public get running(): boolean {
    return this.dayLengthSeconds > 0;
  }

  /** 用房间快照校正本地时钟。 */
  public applyServerTime(timeOfDay: number, dayLengthSeconds: number): void {
    if (Number.isFinite(dayLengthSeconds)) {
      this.dayLengthSeconds = Math.max(0, dayLengthSeconds);
    }
    if (!Number.isFinite(timeOfDay)) return;
    const delta = shortestTimeOfDayDelta(this.currentTimeOfDay, timeOfDay);
    if (!this.running || Math.abs(delta) > SNAP_THRESHOLD_HOURS) {
      this.currentTimeOfDay = normalizeTimeOfDay(timeOfDay);
      return;
    }
    this.currentTimeOfDay = normalizeTimeOfDay(
      this.currentTimeOfDay + delta * CORRECTION_RATIO,
    );
  }

  public advance(deltaSeconds: number): void {
    if (!this.running) return;
    this.currentTimeOfDay = advanceTimeOfDay(
      this.currentTimeOfDay,
      this.dayLengthSeconds,
      deltaSeconds,
    );
  }
}

import type { AdminLogLevel } from './adminApi';

function padded(value: number): string {
  return String(Math.floor(value)).padStart(2, '0');
}

/** 运行时长：不足一天写「HH:MM:SS」，超过一天前面加「N 天」。 */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const clock = `${padded((total % 86400) / 3600)}:${padded((total % 3600) / 60)}:${padded(total % 60)}`;
  return days > 0 ? `${days} 天 ${clock}` : clock;
}

/** ISO 时间戳 → 本地「MM-DD HH:MM:SS」。解析不了就把原文照抄出来，不吞掉异常数据。 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${padded(date.getMonth() + 1)}-${padded(date.getDate())} `
    + `${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}`;
}

/** 日志行左侧的时钟（同一秒内的多条日志靠顺序区分，不显示毫秒）。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return `${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}`;
}

/** 空房回收倒计时。已经过期显示「回收中」，避免出现负数秒。 */
export function formatCountdown(expiresAt: string | null | undefined, now = Date.now()): string {
  if (!expiresAt) return '有人在线';
  const remaining = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(remaining)) return '—';
  if (remaining <= 0) return '回收中';
  const seconds = Math.ceil(remaining / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${padded(seconds % 60)} 秒后回收` : `${seconds} 秒后回收`;
}

/** 0 是「不限制」的哨兵值，别让后台把它显示成「上限 0 个房间」。 */
export function describeRoomLimit(maxRooms: number): string {
  return Number(maxRooms) > 0 ? `${Math.floor(maxRooms)} 个` : '不限制';
}

export function formatMegabytes(value: number): string {
  return `${(Math.round((Number(value) || 0) * 10) / 10).toFixed(1)} MB`;
}

export function logLevelLabel(level: AdminLogLevel): string {
  if (level === 'error') return '错误';
  return level === 'warn' ? '警告' : '信息';
}

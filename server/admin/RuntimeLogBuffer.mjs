const DEFAULT_CAPACITY = 500;
const MAXIMUM_MESSAGE_LENGTH = 2000;

/** 后台日志面板认得的三档级别。 */
export const RUNTIME_LOG_LEVELS = ['info', 'warn', 'error'];

function formatArgument(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 网关进程的 console 输出环形缓冲，供后台「服务器日志」面板回看。
 *
 * 只接管**本进程**的 console：房间子进程的 stdout/stderr 直接继承到终端
 * （见 RoomProcessManager 的 `stdio: 'inherit'`），不经过这里；
 * 房间崩溃时由父进程打的那条 `[room …] process exited` 仍会被记下来。
 *
 * 容量固定（默认 500 条），跑再久也不会把内存吃穿。
 */
export class RuntimeLogBuffer {
  constructor(options = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.entries = [];
    this.sequence = 0;
    this.restore = undefined;
  }

  /** 记一条日志。超出容量时丢最老的一条。 */
  append(level, message) {
    this.sequence += 1;
    this.entries.push({
      id: this.sequence,
      level: RUNTIME_LOG_LEVELS.includes(level) ? level : 'info',
      time: new Date().toISOString(),
      message: String(message).slice(0, MAXIMUM_MESSAGE_LENGTH),
    });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  /**
   * 接管 console.log / warn / error：原样转发到真实 console 之后再落缓冲。
   * 返回还原函数；重复调用只会装一次。
   */
  install(target = console) {
    if (this.restore) return this.restore;
    const original = { log: target.log, warn: target.warn, error: target.error };
    const wrap = (level, method) => (...args) => {
      method.apply(target, args);
      this.append(level, args.map(formatArgument).join(' '));
    };
    target.log = wrap('info', original.log);
    target.warn = wrap('warn', original.warn);
    target.error = wrap('error', original.error);
    this.restore = () => {
      target.log = original.log;
      target.warn = original.warn;
      target.error = original.error;
      this.restore = undefined;
    };
    return this.restore;
  }

  /** 按级别与关键字过滤，返回最近 `limit` 条（时间正序）。 */
  read({ level = 'all', query = '', limit = 200 } = {}) {
    const keyword = String(query ?? '').trim().toLowerCase();
    const wanted = RUNTIME_LOG_LEVELS.includes(level) ? level : 'all';
    const matched = this.entries.filter((entry) => {
      if (wanted !== 'all' && entry.level !== wanted) return false;
      return keyword.length === 0 || entry.message.toLowerCase().includes(keyword);
    });
    const size = Math.min(Math.max(1, Math.floor(Number(limit) || 0) || 200), this.capacity);
    return { entries: matched.slice(-size), total: matched.length, capacity: this.capacity };
  }

  clear() {
    this.entries.length = 0;
  }
}

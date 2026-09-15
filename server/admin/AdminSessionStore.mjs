import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 8 * 3600 * 1000;
const DEFAULT_MAXIMUM_FAILURES = 8;
const DEFAULT_LOCK_MS = 10 * 60 * 1000;

/**
 * 后台登录态：内存里的 token → 过期时间。
 *
 * 只存在网关进程内存里，重启即全部失效——后台是低频运维入口，不值得为它引一套持久会话。
 * 同一 IP 连续失败到上限后短时锁定，挡住暴力猜口令。
 */
export class AdminSessionStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maximumFailures = options.maximumFailures ?? DEFAULT_MAXIMUM_FAILURES;
    this.lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
    this.sessions = new Map();
    this.failures = new Map();
  }

  /** 发一张新会话票（登录成功、或改完口令后补发）。 */
  issue(now = Date.now()) {
    this.prune(now);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + this.ttlMs);
    return token;
  }

  /** 校验会话票；有效则滑动续期。 */
  verify(token, now = Date.now()) {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, now + this.ttlMs);
    return true;
  }

  revoke(token) {
    if (token) this.sessions.delete(token);
  }

  /** 改口令时调用：踢掉所有在线后台会话，包括改口令者自己手上那张。 */
  revokeAll() {
    this.sessions.clear();
  }

  /** 该来源还要锁多少秒（0 = 没锁）。 */
  lockRemainingSeconds(source, now = Date.now()) {
    const failure = this.failures.get(source);
    if (!failure || failure.count < this.maximumFailures) return 0;
    const remaining = failure.until - now;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  noteFailure(source, now = Date.now()) {
    const failure = this.failures.get(source) ?? { count: 0, until: 0 };
    failure.count += 1;
    failure.until = now + this.lockMs;
    this.failures.set(source, failure);
  }

  noteSuccess(source) {
    this.failures.delete(source);
  }

  prune(now = Date.now()) {
    for (const [token, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(token);
    for (const [source, failure] of this.failures) if (failure.until <= now) this.failures.delete(source);
  }

  get size() {
    return this.sessions.size;
  }
}

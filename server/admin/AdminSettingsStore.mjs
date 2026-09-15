import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hashAdminPassword } from './adminPasswords.mjs';

/** 房间数不限制时的哨兵值：0（后台输入 0 即「不限制」）。 */
export const UNLIMITED_ROOMS = 0;
export const MAXIMUM_ROOMS = 999;
export const MINIMUM_EMPTY_ROOM_TTL_SECONDS = 10;
export const MAXIMUM_EMPTY_ROOM_TTL_SECONDS = 3600;

const DEFAULT_EMPTY_ROOM_TTL_SECONDS = 60;

function clampInteger(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

/**
 * 后台可改的运行期设置 + 后台口令哈希，一起落在一个 JSON 文件里。
 *
 * SkyLand 没有数据库，这个文件就是唯一的真相：
 *   · 目录 `SKYLAND_DATA_DIR`（部署时挂持久卷），默认 `<cwd>/data`；
 *   · `SKYLAND_ADMIN_PASSWORD` 只是**初始口令**——文件里一旦有了哈希，改口令只能在后台做；
 *   · 读写失败一律降级为内存态并打一条警告：后台是运维入口，不该因为它挂掉而拖垮游戏服务。
 *
 * 忘记口令的恢复手段：停服后删掉文件里的 `passwordHash` 字段（或整个文件），
 * 重启即回到 `SKYLAND_ADMIN_PASSWORD` 指定的初始口令。
 */
export class AdminSettingsStore {
  constructor(options = {}) {
    const directory = resolve(options.dataDirectory || process.env.SKYLAND_DATA_DIR || resolve(process.cwd(), 'data'));
    this.filePath = options.filePath ? resolve(options.filePath) : resolve(directory, 'admin-settings.json');
    this.initialPassword = String(options.initialPassword ?? process.env.SKYLAND_ADMIN_PASSWORD ?? '').trim();
    this.settings = {
      maxRooms: UNLIMITED_ROOMS,
      emptyRoomTtlSeconds: DEFAULT_EMPTY_ROOM_TTL_SECONDS,
      passwordHash: '',
      passwordUpdatedAt: null,
    };
    this.persisted = true;
  }

  /** 载入磁盘设置；文件里还没有口令而环境变量配了初始口令时，顺手把它哈希写进文件。 */
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.settings = this.sanitize(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[admin] 设置文件读取失败，暂时使用默认值', error);
      }
    }

    if (!this.settings.passwordHash && this.initialPassword) {
      this.settings.passwordHash = await hashAdminPassword(this.initialPassword);
      this.settings.passwordUpdatedAt = new Date().toISOString();
      await this.persist();
      console.log('[admin] 已用 SKYLAND_ADMIN_PASSWORD 初始化后台口令（只存哈希；建议登录后立即修改）');
    }
    return this.get();
  }

  sanitize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      maxRooms: clampInteger(source.maxRooms, UNLIMITED_ROOMS, MAXIMUM_ROOMS, UNLIMITED_ROOMS),
      emptyRoomTtlSeconds: clampInteger(
        source.emptyRoomTtlSeconds,
        MINIMUM_EMPTY_ROOM_TTL_SECONDS,
        MAXIMUM_EMPTY_ROOM_TTL_SECONDS,
        DEFAULT_EMPTY_ROOM_TTL_SECONDS,
      ),
      passwordHash: typeof source.passwordHash === 'string' ? source.passwordHash : '',
      passwordUpdatedAt: typeof source.passwordUpdatedAt === 'string' ? source.passwordUpdatedAt : null,
    };
  }

  get() {
    return { ...this.settings };
  }

  /** 后台是否可用：没有口令就整体关闭，免得空口令后台裸奔在公网上。 */
  isEnabled() {
    return this.settings.passwordHash.length > 0;
  }

  passwordHash() {
    return this.settings.passwordHash;
  }

  /** 改写设置并落盘。写盘失败只降级为内存生效（`persisted` 转 false），不抛给调用方。 */
  async save(patch) {
    this.settings = this.sanitize({ ...this.settings, ...patch });
    await this.persist();
    return this.get();
  }

  async setPasswordHash(hash) {
    return this.save({ passwordHash: hash, passwordUpdatedAt: new Date().toISOString() });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      // 先写临时文件再 rename：断电或并发写时不会留下半截 JSON，下次启动照样读得出来。
      await writeFile(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.filePath);
      this.persisted = true;
    } catch (error) {
      this.persisted = false;
      console.warn('[admin] 设置文件写入失败（仅内存生效，重启后丢失）', error);
    }
  }
}

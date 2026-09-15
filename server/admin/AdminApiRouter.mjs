import { sendJson } from '../http/HttpResponses.mjs';
import { readJsonBody } from '../http/readJsonBody.mjs';
import { ADMIN_PASSWORD_MINIMUM_LENGTH, hashAdminPassword, verifyAdminPassword } from './adminPasswords.mjs';
import {
  MAXIMUM_EMPTY_ROOM_TTL_SECONDS,
  MAXIMUM_ROOMS,
  MINIMUM_EMPTY_ROOM_TTL_SECONDS,
  UNLIMITED_ROOMS,
} from './AdminSettingsStore.mjs';

export const ADMIN_SESSION_COOKIE = 'skyland_admin_session';
// 房间 id 当前是 UUID，这里放宽到字母数字与短横：换了生成方式也不会悄悄变成 404。
const ROOM_ID_PATTERN = /^\/api\/admin\/rooms\/([A-Za-z0-9-]{1,64})$/;

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

/** 请求方 IP：只用于失败计数与锁定，不落盘。反代后取 X-Forwarded-For 的第一段。 */
function requestSource(request) {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

/**
 * 会话 cookie 的属性。**下发与清除必须用同一套**，否则浏览器认不出是同一个 cookie，
 * 会出现「服务端以为清了、浏览器里还在」的假退出。
 *
 * Secure 按本次请求真实走的协议定：HTTP 下强行带 Secure 会被浏览器丢掉，
 * 表现是登录返回 200、下一个接口立刻 401。
 */
function sessionCookie(request, token, maxAgeSeconds) {
  const secure = request.socket.encrypted === true
    || String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 后台 REST：`/api/admin/*`。口令登录后可看总览、管房间、查地图、翻日志、改运行期设置。
 *
 * 约定：
 *   · 没配口令（设置文件与 `SKYLAND_ADMIN_PASSWORD` 都没有）→ 除 `/session` 外一律 503，
 *     前端据此显示「后台未启用」而不是一堆报错；
 *   · 登录态与玩家侧完全隔离，游戏的 `/api/rooms` 等接口不受影响；
 *   · 所有写操作都记一条 console 日志，日志面板里能回看谁在什么时候动了什么。
 */
export class AdminApiRouter {
  constructor(options) {
    this.roomManager = options.roomManager;
    this.sceneCatalog = options.sceneCatalog;
    this.settingsStore = options.settingsStore;
    this.sessionStore = options.sessionStore;
    this.logBuffer = options.logBuffer;
    this.onSettingsChanged = options.onSettingsChanged ?? (() => {});
  }

  async handle(request, response, url) {
    if (!url.pathname.startsWith('/api/admin/')) return false;

    try {
      if (await this.route(request, response, url)) return true;
      sendJson(response, 404, { error: '接口不存在' }, request.method);
    } catch (error) {
      console.error('[admin] 请求处理失败', error);
      sendJson(response, 400, { error: error instanceof Error ? error.message : '请求处理失败' }, request.method);
    }
    return true;
  }

  async route(request, response, url) {
    const { method } = request;
    const path = url.pathname;
    const readable = method === 'GET' || method === 'HEAD';

    // 登录态查询永远可用：后台没启用时前端也要能问出「为什么进不去」。
    if (readable && path === '/api/admin/session') {
      sendJson(response, 200, this.describeSession(request), method);
      return true;
    }

    if (!this.settingsStore.isEnabled()) {
      sendJson(
        response,
        503,
        { error: '后台未启用：请配置 SKYLAND_ADMIN_PASSWORD 后重启服务' },
        method,
      );
      return true;
    }

    if (method === 'POST' && path === '/api/admin/session') return this.login(request, response);
    if (method === 'DELETE' && path === '/api/admin/session') return this.logout(request, response);

    if (!this.isAuthenticated(request)) {
      sendJson(response, 401, { error: '请先登录后台' }, method);
      return true;
    }

    if (method === 'POST' && path === '/api/admin/password') return this.changePassword(request, response);
    if (readable && path === '/api/admin/overview') return this.sendOverview(request, response);
    if (readable && path === '/api/admin/rooms') return this.sendRooms(request, response);
    if (readable && path === '/api/admin/scenes') return this.sendScenes(request, response);
    if (readable && path === '/api/admin/logs') return this.sendLogs(request, response, url);
    if (readable && path === '/api/admin/settings') return this.sendSettings(request, response);
    if (method === 'PUT' && path === '/api/admin/settings') return this.saveSettings(request, response);

    const roomMatch = path.match(ROOM_ID_PATTERN);
    if (method === 'DELETE' && roomMatch) return this.closeRoom(request, response, roomMatch[1]);

    return false;
  }

  isAuthenticated(request) {
    const token = parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE);
    return this.sessionStore.verify(token);
  }

  describeSession(request) {
    const enabled = this.settingsStore.isEnabled();
    return {
      enabled,
      authenticated: enabled && this.isAuthenticated(request),
      passwordMinimumLength: ADMIN_PASSWORD_MINIMUM_LENGTH,
    };
  }

  async login(request, response) {
    const source = requestSource(request);
    const lockSeconds = this.sessionStore.lockRemainingSeconds(source);
    if (lockSeconds > 0) {
      sendJson(response, 429, { error: `口令错误次数过多，请 ${lockSeconds} 秒后再试` }, request.method);
      return true;
    }

    const body = await readJsonBody(request);
    if (!(await verifyAdminPassword(this.settingsStore.passwordHash(), String(body.password ?? '')))) {
      this.sessionStore.noteFailure(source);
      console.warn(`[admin] 登录失败 来源=${source}`);
      sendJson(response, 401, { error: '口令错误' }, request.method);
      return true;
    }

    this.sessionStore.noteSuccess(source);
    console.log(`[admin] 登录成功 来源=${source}`);
    this.sendWithSession(request, response, 200, { ok: true });
    return true;
  }

  logout(request, response) {
    this.sessionStore.revoke(parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE));
    sendJson(response, 200, { ok: true }, request.method, {
      'Set-Cookie': sessionCookie(request, '', 0),
    });
    return true;
  }

  /**
   * 改后台口令：先验当前口令 → 哈希新口令落盘 → 作废全部后台会话，
   * 并给本次请求补发一张新票（改完不用重新登录，但别人手上的旧 cookie 立刻失效）。
   */
  async changePassword(request, response) {
    const body = await readJsonBody(request);
    const current = String(body.current ?? '');
    const next = String(body.next ?? '');

    if (!(await verifyAdminPassword(this.settingsStore.passwordHash(), current))) {
      console.warn(`[admin] 修改口令失败（当前口令不正确）来源=${requestSource(request)}`);
      sendJson(response, 400, { error: '当前口令不正确' }, request.method);
      return true;
    }
    if (next.length < ADMIN_PASSWORD_MINIMUM_LENGTH) {
      sendJson(response, 400, { error: `新口令至少 ${ADMIN_PASSWORD_MINIMUM_LENGTH} 位` }, request.method);
      return true;
    }
    if (await verifyAdminPassword(this.settingsStore.passwordHash(), next)) {
      sendJson(response, 400, { error: '新口令不能与当前口令相同' }, request.method);
      return true;
    }

    await this.settingsStore.setPasswordHash(await hashAdminPassword(next));
    this.sessionStore.revokeAll();
    console.log('[admin] 后台口令已修改（其余在线后台会话已全部作废）');
    this.sendWithSession(request, response, 200, {
      ok: true,
      message: '口令已修改，其它设备上的后台登录已被踢下线',
      persisted: this.settingsStore.persisted,
    });
    return true;
  }

  sendWithSession(request, response, statusCode, payload) {
    const token = this.sessionStore.issue();
    sendJson(response, statusCode, payload, request.method, {
      'Set-Cookie': sessionCookie(request, token, this.sessionStore.ttlMs / 1000),
    });
  }

  sendOverview(request, response) {
    const rooms = this.roomManager.listRooms();
    const settings = this.settingsStore.get();
    const memory = process.memoryUsage();
    sendJson(
      response,
      200,
      {
        overview: {
          rooms: rooms.length,
          maxRooms: settings.maxRooms,
          players: rooms.reduce((total, room) => total + room.playerCount, 0),
          capacity: rooms.reduce((total, room) => total + room.capacity, 0),
          idleRooms: rooms.filter((room) => room.playerCount === 0).length,
          scenes: this.sceneCatalog.list().length,
          uptimeSeconds: Math.round(process.uptime()),
          residentMemoryMB: Math.round((memory.rss / (1024 * 1024)) * 10) / 10,
          heapUsedMB: Math.round((memory.heapUsed / (1024 * 1024)) * 10) / 10,
          nodeVersion: process.version,
          settingsPath: this.settingsStore.filePath,
          settingsPersisted: this.settingsStore.persisted,
        },
      },
      request.method,
    );
    return true;
  }

  sendRooms(request, response) {
    const rooms = this.roomManager
      .listRooms()
      .map((room) => ({ ...room, players: this.roomManager.listRoomPlayers(room.id) }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    sendJson(response, 200, { rooms, maxRooms: this.settingsStore.get().maxRooms }, request.method);
    return true;
  }

  sendScenes(request, response) {
    const rooms = this.roomManager.listRooms();
    const scenes = this.sceneCatalog.list().map((scene) => {
      const hosted = rooms.filter((room) => room.sceneId === scene.id);
      return {
        ...scene,
        roomCount: hosted.length,
        playerCount: hosted.reduce((total, room) => total + room.playerCount, 0),
      };
    });
    sendJson(response, 200, { scenes }, request.method);
    return true;
  }

  sendLogs(request, response, url) {
    const result = this.logBuffer.read({
      level: String(url.searchParams.get('level') ?? 'all'),
      query: String(url.searchParams.get('q') ?? '').slice(0, 120),
      limit: Number(url.searchParams.get('limit')),
    });
    sendJson(response, 200, result, request.method);
    return true;
  }

  sendSettings(request, response) {
    const { passwordHash: _hash, ...settings } = this.settingsStore.get();
    sendJson(
      response,
      200,
      {
        settings,
        limits: {
          unlimitedRooms: UNLIMITED_ROOMS,
          maximumRooms: MAXIMUM_ROOMS,
          minimumEmptyRoomTtlSeconds: MINIMUM_EMPTY_ROOM_TTL_SECONDS,
          maximumEmptyRoomTtlSeconds: MAXIMUM_EMPTY_ROOM_TTL_SECONDS,
          passwordMinimumLength: ADMIN_PASSWORD_MINIMUM_LENGTH,
        },
        settingsPath: this.settingsStore.filePath,
        settingsPersisted: this.settingsStore.persisted,
        currentRooms: this.roomManager.listRooms().length,
      },
      request.method,
    );
    return true;
  }

  async saveSettings(request, response) {
    const body = await readJsonBody(request);
    const maxRooms = Number(body.maxRooms);
    const emptyRoomTtlSeconds = Number(body.emptyRoomTtlSeconds);

    if (!Number.isInteger(maxRooms) || maxRooms < UNLIMITED_ROOMS || maxRooms > MAXIMUM_ROOMS) {
      sendJson(response, 400, { error: `最大房间数需为 ${UNLIMITED_ROOMS}-${MAXIMUM_ROOMS} 的整数（0 = 不限制）` }, request.method);
      return true;
    }
    if (
      !Number.isInteger(emptyRoomTtlSeconds)
      || emptyRoomTtlSeconds < MINIMUM_EMPTY_ROOM_TTL_SECONDS
      || emptyRoomTtlSeconds > MAXIMUM_EMPTY_ROOM_TTL_SECONDS
    ) {
      sendJson(
        response,
        400,
        { error: `空房回收时间需为 ${MINIMUM_EMPTY_ROOM_TTL_SECONDS}-${MAXIMUM_EMPTY_ROOM_TTL_SECONDS} 秒` },
        request.method,
      );
      return true;
    }

    const settings = await this.settingsStore.save({ maxRooms, emptyRoomTtlSeconds });
    this.onSettingsChanged(settings);
    console.log(
      `[admin] 保存设置：最大房间数=${settings.maxRooms === UNLIMITED_ROOMS ? '不限制' : settings.maxRooms}`
      + `，空房回收=${settings.emptyRoomTtlSeconds} 秒`,
    );
    const { passwordHash: _hash, ...safeSettings } = settings;
    sendJson(response, 200, { settings: safeSettings, persisted: this.settingsStore.persisted }, request.method);
    return true;
  }

  closeRoom(request, response, roomId) {
    const removed = this.roomManager.removeRoom(roomId);
    if (!removed) {
      sendJson(response, 404, { error: '房间不存在（可能已关闭）' }, request.method);
      return true;
    }
    console.log(`[admin] 关闭房间 ${roomId}`);
    sendJson(response, 200, { ok: true }, request.method);
    return true;
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminApiRouter, ADMIN_SESSION_COOKIE } from '../admin/AdminApiRouter.mjs';
import { AdminSessionStore } from '../admin/AdminSessionStore.mjs';
import { AdminSettingsStore } from '../admin/AdminSettingsStore.mjs';
import { RuntimeLogBuffer } from '../admin/RuntimeLogBuffer.mjs';
import { sendJson } from '../http/HttpResponses.mjs';

const PASSWORD = 'skyland-admin';

class FakeRoomManager {
  constructor(rooms = []) {
    this.rooms = new Map(rooms.map((room) => [room.id, room]));
    this.closed = [];
  }

  listRooms() {
    return Array.from(this.rooms.values(), ({ players: _players, ...summary }) => summary);
  }

  listRoomPlayers(roomId) {
    return this.rooms.get(roomId)?.players ?? [];
  }

  removeRoom(roomId) {
    if (!this.rooms.delete(roomId)) return false;
    this.closed.push(roomId);
    return true;
  }
}

function createRoom(id, overrides = {}) {
  return {
    id,
    name: `房间 ${id}`,
    playerCount: 1,
    capacity: 4,
    sceneId: 'meadow',
    sceneName: '草地',
    worldSeed: 42,
    createdAt: '2026-01-01T00:00:00.000Z',
    idleExpiresAt: null,
    players: [{ id: 'p1', name: '旅人', slot: 0 }],
    ...overrides,
  };
}

const sceneCatalog = {
  list: () => [{ id: 'meadow', displayName: '草地', description: '开阔草场', capacity: 4 }],
};

/** 起一台只挂后台路由的真实 HTTP 服务：cookie 下发与会话续期都得走真请求才算数。 */
async function startAdminServer(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'skyland-admin-'));
  const settingsStore = new AdminSettingsStore({
    dataDirectory: directory,
    initialPassword: options.initialPassword ?? PASSWORD,
  });
  await settingsStore.load();

  const roomManager = options.roomManager ?? new FakeRoomManager();
  const logBuffer = options.logBuffer ?? new RuntimeLogBuffer();
  // 后台的每一次写操作都会打日志。接管全局 console（路由就是往那儿写的），
  // 既能验证「操作可回溯」，也顺手让测试输出清净；close() 时还原。
  const restoreConsole = logBuffer.install();
  const changes = [];
  const router = new AdminApiRouter({
    roomManager,
    sceneCatalog,
    settingsStore,
    sessionStore: options.sessionStore ?? new AdminSessionStore(),
    logBuffer,
    onSettingsChanged: (next) => changes.push(next),
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (await router.handle(request, response, url)) return;
    sendJson(response, 404, { error: '资源不存在' }, request.method);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    changes,
    roomManager,
    settingsStore,
    directory,
    async request(path, init = {}) {
      const response = await fetch(`${origin}/api/admin${path}`, init);
      const payload = await response.json().catch(() => undefined);
      return { status: response.status, payload, setCookie: response.headers.get('set-cookie') };
    },
    async close() {
      restoreConsole();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function cookieValue(setCookie) {
  return String(setCookie ?? '').split(';')[0];
}

async function login(harness, password = PASSWORD) {
  const result = await harness.request('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { ...result, cookie: cookieValue(result.setCookie) };
}

test('未配置口令时后台整体关闭，但仍能问出「为什么进不去」', async () => {
  const harness = await startAdminServer({ initialPassword: '' });
  try {
    const session = await harness.request('/session');
    assert.equal(session.status, 200);
    assert.equal(session.payload.enabled, false);
    assert.equal(session.payload.authenticated, false);

    const overview = await harness.request('/overview');
    assert.equal(overview.status, 503);
  } finally {
    await harness.close();
  }
});

test('登录前接口 401，登录后带 cookie 才能读总览', async () => {
  const roomManager = new FakeRoomManager([createRoom('room-a'), createRoom('room-b', { playerCount: 0 })]);
  const harness = await startAdminServer({ roomManager });
  try {
    assert.equal((await harness.request('/overview')).status, 401);
    assert.equal((await login(harness, '口令不对')).status, 401);

    const session = await login(harness);
    assert.equal(session.status, 200);
    assert.match(session.setCookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
    assert.match(session.setCookie, /HttpOnly/);
    assert.match(session.setCookie, /SameSite=Lax/);
    // 明文 HTTP 请求不该带 Secure：浏览器会直接丢掉这张 cookie，表现为登录成功后立刻 401。
    assert.doesNotMatch(session.setCookie, /Secure/);

    const overview = await harness.request('/overview', { headers: { cookie: session.cookie } });
    assert.equal(overview.status, 200);
    assert.equal(overview.payload.overview.rooms, 2);
    assert.equal(overview.payload.overview.players, 1);
    assert.equal(overview.payload.overview.idleRooms, 1);
    assert.equal(overview.payload.overview.scenes, 1);
  } finally {
    await harness.close();
  }
});

test('房间面板能看到在场玩家，也能关掉房间', async () => {
  const roomManager = new FakeRoomManager([createRoom('room-a')]);
  const harness = await startAdminServer({ roomManager });
  try {
    const { cookie } = await login(harness);
    const rooms = await harness.request('/rooms', { headers: { cookie } });
    assert.equal(rooms.status, 200);
    assert.deepEqual(rooms.payload.rooms[0].players, [{ id: 'p1', name: '旅人', slot: 0 }]);

    const closed = await harness.request('/rooms/room-a', { method: 'DELETE', headers: { cookie } });
    assert.equal(closed.status, 200);
    assert.deepEqual(roomManager.closed, ['room-a']);

    const missing = await harness.request('/rooms/room-a', { method: 'DELETE', headers: { cookie } });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test('地图目录带上每张图当下的承载情况', async () => {
  const harness = await startAdminServer({ roomManager: new FakeRoomManager([createRoom('room-a')]) });
  try {
    const { cookie } = await login(harness);
    const scenes = await harness.request('/scenes', { headers: { cookie } });
    assert.equal(scenes.payload.scenes[0].roomCount, 1);
    assert.equal(scenes.payload.scenes[0].playerCount, 1);
  } finally {
    await harness.close();
  }
});

test('保存设置：非法值被挡下，合法值落盘并通知运行时', async () => {
  const harness = await startAdminServer();
  try {
    const { cookie } = await login(harness);
    const headers = { cookie, 'Content-Type': 'application/json' };

    const rejected = await harness.request('/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ maxRooms: -1, emptyRoomTtlSeconds: 60 }),
    });
    assert.equal(rejected.status, 400);

    const tooShort = await harness.request('/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ maxRooms: 4, emptyRoomTtlSeconds: 1 }),
    });
    assert.equal(tooShort.status, 400);

    const saved = await harness.request('/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ maxRooms: 4, emptyRoomTtlSeconds: 120 }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.settings.maxRooms, 4);
    assert.equal(harness.changes.at(-1).emptyRoomTtlSeconds, 120);

    const onDisk = JSON.parse(await readFile(harness.settingsStore.filePath, 'utf8'));
    assert.equal(onDisk.maxRooms, 4);
    assert.equal(onDisk.emptyRoomTtlSeconds, 120);

    // 设置接口绝不回传口令哈希。
    const settings = await harness.request('/settings', { headers: { cookie } });
    assert.equal(settings.payload.settings.passwordHash, undefined);
  } finally {
    await harness.close();
  }
});

test('改口令后旧会话立刻失效，本次请求拿到新票', async () => {
  const harness = await startAdminServer();
  try {
    const first = await login(harness);
    const second = await login(harness);

    const weak = await harness.request('/password', {
      method: 'POST',
      headers: { cookie: first.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: PASSWORD, next: 'short' }),
    });
    assert.equal(weak.status, 400);

    const changed = await harness.request('/password', {
      method: 'POST',
      headers: { cookie: first.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: PASSWORD, next: 'skyland-next-password' }),
    });
    assert.equal(changed.status, 200);
    const refreshed = cookieValue(changed.setCookie);
    assert.notEqual(refreshed, first.cookie);

    assert.equal((await harness.request('/overview', { headers: { cookie: second.cookie } })).status, 401);
    assert.equal((await harness.request('/overview', { headers: { cookie: refreshed } })).status, 200);
    assert.equal((await login(harness, PASSWORD)).status, 401);
    assert.equal((await login(harness, 'skyland-next-password')).status, 200);
  } finally {
    await harness.close();
  }
});

test('口令连续猜错会被短时锁定', async () => {
  const harness = await startAdminServer({
    sessionStore: new AdminSessionStore({ maximumFailures: 2, lockMs: 60_000 }),
  });
  try {
    assert.equal((await login(harness, '错1')).status, 401);
    assert.equal((await login(harness, '错2')).status, 401);
    const locked = await login(harness, PASSWORD);
    assert.equal(locked.status, 429);
    assert.match(locked.payload.error, /秒后再试/);
  } finally {
    await harness.close();
  }
});

test('退出登录会清掉会话与 cookie', async () => {
  const harness = await startAdminServer();
  try {
    const { cookie } = await login(harness);
    const logout = await harness.request('/session', { method: 'DELETE', headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.setCookie, /Max-Age=0/);
    assert.equal((await harness.request('/overview', { headers: { cookie } })).status, 401);
  } finally {
    await harness.close();
  }
});

test('日志面板按级别与关键字过滤网关日志', async () => {
  const logBuffer = new RuntimeLogBuffer({ capacity: 10 });
  logBuffer.append('info', '房间 room-a 已创建');
  logBuffer.append('error', '房间 room-b 进程退出');
  const harness = await startAdminServer({ logBuffer });
  try {
    const { cookie } = await login(harness);
    const errors = await harness.request('/logs?level=error', { headers: { cookie } });
    assert.equal(errors.payload.entries.length, 1);
    assert.match(errors.payload.entries[0].message, /room-b/);

    const searched = await harness.request('/logs?level=all&q=room-a', { headers: { cookie } });
    assert.equal(searched.payload.entries.length, 1);

    // 登录动作自己也会记一条日志，正好验证「后台操作可回溯」。
    const all = await harness.request('/logs?level=all', { headers: { cookie } });
    assert.ok(all.payload.entries.some((entry) => entry.message.includes('[admin] 登录成功')));
  } finally {
    await harness.close();
  }
});

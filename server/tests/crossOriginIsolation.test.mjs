import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CROSS_ORIGIN_ISOLATION_HEADERS,
  applyCrossOriginIsolation,
  isCrossOriginIsolationEnabled,
} from '../http/crossOriginIsolation.mjs';
import { sendJson } from '../http/HttpResponses.mjs';
import { StaticWebServer } from '../http/StaticWebServer.mjs';

/** 和 server/index.mjs 一样的接线顺序：先写隔离头，再路由。 */
async function createFixture(env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skyland-coi-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>SkyLand</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("SkyLand")');

  const staticWebServer = new StaticWebServer(root);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    applyCrossOriginIsolation(response, env);
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 200, { ok: true }, request.method);
      return;
    }
    if (await staticWebServer.handle(request, response, url)) return;
    sendJson(response, 404, { error: '资源不存在' }, request.method);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function assertIsolated(response) {
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
}

test('文档、静态资源、API 与 404 共用同一份跨源隔离策略', async () => {
  const fixture = await createFixture();
  try {
    // 只要有一份响应漏了 COOP/COEP，页面就拿不到 crossOriginIsolated，
    // 而失败方式是「SharedArrayBuffer 静默不可用」，不是报错。
    assertIsolated(await fetch(`${fixture.origin}/`));
    assertIsolated(await fetch(`${fixture.origin}/assets/app.js`));
    assertIsolated(await fetch(`${fixture.origin}/api/rooms`));

    const missing = await fetch(`${fixture.origin}/assets/missing.js`);
    assert.equal(missing.status, 404);
    assertIsolated(missing);
  } finally {
    await fixture.close();
  }
});

test('隔离头不覆盖静态服务原有的缓存与类型契约', async () => {
  const fixture = await createFixture();
  try {
    const asset = await fetch(`${fixture.origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /^text\/javascript/);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await fixture.close();
  }
});

test('SKYLAND_CROSS_ORIGIN_ISOLATION=off 可以整体退回未隔离部署', async () => {
  const fixture = await createFixture({ SKYLAND_CROSS_ORIGIN_ISOLATION: 'off' });
  try {
    const entry = await fetch(`${fixture.origin}/`);
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get('cross-origin-opener-policy'), null);
    assert.equal(entry.headers.get('cross-origin-embedder-policy'), null);
  } finally {
    await fixture.close();
  }
});

test('开关只认 off / 0 / false，其余取值一律保持隔离', () => {
  assert.equal(isCrossOriginIsolationEnabled({}), true);
  assert.equal(isCrossOriginIsolationEnabled({ SKYLAND_CROSS_ORIGIN_ISOLATION: 'on' }), true);
  assert.equal(isCrossOriginIsolationEnabled({ SKYLAND_CROSS_ORIGIN_ISOLATION: ' OFF ' }), false);
  assert.equal(isCrossOriginIsolationEnabled({ SKYLAND_CROSS_ORIGIN_ISOLATION: '0' }), false);
  assert.equal(isCrossOriginIsolationEnabled({ SKYLAND_CROSS_ORIGIN_ISOLATION: 'false' }), false);
  assert.equal(Object.isFrozen(CROSS_ORIGIN_ISOLATION_HEADERS), true);
});

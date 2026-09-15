import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaticWebServer } from '../http/StaticWebServer.mjs';

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'skyland-static-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>SkyLand</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("SkyLand")');
  await writeFile(join(root, 'admin.html'), '<!doctype html><title>运维后台</title>');

  const staticWebServer = new StaticWebServer(root);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    await staticWebServer.handle(request, response, url);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    root,
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('serves the Vite entry and immutable assets', async () => {
  const fixture = await createFixture();
  try {
    const entry = await fetch(`${fixture.origin}/`);
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get('content-type'), /^text\/html/);
    assert.equal(entry.headers.get('cache-control'), 'no-cache');
    assert.match(await entry.text(), /SkyLand/);

    const asset = await fetch(`${fixture.origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /^text\/javascript/);
    assert.match(asset.headers.get('cache-control'), /immutable/);
  } finally {
    await fixture.close();
  }
});

test('supports HEAD and client-side route fallback', async () => {
  const fixture = await createFixture();
  try {
    const head = await fetch(`${fixture.origin}/assets/app.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const route = await fetch(`${fixture.origin}/rooms/example`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /SkyLand/);
  } finally {
    await fixture.close();
  }
});

test('does not turn missing static assets into the SPA entry', async () => {
  const fixture = await createFixture();
  try {
    const response = await fetch(`${fixture.origin}/assets/missing.js`);
    assert.equal(response.status, 404);
  } finally {
    await fixture.close();
  }
});

test('serves a sibling HTML page for a clean URL', async () => {
  const fixture = await createFixture();
  try {
    // /admin 必须落到 admin.html，而不是被 SPA 回退吞成游戏入口。
    const clean = await fetch(`${fixture.origin}/admin`);
    assert.equal(clean.status, 200);
    assert.match(await clean.text(), /运维后台/);

    const explicit = await fetch(`${fixture.origin}/admin.html`);
    assert.equal(explicit.status, 200);
    assert.match(await explicit.text(), /运维后台/);

    // 没有同名 HTML 的干净地址仍然回退到游戏入口。
    const fallback = await fetch(`${fixture.origin}/somewhere`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /SkyLand/);
  } finally {
    await fixture.close();
  }
});

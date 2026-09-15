import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminSettingsStore } from '../admin/AdminSettingsStore.mjs';
import { verifyAdminPassword } from '../admin/adminPasswords.mjs';
import { RuntimeLogBuffer } from '../admin/RuntimeLogBuffer.mjs';

async function createDirectory() {
  return mkdtemp(join(tmpdir(), 'skyland-admin-settings-'));
}

test('初始口令只在文件里还没有口令时生效，且落盘的只有哈希', async () => {
  const dataDirectory = await createDirectory();
  const store = new AdminSettingsStore({ dataDirectory, initialPassword: 'first-password' });
  await store.load();

  assert.equal(store.isEnabled(), true);
  assert.ok(await verifyAdminPassword(store.passwordHash(), 'first-password'));
  const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.equal(onDisk.passwordHash, store.passwordHash());
  assert.doesNotMatch(JSON.stringify(onDisk), /first-password/);

  // 重启后换了环境变量里的初始口令：文件里的口令才是真相。
  const restarted = new AdminSettingsStore({ dataDirectory, initialPassword: 'another-password' });
  await restarted.load();
  assert.ok(await verifyAdminPassword(restarted.passwordHash(), 'first-password'));
  assert.equal(await verifyAdminPassword(restarted.passwordHash(), 'another-password'), false);
});

test('没有任何口令时后台保持关闭', async () => {
  const store = new AdminSettingsStore({ dataDirectory: await createDirectory(), initialPassword: '' });
  await store.load();
  assert.equal(store.isEnabled(), false);
});

test('越界与损坏的设置被夹回合法区间，而不是把服务拖垮', async () => {
  const dataDirectory = await createDirectory();
  const filePath = join(dataDirectory, 'admin-settings.json');
  await writeFile(filePath, JSON.stringify({ maxRooms: -8, emptyRoomTtlSeconds: 99999 }), 'utf8');

  const store = new AdminSettingsStore({ dataDirectory, initialPassword: 'seed-password' });
  await store.load();
  assert.equal(store.get().maxRooms, 0);
  assert.equal(store.get().emptyRoomTtlSeconds, 3600);

  await writeFile(filePath, '{ 半截 JSON', 'utf8');
  const logBuffer = new RuntimeLogBuffer();
  const restore = logBuffer.install();
  const broken = new AdminSettingsStore({ dataDirectory, initialPassword: '' });
  await broken.load();
  restore();
  assert.equal(broken.get().emptyRoomTtlSeconds, 60);
  assert.ok(logBuffer.read({ level: 'warn' }).entries.some((entry) => entry.message.includes('设置文件读取失败')));
});

test('保存后的设置能被下一次启动读回来', async () => {
  const dataDirectory = await createDirectory();
  const store = new AdminSettingsStore({ dataDirectory, initialPassword: 'seed-password' });
  await store.load();
  await store.save({ maxRooms: 12, emptyRoomTtlSeconds: 180 });

  const restarted = new AdminSettingsStore({ dataDirectory, initialPassword: 'seed-password' });
  const settings = await restarted.load();
  assert.equal(settings.maxRooms, 12);
  assert.equal(settings.emptyRoomTtlSeconds, 180);
});

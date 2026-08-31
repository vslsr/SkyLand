import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RoomProcessManager } from '../rooms/RoomProcessManager.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

test('each room starts and stops an independent Node.js process', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ capacity: 4, sceneCatalog });
  const room = await manager.createRoom('独立进程测试房', 'open-meadow');
  const record = manager.rooms.get(room.id);

  assert.ok(record?.child.pid);
  assert.notEqual(record.child.pid, process.pid);
  assert.equal(record.child.connected, true);
  assert.equal(room.sceneId, 'open-meadow');

  const joined = manager.joinRoom(room.id, '测试玩家');
  assert.equal(joined.scene.id, 'open-meadow');
  assert.equal(joined.scene.displayName, '风吹原野');

  const exited = once(record.child, 'exit');
  assert.equal(manager.removeRoom(room.id), true);
  await exited;
  assert.equal(manager.getRoom(room.id), undefined);
});

test('empty rooms are recycled after the configured idle timeout', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ sceneCatalog, emptyRoomTtlMs: 40 });
  const room = await manager.createRoom('自动回收测试房', 'open-meadow');
  const record = manager.rooms.get(room.id);

  assert.ok(room.idleExpiresAt);
  const closed = once(manager, 'closed');
  const exited = once(record.child, 'exit');
  assert.deepEqual(await closed, [room.id]);
  await exited;
  assert.equal(manager.getRoom(room.id), undefined);
});

test('joining cancels cleanup and leaving the last player restarts the countdown', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ sceneCatalog, emptyRoomTtlMs: 1_000 });
  const room = await manager.createRoom('倒计时重置测试房', 'open-meadow');
  const joined = manager.joinRoom(room.id, '测试玩家');

  assert.equal(joined.room.idleExpiresAt, null);
  manager.leaveRoom(room.id, joined.player.id);
  assert.ok(manager.getRoom(room.id).idleExpiresAt);

  const record = manager.rooms.get(room.id);
  const exited = once(record.child, 'exit');
  manager.removeRoom(room.id);
  await exited;
});

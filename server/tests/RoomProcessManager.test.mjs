import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RoomProcessManager } from '../rooms/RoomProcessManager.mjs';

test('each room starts and stops an independent Node.js process', async () => {
  const manager = new RoomProcessManager({ capacity: 4 });
  const room = await manager.createRoom('独立进程测试房');
  const record = manager.rooms.get(room.id);

  assert.ok(record?.child.pid);
  assert.notEqual(record.child.pid, process.pid);
  assert.equal(record.child.connected, true);

  const exited = once(record.child, 'exit');
  assert.equal(manager.removeRoom(room.id), true);
  await exited;
  assert.equal(manager.getRoom(room.id), undefined);
});

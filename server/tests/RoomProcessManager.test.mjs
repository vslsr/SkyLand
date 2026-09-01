import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RoomProcessManager } from '../rooms/RoomProcessManager.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

function waitForSnapshot(manager, roomId, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off('snapshot', handleSnapshot);
      reject(new Error('等待 Actor 快照条件超时'));
    }, timeoutMs);
    const handleSnapshot = (receivedRoomId, snapshot) => {
      if (receivedRoomId !== roomId || !predicate(snapshot)) return;
      clearTimeout(timeout);
      manager.off('snapshot', handleSnapshot);
      resolve(snapshot);
    };
    manager.on('snapshot', handleSnapshot);
  });
}

function waitForTransformLogEvent(manager, sessionId, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off('transform-log:event', handleEvent);
      reject(new Error('等待玩家 Transform 诊断事件超时'));
    }, timeoutMs);
    const handleEvent = (roomId, playerId, receivedSessionId, event) => {
      if (receivedSessionId !== sessionId || !predicate(event)) return;
      clearTimeout(timeout);
      manager.off('transform-log:event', handleEvent);
      resolve({ roomId, playerId, event });
    };
    manager.on('transform-log:event', handleEvent);
  });
}

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

test('房间子进程把水域 JSON Actor 作为权威快照上报', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ sceneCatalog });
  const room = await manager.createRoom('Actor 快照测试房', 'water');
  const record = manager.rooms.get(room.id);
  const snapshotReceived = waitForSnapshot(manager, room.id, () => true);

  const snapshot = await snapshotReceived;
  assert.equal(snapshot.actors[0].id, 'demo-raft-01');
  assert.equal(snapshot.actors[0].buoyancy.state, 'afloat');

  const exited = once(record.child, 'exit');
  manager.removeRoom(room.id);
  await exited;
});

test('房间 IPC 把天气请求交给 DS 并从快照同步结果', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ sceneCatalog });
  const room = await manager.createRoom('天气同步测试房', 'open-meadow');
  const record = manager.rooms.get(room.id);
  const joined = manager.joinRoom(room.id, '观云者');

  manager.setWeather(room.id, joined.player.id, 'storm');
  const snapshot = await waitForSnapshot(
    manager,
    room.id,
    (candidate) => candidate.weather === 'storm',
  );
  assert.equal(snapshot.weather, 'storm');

  const exited = once(record.child, 'exit');
  manager.removeRoom(room.id);
  await exited;
});

test('房间 IPC 转发玩家 Transform 录制的权威步进事件与停止确认', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ sceneCatalog });
  const room = await manager.createRoom('Transform 日志测试房', 'open-meadow');
  const record = manager.rooms.get(room.id);
  const joined = manager.joinRoom(room.id, '记录者');
  const sessionId = '11111111-2222-4333-8444-555555555555';

  const startedEvent = waitForTransformLogEvent(
    manager,
    sessionId,
    (event) => event.event === 'server.recording_started',
  );
  assert.equal(manager.startPlayerTransformLog(room.id, joined.player.id, sessionId), true);
  assert.equal((await startedEvent).playerId, joined.player.id);

  const stepEvent = waitForTransformLogEvent(
    manager,
    sessionId,
    (event) => event.event === 'server.input_step_applied',
  );
  manager.sendInput(room.id, joined.player.id, {
    type: 'player:input',
    inputs: [{
      tick: 1,
      move: { x: 1, z: 0 },
      sprint: false,
      jump: false,
      yaw: 0,
    }],
  });
  assert.equal((await stepEvent).event.data.after.ackTick, 1);

  const stopped = once(manager, 'transform-log:stopped');
  assert.equal(manager.stopPlayerTransformLog(room.id, joined.player.id, sessionId), true);
  assert.deepEqual((await stopped).slice(0, 3), [room.id, joined.player.id, sessionId]);

  const exited = once(record.child, 'exit');
  manager.removeRoom(room.id);
  await exited;
});

test('房间 IPC 贯通控制权、船舶输入和载重事件', async () => {
  const sceneCatalog = await SceneCatalog.load();
  const manager = new RoomProcessManager({ sceneCatalog });
  const room = await manager.createRoom('船舶 IPC 测试房', 'water');
  const record = manager.rooms.get(room.id);
  const joined = manager.joinRoom(room.id, '船长');

  manager.claimActorControl(room.id, joined.player.id, 'demo-raft-01');
  const claimed = await waitForSnapshot(manager, room.id, (snapshot) => (
    snapshot.actors[0]?.control.ownerPlayerId === joined.player.id
  ));
  const start = claimed.actors[0].transform;

  manager.sendActorInput(room.id, joined.player.id, {
    actorId: 'demo-raft-01', sequence: 1, throttle: 1, steering: 0.5,
  });
  const moved = await waitForSnapshot(manager, room.id, (snapshot) => {
    const transform = snapshot.actors[0]?.transform;
    return transform && Math.hypot(transform.x - start.x, transform.z - start.z) > 0.0001;
  });
  assert.ok(moved.actors[0].vessel.speed > 0);

  manager.sendActorEvent(room.id, joined.player.id, {
    actorId: 'demo-raft-01', sequence: 1,
    event: { type: 'cargo:add', cargoId: 'ipc-crate', mass: 40, localX: 0, localZ: 0 },
  });
  const loaded = await waitForSnapshot(manager, room.id, (snapshot) => (
    snapshot.actors[0]?.buoyancy.cargoMass === 40
  ));
  assert.equal(loaded.actors[0].buoyancy.lastEvent.type, 'cargo:add');

  const exited = once(record.child, 'exit');
  manager.removeRoom(room.id);
  await exited;
});

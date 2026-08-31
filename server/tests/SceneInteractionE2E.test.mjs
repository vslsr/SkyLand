import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { RoomConnectionHub } from '../network/RoomConnectionHub.mjs';
import { WebSocketGateway } from '../network/WebSocketGateway.mjs';
import { RoomProcessManager } from '../rooms/RoomProcessManager.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

function waitForJson(socket, predicate, timeoutMs = 7_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('等待 WebSocket 场景状态超时'));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket 在闭环完成前关闭'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

function actorFrom(message, actorId) {
  return message.snapshot.actors.find((actor) => actor.id === actorId);
}

test('真实 WebSocket 贯通接管、装货、航行撞礁、损伤和卸货', async (context) => {
  const sceneCatalog = await SceneCatalog.load();
  const roomManager = new RoomProcessManager({ sceneCatalog });
  const room = await roomManager.createRoom('场景交互闭环测试', 'water');
  const roomRecord = roomManager.rooms.get(room.id);
  assert.ok(roomRecord);
  const server = http.createServer();
  const connectionHub = new RoomConnectionHub(roomManager);
  const gateway = new WebSocketGateway(server, connectionHub);
  let socket;

  context.after(async () => {
    socket?.terminate();
    gateway.close();
    connectionHub.close();
    const childExited = roomRecord.child.exitCode == null
      ? once(roomRecord.child, 'exit')
      : Promise.resolve();
    roomManager.shutdown();
    await childExited;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');

  socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const connected = waitForJson(socket, (message) => message.type === 'connected');
  await once(socket, 'open');
  await connected;

  const joinedState = waitForJson(socket, (message) => message.type === 'room:joined');
  socket.send(JSON.stringify({ type: 'room:join', roomId: room.id, name: '闭环船长' }));
  const joined = await joinedState;

  const claimedState = waitForJson(socket, (message) => (
    message.type === 'room:snapshot'
    && actorFrom(message, 'demo-raft-01')?.control.ownerPlayerId === joined.player.id
  ));
  socket.send(JSON.stringify({ type: 'actor:claim', actorId: 'demo-raft-01' }));
  await claimedState;

  const loadedState = waitForJson(socket, (message) => {
    if (message.type !== 'room:snapshot') return false;
    const raft = actorFrom(message, 'demo-raft-01');
    const cargo = actorFrom(message, 'cargo-crate-01');
    return cargo?.cargo.carrierActorId === 'demo-raft-01'
      && raft?.buoyancy.cargoMass === 55;
  });
  socket.send(JSON.stringify({ type: 'actor:interact', actorId: 'cargo-crate-01', sequence: 1 }));
  const loaded = await loadedState;
  const loadedRaft = actorFrom(loaded, 'demo-raft-01');
  const loadedCargo = actorFrom(loaded, 'cargo-crate-01');
  assert.ok(Math.hypot(
    loadedCargo.transform.x - loadedRaft.transform.x,
    loadedCargo.transform.z - loadedRaft.transform.z,
  ) < 1);

  const damagedState = waitForJson(socket, (message) => (
    message.type === 'room:snapshot'
    && actorFrom(message, 'demo-raft-01')?.buoyancy.damagedPartCount >= 1
  ));
  let inputSequence = 0;
  const motorInput = setInterval(() => {
    inputSequence += 1;
    socket.send(JSON.stringify({
      type: 'actor:input',
      actorId: 'demo-raft-01',
      sequence: inputSequence,
      throttle: 1,
      steering: 0,
    }));
  }, 50);
  const damaged = await damagedState.finally(() => clearInterval(motorInput));
  assert.equal(actorFrom(damaged, 'demo-raft-01').buoyancy.lastEvent.type, 'damage');

  const unloadedState = waitForJson(socket, (message) => {
    if (message.type !== 'room:snapshot') return false;
    const raft = actorFrom(message, 'demo-raft-01');
    const cargo = actorFrom(message, 'cargo-crate-01');
    return cargo?.cargo.carrierActorId === null && raft?.buoyancy.cargoMass === 0;
  });
  socket.send(JSON.stringify({ type: 'actor:interact', actorId: 'cargo-crate-01', sequence: 2 }));
  const unloaded = await unloadedState;
  assert.equal(actorFrom(unloaded, 'demo-raft-01').buoyancy.lastEvent.type, 'cargo:remove');
});

test('真实 WebSocket 贯通史莱姆叼取、移动拉伸和自动脱离', async (context) => {
  const sceneCatalog = await SceneCatalog.load();
  const roomManager = new RoomProcessManager({ sceneCatalog });
  const room = await roomManager.createRoom('弹性蘑菇闭环测试', 'grassland');
  const roomRecord = roomManager.rooms.get(room.id);
  assert.ok(roomRecord);
  const server = http.createServer();
  const connectionHub = new RoomConnectionHub(roomManager);
  const gateway = new WebSocketGateway(server, connectionHub);
  let socket;

  context.after(async () => {
    socket?.terminate();
    gateway.close();
    connectionHub.close();
    const childExited = roomRecord.child.exitCode == null
      ? once(roomRecord.child, 'exit')
      : Promise.resolve();
    roomManager.shutdown();
    await childExited;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');

  socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const connected = waitForJson(socket, (message) => message.type === 'connected');
  await once(socket, 'open');
  await connected;

  const joinedState = waitForJson(socket, (message) => message.type === 'room:joined');
  socket.send(JSON.stringify({ type: 'room:join', roomId: room.id, name: '蘑菇测试员' }));
  const joined = await joinedState;

  const grabbedState = waitForJson(socket, (message) => (
    message.type === 'room:snapshot'
    && actorFrom(message, 'elastic-mushroom-01')?.elasticTether.holderPlayerId
      === joined.player.id
  ));
  socket.send(JSON.stringify({
    type: 'actor:interact',
    actorId: 'elastic-mushroom-01',
    sequence: 1,
  }));
  const grabbed = await grabbedState;
  assert.equal(actorFrom(grabbed, 'elastic-mushroom-01').interactable.enabled, false);

  const releasedState = waitForJson(socket, (message) => {
    if (message.type !== 'room:snapshot') return false;
    const mushroom = actorFrom(message, 'elastic-mushroom-01');
    return mushroom?.elasticTether.holderPlayerId === null
      && mushroom.elasticTether.releaseRevision >= 1;
  });
  let sequence = 0;
  const movement = setInterval(() => {
    sequence += 1;
    socket.send(JSON.stringify({
      type: 'player:input',
      sequence,
      deltaSeconds: 0.05,
      move: { x: 0, z: 1 },
      sprint: true,
      yaw: 0,
    }));
  }, 50);
  const released = await releasedState.finally(() => clearInterval(movement));
  const mushroom = actorFrom(released, 'elastic-mushroom-01');
  assert.equal(mushroom.interactable.enabled, true);
  assert.equal(mushroom.elasticTether.releaseRevision, 1);
});

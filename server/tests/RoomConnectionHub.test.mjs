import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RoomConnectionHub } from '../network/RoomConnectionHub.mjs';

class MockRoomManager extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  joinRoom(roomId, name) {
    this.calls.push(['joinRoom', roomId, name]);
    return {
      room: { id: roomId, name: '测试房间' },
      player: { id: 'player-1', name },
      scene: { id: 'grass-test' },
    };
  }

  leaveRoom(...args) { this.calls.push(['leaveRoom', ...args]); }
  sendInput(...args) { this.calls.push(['sendInput', ...args]); }
  claimActorControl(...args) { this.calls.push(['claimActorControl', ...args]); }
  releaseActorControl(...args) { this.calls.push(['releaseActorControl', ...args]); }
  sendActorInput(...args) { this.calls.push(['sendActorInput', ...args]); }
  sendActorEvent(...args) { this.calls.push(['sendActorEvent', ...args]); }
  interactWithActor(...args) { this.calls.push(['interactWithActor', ...args]); }
}

test('RoomConnectionHub 在传输之外处理会话，并标记广播通道', () => {
  const roomManager = new MockRoomManager();
  const sent = [];
  const hub = new RoomConnectionHub(roomManager);
  const session = hub.openSession((message, channel) => sent.push({ message, channel }));

  assert.deepEqual(sent.shift(), { message: { type: 'connected' }, channel: 'control' });

  session.receive({ type: 'room:join', roomId: 'room-1', name: 'Player' });
  assert.deepEqual(roomManager.calls.shift(), ['joinRoom', 'room-1', 'Player']);
  assert.equal(sent.at(-1).message.type, 'room:joined');
  assert.equal(sent.at(-1).channel, 'control');

  session.receive({ type: 'player:input', sequence: 1 });
  assert.deepEqual(roomManager.calls.shift(), [
    'sendInput',
    'room-1',
    'player-1',
    { type: 'player:input', sequence: 1 },
  ]);

  session.receive({ type: 'actor:event', actorId: 'raft-1', sequence: 1, event: { type: 'damage' } });
  assert.equal(roomManager.calls.shift()[0], 'sendActorEvent');

  session.receive({ type: 'actor:interact', actorId: 'cargo-1', sequence: 1 });
  assert.deepEqual(roomManager.calls.shift(), [
    'interactWithActor',
    'room-1',
    'player-1',
    { type: 'actor:interact', actorId: 'cargo-1', sequence: 1 },
  ]);

  roomManager.emit('snapshot', 'room-1', { tick: 10 });
  assert.deepEqual(sent.at(-1), {
    message: { type: 'room:snapshot', snapshot: { tick: 10 } },
    channel: 'realtime',
  });

  const beforeForeignSnapshot = sent.length;
  roomManager.emit('snapshot', 'room-1', { tick: 11 }, 'player-2');
  assert.equal(sent.length, beforeForeignSnapshot);
  roomManager.emit('snapshot', 'room-1', { tick: 12 }, 'player-1');
  assert.equal(sent.at(-1).message.snapshot.tick, 12);

  roomManager.emit('summary', { id: 'room-1', playerCount: 1 });
  assert.equal(sent.at(-1).channel, 'control');
  assert.equal(sent.at(-1).message.type, 'room:summary');

  session.close();
  assert.deepEqual(roomManager.calls.shift(), ['leaveRoom', 'room-1', 'player-1']);
  hub.close();
});

test('RoomConnectionHub 将未知消息作为可靠错误回复', () => {
  const roomManager = new MockRoomManager();
  const sent = [];
  const hub = new RoomConnectionHub(roomManager);
  const session = hub.openSession((message, channel) => sent.push({ message, channel }));

  session.receive({ type: 'unknown' });
  assert.deepEqual(sent.at(-1), {
    message: { type: 'error', message: '未知消息类型：unknown' },
    channel: 'control',
  });

  session.close();
  hub.close();
});

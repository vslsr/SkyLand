import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonMessageCodec } from '../src/network/MessageCodec.ts';
import { RoomClient, type RoomSummary } from '../src/network/RoomClient.ts';
import { HttpRoomDirectory, type RoomDirectory } from '../src/network/RoomDirectory.ts';
import type {
  GameTransport,
  TransportCapabilities,
  TransportChannel,
  TransportConnectOptions,
  TransportDisconnectListener,
  TransportPacketListener,
  TransportPayload,
  TransportState,
} from '../src/network/transport/GameTransport.ts';
import { WebSocketTransport } from '../src/network/transport/WebSocketTransport.ts';

class MemoryTransport implements GameTransport {
  public readonly capabilities: TransportCapabilities = {
    control: 'reliable-ordered',
    realtime: 'unreliable-sequenced',
    binary: true,
  };

  public state: TransportState = 'disconnected';
  public readonly sent: Array<{ payload: TransportPayload; channel: TransportChannel }> = [];
  public endpoint?: string;
  private readonly packetListeners = new Set<TransportPacketListener>();
  private readonly disconnectListeners = new Set<TransportDisconnectListener>();

  public async connect(options: TransportConnectOptions): Promise<void> {
    this.endpoint = options.endpoint;
    this.state = 'connected';
  }

  public send(payload: TransportPayload, channel: TransportChannel): boolean {
    if (this.state !== 'connected') return false;
    this.sent.push({ payload, channel });
    return true;
  }

  public onPacket(listener: TransportPacketListener): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  public onDisconnect(listener: TransportDisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public close(): void {
    this.state = 'disconnected';
    for (const listener of this.disconnectListeners) listener({});
  }

  public receive(payload: TransportPayload): void {
    for (const listener of this.packetListeners) listener(payload);
  }
}

const room: RoomSummary = {
  id: 'room-1',
  name: '测试房间',
  playerCount: 1,
  capacity: 8,
  sceneId: 'grass-test',
  sceneName: '草地',
  worldSeed: 123,
  createdAt: '2026-08-31T00:00:00.000Z',
  idleExpiresAt: null,
};

const roomDirectory: RoomDirectory = {
  async listRooms() { return [room]; },
  async listScenes() { return []; },
  async createRoom() { return room; },
};

function decodeSent(payload: TransportPayload): Record<string, unknown> {
  const codec = new JsonMessageCodec();
  return codec.decode(payload) as unknown as Record<string, unknown>;
}

test('RoomClient 按消息用途选择 control 与 realtime 通道', async () => {
  const transport = new MemoryTransport();
  const client = new RoomClient({ transport, roomDirectory, endpoint: 'memory://rooms' });

  const joining = client.joinRoom(room.id, 'Player');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.endpoint, 'memory://rooms');
  assert.equal(transport.sent[0]?.channel, 'control');
  assert.equal(decodeSent(transport.sent[0].payload).type, 'room:join');

  transport.receive(JSON.stringify({
    type: 'room:joined',
    room,
    scene: {},
    player: { id: 'player-1', name: 'Player', slot: 0, spawn: { x: 0, z: 0 } },
  }));
  assert.equal((await joining).player.id, 'player-1');

  assert.equal(client.sendPlayerInput([
    { tick: 1, move: { x: 1, z: 0 }, sprint: false, jump: false, yaw: 0 },
    { tick: 2, move: { x: 1, z: 0 }, sprint: false, jump: false, yaw: 0 },
  ]), 2);
  assert.equal(transport.sent.at(-1)?.channel, 'realtime');
  assert.deepEqual(decodeSent(transport.sent.at(-1)!.payload), {
    type: 'player:input',
    inputs: [
      { tick: 1, move: { x: 1, z: 0 }, sprint: false, jump: false, yaw: 0 },
      { tick: 2, move: { x: 1, z: 0 }, sprint: false, jump: false, yaw: 0 },
    ],
  });

  assert.equal(client.sendVesselInput('raft-1', { throttle: 1, steering: 0.25 }), 1);
  assert.equal(transport.sent.at(-1)?.channel, 'realtime');
  assert.equal(decodeSent(transport.sent.at(-1)!.payload).type, 'actor:input');

  assert.equal(client.sendActorDamage('raft-1', 'hull', 5), 1);
  assert.equal(transport.sent.at(-1)?.channel, 'control');
  assert.equal(decodeSent(transport.sent.at(-1)!.payload).type, 'actor:event');

  assert.equal(client.interactWithActor('cargo-1'), 1);
  assert.equal(transport.sent.at(-1)?.channel, 'control');
  assert.equal(decodeSent(transport.sent.at(-1)!.payload).type, 'actor:interact');

  client.setWeather('blizzard');
  assert.equal(transport.sent.at(-1)?.channel, 'control');
  assert.deepEqual(decodeSent(transport.sent.at(-1)!.payload), {
    type: 'weather:set',
    weather: 'blizzard',
  });

  const transformLogStatuses: string[] = [];
  client.onPlayerTransformLogStatus((status) => transformLogStatuses.push(status.status));
  assert.equal(client.startPlayerTransformLog(), true);
  assert.equal(decodeSent(transport.sent.at(-1)!.payload).type, 'debug:transform-log:start');
  transport.receive(JSON.stringify({
    type: 'debug:transform-log:status',
    transformLog: { status: 'started', sessionId: 'session-1' },
  }));
  assert.deepEqual(transformLogStatuses, ['started']);
  const transformEvent = {
    event: 'client.input_packet_sent',
    clientTime: 1,
    clientTimeIso: '1970-01-01T00:00:00.001Z',
    monotonicMs: 1,
    data: { lastTick: 2 },
  };
  assert.equal(client.appendPlayerTransformLog('session-1', [transformEvent]), true);
  assert.equal(
    decodeSent(transport.sent.at(-1)!.payload).type,
    'debug:transform-log:events',
  );
  assert.equal(client.stopPlayerTransformLog('session-1', []), true);
  assert.equal(decodeSent(transport.sent.at(-1)!.payload).type, 'debug:transform-log:stop');
});

test('JSON codec 同时接受文本与二进制传输载荷', () => {
  const codec = new JsonMessageCodec();
  assert.equal(codec.decode('{"type":"connected"}')?.type, 'connected');
  assert.equal(codec.decode(new TextEncoder().encode('{"type":"room:left"}'))?.type, 'room:left');
  assert.equal(codec.decode(new TextEncoder().encode('invalid')), undefined);
});

test('HttpRoomDirectory 使用正确的全局接收者调用原生 fetch', async () => {
  const originalFetch = globalThis.fetch;
  let receiverIsGlobal = false;
  globalThis.fetch = function fetchWithReceiver(this: typeof globalThis) {
    receiverIsGlobal = this === globalThis;
    return Promise.resolve(new Response(JSON.stringify({ scenes: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  } as typeof fetch;

  try {
    const directory = new HttpRoomDirectory();
    assert.deepEqual(await directory.listScenes(), []);
    assert.equal(receiverIsGlobal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class FakeWebSocket {
  public readyState = 0;
  public binaryType: BinaryType = 'blob';
  public readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  public close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  public open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  public receive(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

test('WebSocketTransport 明示可靠能力并复用连接承载两种通道', async () => {
  const socket = new FakeWebSocket();
  const transport = new WebSocketTransport(() => socket as unknown as WebSocket);
  const packets: TransportPayload[] = [];
  transport.onPacket((payload) => packets.push(payload));

  const connecting = transport.connect({ endpoint: 'ws://memory/ws' });
  socket.open();
  await connecting;

  assert.deepEqual(transport.capabilities, {
    control: 'reliable-ordered',
    realtime: 'reliable-ordered',
    binary: true,
  });
  assert.equal(transport.send('control-message', 'control'), true);
  assert.equal(transport.send('realtime-message', 'realtime'), true);
  assert.deepEqual(socket.sent, ['control-message', 'realtime-message']);

  socket.receive('{"type":"connected"}');
  assert.deepEqual(packets, ['{"type":"connected"}']);
  socket.close();
  assert.equal(transport.state, 'disconnected');
});

test('WebSocketTransport 在握手期间关闭时会结束连接 Promise', async () => {
  const socket = new FakeWebSocket();
  const transport = new WebSocketTransport(() => socket as unknown as WebSocket);
  const connecting = transport.connect({ endpoint: 'ws://memory/ws' });

  transport.close();
  await assert.rejects(connecting, /建立前已断开/);
  assert.equal(transport.state, 'disconnected');
});

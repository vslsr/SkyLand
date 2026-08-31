import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { WebSocketGateway } from '../network/WebSocketGateway.mjs';

function nextJson(socket) {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

test('WebSocketGateway 只负责帧适配并把消息交给连接枢纽', async (context) => {
  let sendFromHub;
  let closeCount = 0;
  let sessionIsClosed = false;
  let resolveSessionClosed;
  const sessionClosed = new Promise((resolve) => { resolveSessionClosed = resolve; });
  let resolveReceived;
  const received = new Promise((resolve) => { resolveReceived = resolve; });
  const connectionHub = {
    openSession(send) {
      sendFromHub = send;
      send({ type: 'connected' }, 'control');
      return {
        receive(message) { resolveReceived(message); },
        close() {
          if (sessionIsClosed) return;
          sessionIsClosed = true;
          closeCount += 1;
          resolveSessionClosed();
        },
      };
    },
  };

  const server = http.createServer();
  const gateway = new WebSocketGateway(server, connectionHub);
  let socket;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    socket?.terminate();
    gateway.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  context.after(cleanup);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');

  socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const connected = nextJson(socket);
  await once(socket, 'open');
  assert.deepEqual(await connected, { type: 'connected' });

  socket.send(JSON.stringify({ type: 'room:join', roomId: 'room-1', name: 'Player' }));
  assert.deepEqual(await received, {
    type: 'room:join',
    roomId: 'room-1',
    name: 'Player',
  });

  const snapshot = nextJson(socket);
  sendFromHub({ type: 'room:snapshot', snapshot: { tick: 1 } }, 'realtime');
  assert.deepEqual(await snapshot, { type: 'room:snapshot', snapshot: { tick: 1 } });

  const closed = once(socket, 'close');
  socket.close();
  await closed;
  await sessionClosed;
  assert.equal(closeCount, 1);

  await cleanup();
});

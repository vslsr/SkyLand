import http from 'node:http';
import { RoomProcessManager } from './rooms/RoomProcessManager.mjs';
import { WebSocketGateway } from './network/WebSocketGateway.mjs';

const port = Number(process.env.SKYLAND_SERVER_PORT) || 3090;
const roomManager = new RoomProcessManager({ capacity: 8 });

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, roomCount: roomManager.rooms.size });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      sendJson(response, 200, { rooms: roomManager.listRooms() });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(request);
      const room = await roomManager.createRoom(body.name);
      sendJson(response, 201, { room });
      return;
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)$/i);
    if (request.method === 'DELETE' && roomMatch) {
      const removed = roomManager.removeRoom(roomMatch[1]);
      sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: '房间不存在' });
      return;
    }

    sendJson(response, 404, { error: '接口不存在' });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : '请求处理失败' });
  }
});

const gateway = new WebSocketGateway(server, roomManager);

server.listen(port, '127.0.0.1', () => {
  console.log(`SkyLand room server listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  gateway.close();
  roomManager.shutdown();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

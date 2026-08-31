import { sendJson } from './HttpResponses.mjs';

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

export class ApiRouter {
  constructor(roomManager, options = {}) {
    this.roomManager = roomManager;
    this.sceneCatalog = options.sceneCatalog;
    this.getServerStatus = options.getServerStatus ?? (() => ({}));
  }

  async handle(request, response, url) {
    if (!url.pathname.startsWith('/api/')) return false;

    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/health') {
        const serverStatus = await this.getServerStatus();
        sendJson(
          response,
          200,
          {
            ok: true,
            role: 'web-and-dedicated-server',
            roomCount: this.roomManager.rooms.size,
            ...serverStatus,
          },
          request.method,
        );
        return true;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/rooms') {
        sendJson(response, 200, { rooms: this.roomManager.listRooms() }, request.method);
        return true;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/scenes') {
        sendJson(response, 200, { scenes: this.sceneCatalog.list() }, request.method);
        return true;
      }

      const sceneMatch = url.pathname.match(/^\/api\/scenes\/([a-z0-9-]+)$/i);
      if ((request.method === 'GET' || request.method === 'HEAD') && sceneMatch) {
        const scene = this.sceneCatalog.get(sceneMatch[1]);
        sendJson(response, scene ? 200 : 404, scene ? { scene } : { error: '地图不存在' }, request.method);
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJson(request);
        const room = await this.roomManager.createRoom(body.name, body.sceneId);
        sendJson(response, 201, { room }, request.method);
        return true;
      }

      const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)$/i);
      if (request.method === 'DELETE' && roomMatch) {
        const removed = this.roomManager.removeRoom(roomMatch[1]);
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: '房间不存在' }, request.method);
        return true;
      }

      sendJson(response, 404, { error: '接口不存在' }, request.method);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '请求处理失败' }, request.method);
    }
    return true;
  }
}

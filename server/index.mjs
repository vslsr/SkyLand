import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRouter } from './http/ApiRouter.mjs';
import { applyCrossOriginIsolation } from './http/crossOriginIsolation.mjs';
import { sendJson } from './http/HttpResponses.mjs';
import { StaticWebServer } from './http/StaticWebServer.mjs';
import { RoomProcessManager } from './rooms/RoomProcessManager.mjs';
import { RoomConnectionHub } from './network/RoomConnectionHub.mjs';
import { WebSocketGateway } from './network/WebSocketGateway.mjs';
import { SceneCatalog } from './scenes/SceneCatalog.mjs';

const port = Number(process.env.SKYLAND_SERVER_PORT) || 3090;
const host = process.env.SKYLAND_SERVER_HOST || '0.0.0.0';
const defaultWebRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const webRoot = resolve(process.env.SKYLAND_WEB_ROOT || defaultWebRoot);
const sceneCatalog = await SceneCatalog.load();
const roomManager = new RoomProcessManager({ sceneCatalog });
const staticWebServer = new StaticWebServer(webRoot);
const apiRouter = new ApiRouter(roomManager, {
  sceneCatalog,
  getServerStatus: async () => ({ webReady: await staticWebServer.isReady() }),
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  // 跨源隔离在路由之前统一写入：文档、静态资源、API 与错误响应必须是同一份策略，
  // 只要有一份 HTML 缺了 COOP/COEP，整个页面就拿不到 crossOriginIsolated。
  applyCrossOriginIsolation(response);

  try {
    if (await apiRouter.handle(request, response, url)) return;
    if (await staticWebServer.handle(request, response, url)) return;
    sendJson(response, 404, { error: '资源不存在' }, request.method);
  } catch (error) {
    console.error('HTTP request failed', error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: '服务器内部错误' }, request.method);
    } else {
      response.destroy();
    }
  }
});

const connectionHub = new RoomConnectionHub(roomManager);
const gateway = new WebSocketGateway(server, connectionHub);

server.listen(port, host, async () => {
  const webReady = await staticWebServer.isReady();
  console.log(`SkyLand web + DS server listening on http://${host}:${port}`);
  console.log(webReady ? `Web client root: ${webRoot}` : `Web build missing: run "npm run build" (${webRoot})`);
});

function shutdown() {
  gateway.close();
  connectionHub.close();
  roomManager.shutdown();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

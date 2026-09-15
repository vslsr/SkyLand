import { WebSocket, WebSocketServer } from 'ws';
import { SOCKET_HEARTBEAT_MS } from '../../shared/networkTuning.mjs';

function parseMessage(data) {
  try {
    const message = JSON.parse(data.toString());
    return message && typeof message.type === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

/** 运维后台踢人时用的关闭码（4000-4999 是应用自定义区间）。 */
export const KICKED_CLOSE_CODE = 4001;

/** 连接来源地址：反代后取 X-Forwarded-For 的第一段。 */
function remoteAddressOf(request) {
  const forwarded = String(request?.headers?.['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return forwarded || request?.socket?.remoteAddress || 'unknown';
}

/** WebSocket 传输适配器；所有房间语义由 RoomConnectionHub 处理。 */
export class WebSocketGateway {
  constructor(server, connectionHub) {
    this.connectionHub = connectionHub;
    this.connections = new Map();
    this.webSocketServer = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });

    this.webSocketServer.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.heartbeat = setInterval(() => this.pruneDeadSockets(), SOCKET_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  close() {
    clearInterval(this.heartbeat);
    for (const [socket, connection] of this.connections) {
      connection.session.close();
      socket.close(1001, 'server shutdown');
    }
    this.connections.clear();
    this.webSocketServer.close();
  }

  handleConnection(socket, request) {
    const connection = {
      alive: true,
      session: this.connectionHub.openSession(
        (message, channel) => {
          this.send(socket, message, channel);
        },
        {
          remoteAddress: remoteAddressOf(request),
          // 后台踢人要真把这条连接断掉；只有传输层握着 socket，所以把关门动作交给它。
          closeTransport: (reason) => socket.close(KICKED_CLOSE_CODE, reason),
        },
      ),
    };
    this.connections.set(socket, connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.send(socket, { type: 'error', message: '暂不接受二进制消息' }, 'control');
        return;
      }
      const message = parseMessage(data);
      if (!message) {
        this.send(socket, { type: 'error', message: '消息格式无效' }, 'control');
        return;
      }
      connection.session.receive(message);
    });

    socket.on('close', () => {
      connection.session.close();
      this.connections.delete(socket);
    });
  }

  pruneDeadSockets() {
    for (const [socket, connection] of this.connections) {
      if (!connection.alive) {
        socket.terminate();
        continue;
      }
      connection.alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }

  send(socket, message, _channel) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

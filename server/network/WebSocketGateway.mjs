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

/** WebSocket 传输适配器；所有房间语义由 RoomConnectionHub 处理。 */
export class WebSocketGateway {
  constructor(server, connectionHub) {
    this.connectionHub = connectionHub;
    this.connections = new Map();
    this.webSocketServer = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });

    this.webSocketServer.on('connection', (socket) => this.handleConnection(socket));
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

  handleConnection(socket) {
    const connection = {
      alive: true,
      session: this.connectionHub.openSession((message, channel) => {
        this.send(socket, message, channel);
      }),
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

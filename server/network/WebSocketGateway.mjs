import { WebSocket, WebSocketServer } from 'ws';
import {
  INPUT_MESSAGE_BURST,
  MAXIMUM_INPUT_MESSAGES_PER_SECOND,
  SOCKET_HEARTBEAT_MS,
} from '../../shared/networkTuning.mjs';

function parseMessage(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}

export class WebSocketGateway {
  constructor(server, roomManager) {
    this.roomManager = roomManager;
    this.sessions = new Map();
    this.webSocketServer = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });

    this.webSocketServer.on('connection', (socket) => this.handleConnection(socket));
    roomManager.on('snapshot', (roomId, snapshot) => {
      this.broadcastToRoom(roomId, { type: 'room:snapshot', snapshot });
    });
    roomManager.on('summary', (room) => {
      this.broadcastToRoom(room.id, { type: 'room:summary', room });
    });
    roomManager.on('closed', (roomId) => {
      this.broadcastToRoom(roomId, { type: 'room:closed', message: '房间已经关闭' });
    });

    // 半开连接不会触发 close，靠心跳把占着座位的死连接清掉。
    this.heartbeat = setInterval(() => this.pruneDeadSockets(), SOCKET_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  close() {
    clearInterval(this.heartbeat);
    for (const socket of this.sessions.keys()) socket.close(1001, 'server shutdown');
    this.webSocketServer.close();
  }

  handleConnection(socket) {
    const session = {
      roomId: undefined,
      playerId: undefined,
      alive: true,
      inputTokens: INPUT_MESSAGE_BURST,
      inputTokensAt: Date.now(),
    };
    this.sessions.set(socket, session);
    this.send(socket, { type: 'connected' });

    socket.on('pong', () => {
      session.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendError(socket, '暂不接受二进制消息');
        return;
      }
      const message = parseMessage(data);
      if (!message || typeof message.type !== 'string') {
        this.sendError(socket, '消息格式无效');
        return;
      }
      this.handleMessage(socket, session, message);
    });

    socket.on('close', () => {
      this.leaveCurrentRoom(session);
      this.sessions.delete(socket);
    });
  }

  handleMessage(socket, session, message) {
    try {
      switch (message.type) {
        case 'room:join': {
          this.leaveCurrentRoom(session);
          const joined = this.roomManager.joinRoom(String(message.roomId ?? ''), message.name);
          session.roomId = joined.room.id;
          session.playerId = joined.player.id;
          this.send(socket, { type: 'room:joined', ...joined });
          break;
        }
        case 'room:leave':
          this.leaveCurrentRoom(session);
          this.send(socket, { type: 'room:left' });
          break;
        case 'player:input':
          // 输入频率有上限，超出的直接丢弃，避免单个连接刷爆房间进程。
          if (session.roomId && session.playerId && this.consumeInputToken(session)) {
            this.roomManager.sendInput(session.roomId, session.playerId, message);
          }
          break;
        default:
          this.sendError(socket, `未知消息类型：${message.type}`);
      }
    } catch (error) {
      this.sendError(socket, error instanceof Error ? error.message : '服务器处理失败');
    }
  }

  consumeInputToken(session) {
    const now = Date.now();
    const refill = ((now - session.inputTokensAt) / 1000) * MAXIMUM_INPUT_MESSAGES_PER_SECOND;
    session.inputTokens = Math.min(INPUT_MESSAGE_BURST, session.inputTokens + refill);
    session.inputTokensAt = now;
    if (session.inputTokens < 1) return false;
    session.inputTokens -= 1;
    return true;
  }

  pruneDeadSockets() {
    for (const [socket, session] of this.sessions) {
      if (!session.alive) {
        socket.terminate();
        continue;
      }
      session.alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }

  leaveCurrentRoom(session) {
    if (session.roomId && session.playerId) {
      this.roomManager.leaveRoom(session.roomId, session.playerId);
    }
    session.roomId = undefined;
    session.playerId = undefined;
  }

  broadcastToRoom(roomId, message) {
    for (const [socket, session] of this.sessions) {
      if (session.roomId === roomId) this.send(socket, message);
    }
  }

  sendError(socket, message) {
    this.send(socket, { type: 'error', message });
  }

  send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

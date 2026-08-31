import {
  INPUT_MESSAGE_BURST,
  MAXIMUM_INPUT_MESSAGES_PER_SECOND,
} from '../../shared/networkTuning.mjs';

/**
 * 传输无关的房间连接枢纽。
 * WebSocket、UDP 等网关只负责收发数据包；房间会话、限流与消息路由集中在这里。
 */
export class RoomConnectionHub {
  constructor(roomManager) {
    this.roomManager = roomManager;
    this.sessions = new Set();

    this.handleSnapshot = (roomId, snapshot, playerId) => {
      if (playerId) {
        this.sendToPlayer(roomId, playerId, { type: 'room:snapshot', snapshot }, 'realtime');
      } else {
        this.broadcastToRoom(roomId, { type: 'room:snapshot', snapshot }, 'realtime');
      }
    };
    this.handleSummary = (room) => {
      this.broadcastToRoom(room.id, { type: 'room:summary', room }, 'control');
    };
    this.handleRoomClosed = (roomId) => {
      this.broadcastToRoom(
        roomId,
        { type: 'room:closed', message: '房间已经关闭' },
        'control',
      );
    };

    roomManager.on('snapshot', this.handleSnapshot);
    roomManager.on('summary', this.handleSummary);
    roomManager.on('closed', this.handleRoomClosed);
  }

  openSession(send) {
    const record = {
      send,
      roomId: undefined,
      playerId: undefined,
      inputTokens: INPUT_MESSAGE_BURST,
      inputTokensAt: Date.now(),
      closed: false,
    };
    this.sessions.add(record);
    this.send(record, { type: 'connected' }, 'control');

    return {
      receive: (message) => this.handleMessage(record, message),
      close: () => this.closeSession(record),
    };
  }

  close() {
    this.roomManager.off('snapshot', this.handleSnapshot);
    this.roomManager.off('summary', this.handleSummary);
    this.roomManager.off('closed', this.handleRoomClosed);
    for (const session of Array.from(this.sessions)) this.closeSession(session);
  }

  handleMessage(session, message) {
    if (session.closed) return;

    try {
      switch (message.type) {
        case 'room:join': {
          this.leaveCurrentRoom(session);
          const joined = this.roomManager.joinRoom(String(message.roomId ?? ''), message.name);
          session.roomId = joined.room.id;
          session.playerId = joined.player.id;
          this.send(session, { type: 'room:joined', ...joined }, 'control');
          break;
        }
        case 'room:leave':
          this.leaveCurrentRoom(session);
          this.send(session, { type: 'room:left' }, 'control');
          break;
        case 'player:input':
          if (session.roomId && session.playerId && this.consumeInputToken(session)) {
            this.roomManager.sendInput(session.roomId, session.playerId, message);
          }
          break;
        case 'actor:claim':
          if (session.roomId && session.playerId) {
            this.roomManager.claimActorControl(session.roomId, session.playerId, message.actorId);
          }
          break;
        case 'actor:release':
          if (session.roomId && session.playerId) {
            this.roomManager.releaseActorControl(session.roomId, session.playerId, message.actorId);
          }
          break;
        case 'actor:input':
          if (session.roomId && session.playerId && this.consumeInputToken(session)) {
            this.roomManager.sendActorInput(session.roomId, session.playerId, message);
          }
          break;
        case 'actor:event':
          if (session.roomId && session.playerId && this.consumeInputToken(session)) {
            this.roomManager.sendActorEvent(session.roomId, session.playerId, message);
          }
          break;
        case 'actor:interact':
          if (session.roomId && session.playerId && this.consumeInputToken(session)) {
            this.roomManager.interactWithActor(session.roomId, session.playerId, message);
          }
          break;
        default:
          this.sendError(session, `未知消息类型：${message.type}`);
      }
    } catch (error) {
      this.sendError(session, error instanceof Error ? error.message : '服务器处理失败');
    }
  }

  closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    this.leaveCurrentRoom(session);
    this.sessions.delete(session);
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

  leaveCurrentRoom(session) {
    if (session.roomId && session.playerId) {
      this.roomManager.leaveRoom(session.roomId, session.playerId);
    }
    session.roomId = undefined;
    session.playerId = undefined;
  }

  broadcastToRoom(roomId, message, channel) {
    for (const session of this.sessions) {
      if (session.roomId === roomId) this.send(session, message, channel);
    }
  }

  sendToPlayer(roomId, playerId, message, channel) {
    for (const session of this.sessions) {
      if (session.roomId === roomId && session.playerId === playerId) {
        this.send(session, message, channel);
      }
    }
  }

  sendError(session, message) {
    this.send(session, { type: 'error', message }, 'control');
  }

  send(session, message, channel) {
    if (!session.closed) session.send(message, channel);
  }
}

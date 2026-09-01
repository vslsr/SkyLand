import {
  INPUT_MESSAGE_BURST,
  MAXIMUM_INPUT_MESSAGES_PER_SECOND,
} from '../../shared/networkTuning.mjs';
import { randomUUID } from 'node:crypto';
import { PlayerTransformLogStore } from '../debug/PlayerTransformLogStore.mjs';

/**
 * 传输无关的房间连接枢纽。
 * WebSocket、UDP 等网关只负责收发数据包；房间会话、限流与消息路由集中在这里。
 */
export class RoomConnectionHub {
  constructor(roomManager, options = {}) {
    this.roomManager = roomManager;
    this.transformLogStore = options.transformLogStore ?? new PlayerTransformLogStore();
    this.transformLogSessions = new Map();
    this.sessions = new Set();

    this.handleSnapshot = (roomId, snapshot, playerId) => {
      if (playerId) {
        this.sendToPlayer(roomId, playerId, { type: 'room:snapshot', snapshot }, 'realtime');
      } else {
        this.broadcastToRoom(roomId, { type: 'room:snapshot', snapshot }, 'realtime');
      }
    };
    this.handleTerrain = (roomId, cells, playerId) => {
      if (playerId) {
        this.sendToPlayer(roomId, playerId, { type: 'room:terrain', cells }, 'control');
      } else {
        this.broadcastToRoom(roomId, { type: 'room:terrain', cells }, 'control');
      }
    };
    this.handleSummary = (room) => {
      this.broadcastToRoom(room.id, { type: 'room:summary', room }, 'control');
    };
    this.handleRoomClosed = (roomId) => {
      for (const recording of this.transformLogSessions.values()) {
        if (recording.roomId === roomId) {
          void this.finishPlayerTransformLog(recording.sessionId, 'room-closed');
        }
      }
      this.broadcastToRoom(
        roomId,
        { type: 'room:closed', message: '房间已经关闭' },
        'control',
      );
    };
    this.handleTransformLogEvent = (roomId, playerId, sessionId, event) => {
      const recording = this.transformLogSessions.get(sessionId);
      if (recording?.roomId !== roomId || recording.playerId !== playerId) return;
      this.transformLogStore.appendServer(sessionId, event);
    };
    this.handleTransformLogStopped = (roomId, playerId, sessionId) => {
      const recording = this.transformLogSessions.get(sessionId);
      if (recording?.roomId !== roomId || recording.playerId !== playerId) return;
      void this.finishPlayerTransformLog(sessionId, recording.stopReason ?? 'manual-stop');
    };

    roomManager.on('snapshot', this.handleSnapshot);
    roomManager.on('terrain', this.handleTerrain);
    roomManager.on('summary', this.handleSummary);
    roomManager.on('closed', this.handleRoomClosed);
    roomManager.on('transform-log:event', this.handleTransformLogEvent);
    roomManager.on('transform-log:stopped', this.handleTransformLogStopped);
  }

  openSession(send) {
    const record = {
      send,
      roomId: undefined,
      playerId: undefined,
      inputTokens: INPUT_MESSAGE_BURST,
      inputTokensAt: Date.now(),
      transformLogSessionId: undefined,
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
    for (const recording of Array.from(this.transformLogSessions.values())) {
      void this.finishPlayerTransformLog(recording.sessionId, 'hub-closed');
    }
    for (const session of Array.from(this.sessions)) this.closeSession(session);
    this.roomManager.off('snapshot', this.handleSnapshot);
    this.roomManager.off('terrain', this.handleTerrain);
    this.roomManager.off('summary', this.handleSummary);
    this.roomManager.off('closed', this.handleRoomClosed);
    this.roomManager.off('transform-log:event', this.handleTransformLogEvent);
    this.roomManager.off('transform-log:stopped', this.handleTransformLogStopped);
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
        case 'debug:transform-log:start':
          this.startPlayerTransformLog(session);
          break;
        case 'debug:transform-log:events':
          this.appendPlayerTransformLogEvents(session, message.sessionId, message.events);
          break;
        case 'debug:transform-log:stop':
          this.stopPlayerTransformLog(session, message.sessionId, message.events, 'manual-stop');
          break;
        case 'weather:set':
          if (session.roomId && session.playerId) {
            this.roomManager.setWeather(session.roomId, session.playerId, message.weather);
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
        case 'terrain:edit':
          // 和其它输入共用同一个令牌桶：连点编辑不会绕过限流。
          if (session.roomId && session.playerId && this.consumeInputToken(session)) {
            this.roomManager.editTerrain(session.roomId, session.playerId, message);
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

  startPlayerTransformLog(session) {
    if (!session.roomId || !session.playerId) {
      this.sendPlayerTransformLogStatus(session, {
        status: 'error',
        message: '请先加入房间再开启 Transform 日志',
      });
      return;
    }
    if (session.transformLogSessionId) {
      this.sendPlayerTransformLogStatus(session, {
        status: 'error',
        sessionId: session.transformLogSessionId,
        message: '当前连接已经在录制 Transform 日志',
      });
      return;
    }

    const sessionId = randomUUID();
    const recording = {
      sessionId,
      roomId: session.roomId,
      playerId: session.playerId,
      owner: session,
      stopReason: undefined,
    };
    const room = this.roomManager.getRoom?.(session.roomId);
    if (!this.transformLogStore.begin({
      sessionId,
      roomId: session.roomId,
      sceneId: room?.sceneId,
      playerId: session.playerId,
    })) {
      this.sendPlayerTransformLogStatus(session, {
        status: 'error',
        message: 'Transform 日志会话创建失败',
      });
      return;
    }
    if (!this.roomManager.startPlayerTransformLog(
      session.roomId,
      session.playerId,
      sessionId,
    )) {
      this.transformLogStore.discard(sessionId);
      this.sendPlayerTransformLogStatus(session, {
        status: 'error',
        message: '房间服务进程尚未就绪',
      });
      return;
    }

    session.transformLogSessionId = sessionId;
    this.transformLogSessions.set(sessionId, recording);
    this.sendPlayerTransformLogStatus(session, { status: 'started', sessionId });
  }

  appendPlayerTransformLogEvents(session, sessionId, events) {
    if (session.transformLogSessionId !== sessionId) return false;
    return this.transformLogStore.appendClient(sessionId, events);
  }

  stopPlayerTransformLog(session, sessionId, events, reason) {
    if (session.transformLogSessionId !== sessionId) {
      this.sendPlayerTransformLogStatus(session, {
        status: 'error',
        sessionId: String(sessionId ?? ''),
        message: 'Transform 日志会话不匹配',
      });
      return;
    }
    this.appendPlayerTransformLogEvents(session, sessionId, events);
    const recording = this.transformLogSessions.get(sessionId);
    if (!recording) return;
    recording.stopReason = reason;
    if (!this.roomManager.stopPlayerTransformLog(
      recording.roomId,
      recording.playerId,
      sessionId,
    )) {
      void this.finishPlayerTransformLog(sessionId, reason);
    }
  }

  async finishPlayerTransformLog(sessionId, reason) {
    const recording = this.transformLogSessions.get(sessionId);
    if (!recording) return;
    this.transformLogSessions.delete(sessionId);
    if (recording.owner.transformLogSessionId === sessionId) {
      recording.owner.transformLogSessionId = undefined;
    }
    try {
      const files = await this.transformLogStore.finish(sessionId, reason);
      if (!files || recording.owner.closed) return;
      this.sendPlayerTransformLogStatus(recording.owner, {
        status: 'saved',
        sessionId,
        ...files,
      });
    } catch (error) {
      if (recording.owner.closed) return;
      this.sendPlayerTransformLogStatus(recording.owner, {
        status: 'error',
        sessionId,
        message: error instanceof Error ? error.message : 'Transform 日志写入失败',
      });
    }
  }

  sendPlayerTransformLogStatus(session, transformLog) {
    this.send(session, { type: 'debug:transform-log:status', transformLog }, 'control');
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
    if (session.transformLogSessionId) {
      this.stopPlayerTransformLog(
        session,
        session.transformLogSessionId,
        [],
        session.closed ? 'connection-closed' : 'room-left',
      );
    }
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

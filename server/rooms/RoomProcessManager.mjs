import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSpawnPoint } from '../../shared/playerMovement.mjs';
import { createTemporaryName } from '../../shared/temporaryName.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';

const WORKER_PATH = fileURLToPath(new URL('./room-worker.mjs', import.meta.url));
export const DEFAULT_EMPTY_ROOM_TTL_MS = 60_000;

/**
 * 每个房间一个世界种子。
 *
 * 客户端拿到种子后自己生成地形与物件，静态内容因此完全不需要走网络；
 * 前提是两端跑的是同一套确定性算法（shared/world/chunkContent.mjs）。
 */
function createWorldSeed() {
  return toWorldSeed(randomBytes(4).readUInt32LE(0));
}

function sanitizeText(value, fallback, maximumLength) {
  const text = String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim();
  return (text || fallback).slice(0, maximumLength);
}

export class RoomProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.capacity = options.capacity;
    this.sceneCatalog = options.sceneCatalog;
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? DEFAULT_EMPTY_ROOM_TTL_MS;
    this.rooms = new Map();
    this.shuttingDown = false;
  }

  async createRoom(name, requestedSceneId) {
    if (!this.sceneCatalog) throw new Error('场景目录尚未配置');
    const fallbackSceneId = this.sceneCatalog.list()[0]?.id;
    const sceneDefinition = this.sceneCatalog.require(requestedSceneId || fallbackSceneId);
    const id = randomUUID();
    const record = {
      id,
      name: sanitizeText(name, `草地房间 ${this.rooms.size + 1}`, 28),
      capacity: this.capacity ?? sceneDefinition.capacity,
      sceneId: sceneDefinition.id,
      sceneDefinition,
      worldSeed: createWorldSeed(),
      createdAt: new Date().toISOString(),
      child: undefined,
      players: new Map(),
      pid: undefined,
      idleExpiresAt: undefined,
      idleTimer: undefined,
    };

    const child = fork(WORKER_PATH, [], {
      env: {
        ...process.env,
        SKYLAND_ROOM_ID: record.id,
        SKYLAND_ROOM_NAME: record.name,
        SKYLAND_ROOM_CAPACITY: String(record.capacity),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    record.child = child;
    this.rooms.set(id, record);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('房间进程启动超时'));
      }, 5000);

      const handleMessage = (message) => {
        if (message?.type !== 'room:ready') return;
        record.pid = message.pid;
        cleanup();
        resolve();
      };
      const handleExit = () => {
        cleanup();
        reject(new Error('房间进程未能启动'));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off('message', handleMessage);
        child.off('exit', handleExit);
      };

      child.on('message', handleMessage);
      child.once('exit', handleExit);
      child.send({
        type: 'room:initialize',
        room: { id: record.id, name: record.name, capacity: record.capacity },
        scene: record.sceneDefinition,
        worldSeed: record.worldSeed,
      });
    }).catch((error) => {
      this.rooms.delete(id);
      child.kill('SIGTERM');
      throw error;
    });

    child.on('message', (message) => this.handleWorkerMessage(record, message));
    child.once('exit', (code, signal) => this.handleWorkerExit(record, code, signal));
    this.scheduleEmptyRoomCleanup(record);
    this.emit('summary', this.toSummary(record));
    return this.toSummary(record);
  }

  listRooms() {
    return Array.from(this.rooms.values(), (record) => this.toSummary(record));
  }

  getRoom(roomId) {
    const record = this.rooms.get(roomId);
    return record ? this.toSummary(record) : undefined;
  }

  joinRoom(roomId, requestedName) {
    const record = this.rooms.get(roomId);
    if (!record) throw new Error('房间不存在或已经关闭');
    if (record.players.size >= record.capacity) throw new Error('房间已满');
    this.cancelEmptyRoomCleanup(record);

    const slot = this.allocateSlot(record);
    const player = {
      id: randomUUID(),
      name: sanitizeText(requestedName, createTemporaryName(), 20),
      slot,
      spawn: createSpawnPoint(slot, record.sceneDefinition.gameplay.spawn, record.sceneDefinition.gameplay.bounds),
    };
    record.players.set(player.id, player);
    record.child.send({ type: 'player:join', player });
    const room = this.toSummary(record);
    this.emit('summary', room);
    return { room, player, scene: record.sceneDefinition };
  }

  leaveRoom(roomId, playerId) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.delete(playerId)) return;
    record.child.send({ type: 'player:leave', playerId });
    if (record.players.size === 0) this.scheduleEmptyRoomCleanup(record);
    this.emit('summary', this.toSummary(record));
  }

  sendInput(roomId, playerId, input) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'player:input', playerId, input });
  }

  sendSlimeDrag(roomId, playerId, drag) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'player:slime-drag', playerId, drag });
  }

  toggleBite(roomId, playerId) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'player:bite', playerId });
  }

  startPlayerTransformLog(roomId, playerId, sessionId) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId) || !record.child.connected) return false;
    record.child.send({ type: 'debug:transform-log:start', playerId, sessionId });
    return true;
  }

  stopPlayerTransformLog(roomId, playerId, sessionId) {
    const record = this.rooms.get(roomId);
    if (!record?.child?.connected) return false;
    record.child.send({ type: 'debug:transform-log:stop', playerId, sessionId });
    return true;
  }

  setWeather(roomId, playerId, weather) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'weather:set', playerId, weather });
  }

  giveDebugItem(roomId, playerId, itemType) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'debug:give-item', playerId, itemType });
  }

  setTimeOfDay(roomId, playerId, timeOfDay) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'daynight:set', playerId, timeOfDay });
  }

  /** 取最小的空闲座位号，出生点由座位号决定。 */
  allocateSlot(record) {
    const used = new Set(Array.from(record.players.values(), (player) => player.slot));
    for (let slot = 0; slot < record.capacity; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return record.players.size;
  }

  removeRoom(roomId) {
    const record = this.rooms.get(roomId);
    if (!record) return false;
    this.cancelEmptyRoomCleanup(record);
    this.rooms.delete(roomId);
    record.child.send({ type: 'room:shutdown' });
    this.emit('closed', roomId);
    return true;
  }

  shutdown() {
    this.shuttingDown = true;
    for (const record of this.rooms.values()) {
      this.cancelEmptyRoomCleanup(record);
      record.child.send({ type: 'room:shutdown' });
    }
    this.rooms.clear();
  }

  handleWorkerMessage(record, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'debug:transform-log:event') {
      this.emit(
        'transform-log:event',
        record.id,
        message.playerId,
        message.sessionId,
        message.event,
      );
      return;
    }
    if (message.type === 'debug:transform-log:stopped') {
      this.emit(
        'transform-log:stopped',
        record.id,
        message.playerId,
        message.sessionId,
      );
      return;
    }
    if (message.type === 'room:terrain') {
      this.emit('terrain', record.id, message.cells, message.playerId);
      return;
    }
    if (message.type === 'room:snapshot') {
      this.emit('snapshot', record.id, message.snapshot, message.playerId);
    }
  }

  handleWorkerExit(record, code, signal) {
    if (this.rooms.get(record.id) !== record) return;
    this.cancelEmptyRoomCleanup(record);
    this.rooms.delete(record.id);
    if (!this.shuttingDown) {
      console.warn(`[room ${record.id}] process exited`, { code, signal });
      this.emit('closed', record.id);
    }
  }

  toSummary(record) {
    return {
      id: record.id,
      name: record.name,
      playerCount: record.players.size,
      capacity: record.capacity,
      sceneId: record.sceneId,
      sceneName: record.sceneDefinition.displayName,
      worldSeed: record.worldSeed,
      createdAt: record.createdAt,
      idleExpiresAt: record.idleExpiresAt?.toISOString() ?? null,
    };
  }

  claimActorControl(roomId, playerId, actorId) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'actor:claim', playerId, actorId });
  }

  releaseActorControl(roomId, playerId, actorId) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'actor:release', playerId, actorId });
  }

  sendActorInput(roomId, playerId, input) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'actor:input', playerId, input });
  }

  sendActorEvent(roomId, playerId, event) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'actor:event', playerId, event });
  }

  sendHealthDebugCommand(roomId, playerId, command) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'debug:health', playerId, command });
  }

  editTerrain(roomId, playerId, edit) {
    const record = this.rooms.get(roomId);
    if (!record?.child?.connected) return;
    record.child.send({ type: 'terrain:edit', playerId, edit });
  }

  interactWithActor(roomId, playerId, interaction) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'actor:interact', playerId, interaction });
  }

  sendInventoryCommand(roomId, playerId, command) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'inventory:command', playerId, command });
  }

  sendBuildCommand(roomId, playerId, command) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'build:command', playerId, command });
  }

  scheduleEmptyRoomCleanup(record) {
    this.cancelEmptyRoomCleanup(record);
    if (record.players.size > 0 || this.shuttingDown) return;

    record.idleExpiresAt = new Date(Date.now() + this.emptyRoomTtlMs);
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (this.rooms.get(record.id) === record && record.players.size === 0) {
        this.removeRoom(record.id);
      }
    }, this.emptyRoomTtlMs);
    record.idleTimer.unref?.();
  }

  cancelEmptyRoomCleanup(record) {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    record.idleExpiresAt = undefined;
  }
}

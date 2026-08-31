import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSpawnPoint } from '../../shared/playerMovement.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';

const WORKER_PATH = fileURLToPath(new URL('./room-worker.mjs', import.meta.url));

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
    this.capacity = options.capacity ?? 8;
    this.rooms = new Map();
    this.shuttingDown = false;
  }

  async createRoom(name) {
    const id = randomUUID();
    const record = {
      id,
      name: sanitizeText(name, `草地房间 ${this.rooms.size + 1}`, 28),
      capacity: this.capacity,
      sceneId: 'grassland',
      worldSeed: createWorldSeed(),
      createdAt: new Date().toISOString(),
      child: undefined,
      players: new Map(),
      pid: undefined,
    };

    const child = fork(WORKER_PATH, [], {
      env: {
        ...process.env,
        SKYLAND_ROOM_ID: record.id,
        SKYLAND_ROOM_NAME: record.name,
        SKYLAND_ROOM_CAPACITY: String(record.capacity),
        SKYLAND_SCENE_ID: record.sceneId,
        SKYLAND_WORLD_SEED: String(record.worldSeed),
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
    }).catch((error) => {
      this.rooms.delete(id);
      child.kill('SIGTERM');
      throw error;
    });

    child.on('message', (message) => this.handleWorkerMessage(record, message));
    child.once('exit', (code, signal) => this.handleWorkerExit(record, code, signal));
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

    const slot = this.allocateSlot(record);
    const player = {
      id: randomUUID(),
      name: sanitizeText(requestedName, `旅人-${Math.floor(1000 + Math.random() * 9000)}`, 20),
      slot,
      spawn: createSpawnPoint(slot),
    };
    record.players.set(player.id, player);
    record.child.send({ type: 'player:join', player });
    const room = this.toSummary(record);
    this.emit('summary', room);
    return { room, player };
  }

  leaveRoom(roomId, playerId) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.delete(playerId)) return;
    record.child.send({ type: 'player:leave', playerId });
    this.emit('summary', this.toSummary(record));
  }

  sendInput(roomId, playerId, input) {
    const record = this.rooms.get(roomId);
    if (!record || !record.players.has(playerId)) return;
    record.child.send({ type: 'player:input', playerId, input });
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
    this.rooms.delete(roomId);
    record.child.send({ type: 'room:shutdown' });
    this.emit('closed', roomId);
    return true;
  }

  shutdown() {
    this.shuttingDown = true;
    for (const record of this.rooms.values()) record.child.send({ type: 'room:shutdown' });
    this.rooms.clear();
  }

  handleWorkerMessage(record, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'room:snapshot') this.emit('snapshot', record.id, message.snapshot);
  }

  handleWorkerExit(record, code, signal) {
    if (this.rooms.get(record.id) !== record) return;
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
      worldSeed: record.worldSeed,
      createdAt: record.createdAt,
    };
  }
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOGS_DIRECTORY = fileURLToPath(new URL('../../logs/', import.meta.url));
const DEFAULT_MAXIMUM_EVENTS_PER_SIDE = 20_000;
const MAXIMUM_EVENT_BYTES = 6_000;
const SESSION_ID_PATTERN = /^[a-f0-9-]{16,64}$/i;

function normalizeEvent(value) {
  if (!value || typeof value !== 'object') return undefined;
  const event = String(value.event ?? '').slice(0, 96);
  if (!event) return undefined;
  try {
    const serialized = JSON.stringify({ ...value, event });
    if (Buffer.byteLength(serialized, 'utf8') > MAXIMUM_EVENT_BYTES) return undefined;
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function timestampForFilename(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function toJsonLines(header, events) {
  return `${[header, ...events].map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/**
 * 主服务进程持有的有界录制会话。客户端事件与房间子进程事件最终分别写入
 * logs/*-client.log 和 logs/*-server.log，便于按 sessionId 对齐两条时间线。
 */
export class PlayerTransformLogStore {
  constructor(options = {}) {
    this.logsDirectory = options.logsDirectory ?? DEFAULT_LOGS_DIRECTORY;
    this.maximumEventsPerSide = Math.max(
      1,
      options.maximumEventsPerSide ?? DEFAULT_MAXIMUM_EVENTS_PER_SIDE,
    );
    this.now = options.now ?? (() => Date.now());
    this.sessions = new Map();
  }

  begin({ sessionId, roomId, sceneId, playerId }) {
    if (!SESSION_ID_PATTERN.test(sessionId) || this.sessions.has(sessionId)) return false;
    const startedAt = this.now();
    this.sessions.set(sessionId, {
      sessionId,
      roomId,
      sceneId,
      playerId,
      startedAt,
      clientEvents: [],
      serverEvents: [],
      droppedClientEvents: 0,
      droppedServerEvents: 0,
    });
    return true;
  }

  appendClient(sessionId, events) {
    const session = this.sessions.get(sessionId);
    if (!session || !Array.isArray(events)) return false;
    this.append(session, 'client', events);
    return true;
  }

  appendServer(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.append(session, 'server', [event]);
    return true;
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  discard(sessionId) {
    return this.sessions.delete(sessionId);
  }

  async finish(sessionId, reason = 'manual-stop') {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.sessions.delete(sessionId);

    const stoppedAt = this.now();
    const startedAtIso = new Date(session.startedAt).toISOString();
    const stoppedAtIso = new Date(stoppedAt).toISOString();
    const stem = `player-transform-${timestampForFilename(startedAtIso)}-${sessionId.slice(0, 8)}`;
    const clientFilename = `${stem}-client.log`;
    const serverFilename = `${stem}-server.log`;
    const common = {
      schemaVersion: 1,
      sessionId,
      roomId: session.roomId,
      sceneId: session.sceneId,
      playerId: session.playerId,
      startedAt: startedAtIso,
      stoppedAt: stoppedAtIso,
      reason,
    };

    await mkdir(this.logsDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(this.logsDirectory, clientFilename),
        toJsonLines({
          ...common,
          side: 'client',
          event: 'recording.header',
          droppedEvents: session.droppedClientEvents,
        }, session.clientEvents),
        'utf8',
      ),
      writeFile(
        join(this.logsDirectory, serverFilename),
        toJsonLines({
          ...common,
          side: 'server',
          event: 'recording.header',
          droppedEvents: session.droppedServerEvents,
        }, session.serverEvents),
        'utf8',
      ),
    ]);

    return {
      clientFile: `logs/${clientFilename}`,
      serverFile: `logs/${serverFilename}`,
    };
  }

  append(session, side, events) {
    const target = side === 'client' ? session.clientEvents : session.serverEvents;
    const droppedKey = side === 'client' ? 'droppedClientEvents' : 'droppedServerEvents';
    for (const candidate of events) {
      const event = normalizeEvent(candidate);
      if (!event || target.length >= this.maximumEventsPerSide) {
        session[droppedKey] += 1;
        continue;
      }
      target.push(event);
    }
  }
}

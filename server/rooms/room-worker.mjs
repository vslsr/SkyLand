import { ServerScene } from '../scene/ServerScene.mjs';
import { initServerRapier } from '../physics/rapierRuntime.mjs';
import { SERVER_TICK_RATE, TICKS_PER_SNAPSHOT } from '../../shared/networkTuning.mjs';

let room;
let scene;
let ticker;
let initializing;
const transformRecordings = new Map();

function send(message) {
  if (process.connected) process.send?.(message);
}

function sendSummary() {
  if (!room || !scene) return;
  send({
    type: 'room:summary',
    room: {
      ...room,
      sceneId: scene.id,
      playerCount: scene.players.size,
    },
  });
}

async function initialize(message) {
  if (scene) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const rapier = await initServerRapier();
    if (scene) return;
    room = message.room;
    // 世界种子决定这一局的树和石头长在哪；房间 DS 靠它算出与客户端一致的
    // 静态碰撞，静态内容因此依然一个字节都不用同步。
    scene = new ServerScene(message.scene, {
      worldSeed: message.worldSeed,
      rapier,
      playerTransformDebug: {
        isEnabled: isPlayerTransformDebugEnabled,
        record: recordPlayerTransformDebug,
      },
    });
    ticker = setInterval(() => {
      scene.update();
      if (scene.tick % TICKS_PER_SNAPSHOT === 0) {
        if (scene.players.size === 0) {
          // 保留无连接房间的观测快照，便于监控和子进程集成测试。
          send({ type: 'room:snapshot', snapshot: scene.createSnapshot() });
        } else {
          for (const playerId of scene.players.keys()) {
            const snapshot = scene.createSnapshot(playerId);
            if (isPlayerTransformDebugEnabled(playerId)) {
              const player = snapshot.players.find((candidate) => candidate.id === playerId);
              scene.emitPlayerTransformDebug(playerId, 'server.snapshot_emitted', {
                snapshotTick: snapshot.tick,
                serverTime: snapshot.serverTime,
                authority: player ? {
                  id: player.id,
                  x: player.x,
                  y: player.y,
                  z: player.z,
                  yaw: player.yaw,
                  speed: player.speed,
                  ackTick: player.ackTick,
                  velocityX: player.velocityX,
                  verticalVelocity: player.verticalVelocity,
                  velocityZ: player.velocityZ,
                  grounded: player.grounded,
                } : undefined,
              });
            }
            send({
              type: 'room:snapshot',
              playerId,
              snapshot,
            });
          }
        }
      }
    }, 1000 / SERVER_TICK_RATE);
    send({ type: 'room:ready', pid: process.pid, sceneId: scene.id });
  })();
  try {
    await initializing;
  } finally {
    initializing = undefined;
  }
}

function isPlayerTransformDebugEnabled(playerId) {
  for (const recording of transformRecordings.values()) {
    if (recording.playerId === playerId) return true;
  }
  return false;
}

function recordPlayerTransformDebug(event) {
  for (const [sessionId, recording] of transformRecordings) {
    if (recording.playerId !== event.playerId) continue;
    send({
      type: 'debug:transform-log:event',
      sessionId,
      playerId: recording.playerId,
      event,
    });
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'room:initialize':
      void initialize(message).catch((error) => {
        send({ type: 'room:error', message: error instanceof Error ? error.message : String(error) });
      });
      break;
    case 'player:join': {
      if (!scene) break;
      scene.addPlayer(message.player);
      // 新成员要先拿到别人已经改过的地形，否则他脚下的世界和服务端不是同一个。
      const existing = scene.readTerrainPatches();
      if (existing.length > 0) {
        send({ type: 'room:terrain', playerId: message.player.id, cells: existing });
      }
      sendSummary();
      break;
    }
    case 'player:leave':
      if (!scene) break;
      scene.removePlayer(message.playerId);
      sendSummary();
      break;
    case 'player:input':
      if (!scene) break;
      scene.applyInput(message.playerId, message.input ?? {});
      break;
    case 'player:slime-drag':
      if (!scene) break;
      scene.applySlimeDrag(message.playerId, message.drag);
      break;
    case 'player:bite':
      if (!scene) break;
      scene.toggleBite(message.playerId);
      break;
    case 'debug:transform-log:start':
      if (!scene || !scene.players.has(message.playerId)) break;
      transformRecordings.set(message.sessionId, { playerId: message.playerId });
      scene.emitPlayerTransformDebug(message.playerId, 'server.recording_started', {
        roomId: room?.id,
        sceneId: scene.id,
      });
      break;
    case 'debug:transform-log:stop':
      if (!scene) break;
      if (transformRecordings.get(message.sessionId)?.playerId === message.playerId) {
        scene.emitPlayerTransformDebug(message.playerId, 'server.recording_stopped', {
          roomId: room?.id,
          sceneId: scene.id,
        });
        transformRecordings.delete(message.sessionId);
      }
      send({
        type: 'debug:transform-log:stopped',
        sessionId: message.sessionId,
        playerId: message.playerId,
      });
      break;
    case 'weather:set':
      if (!scene) break;
      scene.setWeather(message.playerId, message.weather);
      break;
    case 'daynight:set':
      if (!scene) break;
      scene.setTimeOfDay(message.playerId, message.timeOfDay);
      break;
    case 'actor:claim':
      if (!scene) break;
      scene.claimActorControl(message.playerId, message.actorId);
      break;
    case 'actor:release':
      if (!scene) break;
      scene.releaseActorControl(message.playerId, message.actorId);
      break;
    case 'actor:input':
      if (!scene) break;
      scene.applyActorInput(message.playerId, message.input ?? {});
      break;
    case 'actor:event':
      if (!scene) break;
      scene.applyActorEvent(message.playerId, message.event ?? {});
      break;
    case 'actor:interact':
      if (!scene) break;
      scene.interactWithActor(message.playerId, message.interaction ?? {});
      break;
    case 'inventory:command':
      if (!scene) break;
      scene.applyInventoryCommand(message.playerId, message.command ?? {});
      break;
    case 'build:command':
      if (!scene) break;
      scene.applyBuildCommand(message.playerId, message.command ?? {});
      break;
    case 'debug:health':
      if (!scene) break;
      scene.applyHealthDebugCommand(message.playerId, message.command ?? {});
      break;
    case 'terrain:edit': {
      if (!scene) break;
      // 没通过校验就是空数组，不广播任何东西——请求方也不会收到确认。
      const cells = scene.editTerrain(message.playerId, message.edit ?? {});
      if (cells.length > 0) send({ type: 'room:terrain', cells });
      break;
    }
    case 'room:shutdown':
      shutdown();
      break;
  }
});

function shutdown() {
  if (ticker) clearInterval(ticker);
  transformRecordings.clear();
  process.exit(0);
}

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);

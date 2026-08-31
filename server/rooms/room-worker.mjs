import { ServerScene } from '../scene/ServerScene.mjs';
import { SERVER_TICK_RATE, TICKS_PER_SNAPSHOT } from '../../shared/networkTuning.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';

const room = {
  id: process.env.SKYLAND_ROOM_ID,
  name: process.env.SKYLAND_ROOM_NAME,
  capacity: Number(process.env.SKYLAND_ROOM_CAPACITY) || 8,
  // 房间的世界种子由大厅进程分配，随房间摘要一起下发给客户端。
  worldSeed: toWorldSeed(process.env.SKYLAND_WORLD_SEED),
};
const scene = new ServerScene(process.env.SKYLAND_SCENE_ID || 'grassland');

function send(message) {
  if (process.connected) process.send?.(message);
}

function sendSummary() {
  send({
    type: 'room:summary',
    room: {
      ...room,
      sceneId: scene.id,
      playerCount: scene.players.size,
    },
  });
}

const ticker = setInterval(() => {
  scene.update();
  if (scene.tick % TICKS_PER_SNAPSHOT === 0) {
    send({ type: 'room:snapshot', snapshot: scene.createSnapshot() });
  }
}, 1000 / SERVER_TICK_RATE);

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'player:join':
      scene.addPlayer(message.player);
      sendSummary();
      break;
    case 'player:leave':
      scene.removePlayer(message.playerId);
      sendSummary();
      break;
    case 'player:input':
      scene.applyInput(message.playerId, message.input ?? {});
      break;
    case 'room:shutdown':
      shutdown();
      break;
  }
});

function shutdown() {
  clearInterval(ticker);
  process.exit(0);
}

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
send({ type: 'room:ready', pid: process.pid });

import { ServerScene } from '../scene/ServerScene.mjs';
import { SERVER_TICK_RATE, TICKS_PER_SNAPSHOT } from '../../shared/networkTuning.mjs';

let room;
let scene;
let ticker;

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

function initialize(message) {
  if (scene) return;
  room = message.room;
  scene = new ServerScene(message.scene);
  ticker = setInterval(() => {
    scene.update();
    if (scene.tick % TICKS_PER_SNAPSHOT === 0) {
      send({ type: 'room:snapshot', snapshot: scene.createSnapshot() });
    }
  }, 1000 / SERVER_TICK_RATE);
  send({ type: 'room:ready', pid: process.pid, sceneId: scene.id });
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'room:initialize':
      initialize(message);
      break;
    case 'player:join':
      if (!scene) break;
      scene.addPlayer(message.player);
      sendSummary();
      break;
    case 'player:leave':
      if (!scene) break;
      scene.removePlayer(message.playerId);
      sendSummary();
      break;
    case 'player:input':
      if (!scene) break;
      scene.applyInput(message.playerId, message.input ?? {});
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
    case 'room:shutdown':
      shutdown();
      break;
  }
});

function shutdown() {
  if (ticker) clearInterval(ticker);
  process.exit(0);
}

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);

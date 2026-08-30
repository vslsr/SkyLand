import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerScene } from '../scene/ServerScene.mjs';

test('ServerScene adds, moves and removes a player', () => {
  const scene = new ServerScene('grassland');
  scene.addPlayer({ id: 'player-1', name: '旅人' });
  scene.applyInput('player-1', {
    sequence: 1,
    move: { x: 1, y: 0, z: -1 },
    look: { yaw: 0.5, pitch: 0.25 },
  });
  scene.update(1);

  const snapshot = scene.createSnapshot();
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.players[0].acknowledgedSequence, 1);
  assert.ok(snapshot.players[0].position.x > 0);
  assert.ok(snapshot.players[0].position.z < 8);

  scene.removePlayer('player-1');
  assert.equal(scene.createSnapshot().players.length, 0);
});

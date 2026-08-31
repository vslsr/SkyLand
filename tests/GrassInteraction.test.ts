import assert from 'node:assert/strict';
import test from 'node:test';
import { GrassInteractionQueue } from '../src/grass/GrassInteraction';

test('grass interaction normalizes direction and clamps public input', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    position: { x: 3, z: -4 },
    direction: { x: 3, z: 4 },
    radius: 20,
    strength: 2,
  });

  assert.deepEqual(queue.drain(), [{
    positionX: 3,
    positionZ: -4,
    directionX: 0.6,
    directionZ: 0.8,
    radius: 4,
    strength: 1,
  }]);
});

test('grass interaction ignores impulses without a direction', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    position: { x: 0, z: 0 },
    direction: { x: 0, z: 0 },
  });
  assert.deepEqual(queue.drain(), []);
});

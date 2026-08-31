import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Actor } from '../shared/actor/Actor.mjs';
import {
  GRASS_DISPLACEMENT_COMPONENT,
  GrassDisplacementComponent,
} from '../src/actors/components/GrassDisplacementComponent';
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
    startPositionX: 3,
    startPositionZ: -4,
    directionX: 0.6,
    directionZ: 0.8,
    radius: 4,
    strength: 1,
    radial: false,
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

test('radial grass interaction does not require a movement direction', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    mode: 'radial',
    position: { x: 2, z: -1 },
    radius: 0.7,
    strength: 0.25,
  });

  assert.deepEqual(queue.drain(), [{
    positionX: 2,
    positionZ: -1,
    startPositionX: 2,
    startPositionZ: -1,
    directionX: 1,
    directionZ: 0,
    radius: 0.7,
    strength: 0.25,
    radial: true,
  }]);
});

test('radial grass interaction normalizes its center fallback direction', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    mode: 'radial',
    position: { x: 2, z: -1 },
    direction: { x: 3, z: 4 },
  });

  const [impulse] = queue.drain();
  assert.equal(impulse.directionX, 0.6);
  assert.equal(impulse.directionZ, 0.8);
});

test('grass displacement component keeps pressing while its actor remains stationary', () => {
  const queue = new GrassInteractionQueue();
  const root = new THREE.Group();
  root.position.set(3, 0, -4);
  const actor = new Actor('slime-test', 'player-slime');
  const component = actor.addComponent(new GrassDisplacementComponent(root, queue, {
    radius: 0.72,
    pressurePerSecond: 3,
  })) as GrassDisplacementComponent;

  component.update(1 / 60);
  const firstPressure = queue.drain();
  component.update(1 / 60);
  const sustainedPressure = queue.drain();

  assert.equal(actor.hasComponents(GRASS_DISPLACEMENT_COMPONENT), true);
  assert.equal(firstPressure.length, 1);
  assert.equal(sustainedPressure.length, 1);
  assert.equal(firstPressure[0].radial, true);
  assert.deepEqual(
    [sustainedPressure[0].positionX, sustainedPressure[0].positionZ],
    [3, -4],
  );
  assert.ok(Math.abs(firstPressure[0].strength - sustainedPressure[0].strength) < 1e-9);
});

test('grass displacement component emits one continuous capsule along movement', () => {
  const queue = new GrassInteractionQueue();
  const root = new THREE.Group();
  const component = new GrassDisplacementComponent(root, queue, {
    radius: 0.72,
    pressurePerSecond: 3,
  });

  component.update(1 / 60);
  queue.drain();
  root.position.set(1.5, 0, 2);
  component.update(1 / 60);
  const [pressure] = queue.drain();

  assert.deepEqual(
    [
      pressure.startPositionX,
      pressure.startPositionZ,
      pressure.positionX,
      pressure.positionZ,
    ],
    [0, 0, 1.5, 2],
  );
  assert.equal(pressure.radial, true);
  assert.ok(Math.abs(pressure.directionX - 0.6) < 1e-9);
  assert.ok(Math.abs(pressure.directionZ - 0.8) < 1e-9);
  assert.ok(pressure.strength > 0.24);
});

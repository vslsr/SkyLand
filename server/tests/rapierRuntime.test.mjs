import test from 'node:test';
import assert from 'node:assert/strict';
import { initRapier } from '../../shared/physics/RapierRuntime.mjs';
import { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';

test('Rapier initialization is idempotent', async () => {
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return import('@dimforge/rapier3d-compat');
  };
  const [first, second] = await Promise.all([initRapier(loader), initRapier(loader)]);
  assert.equal(first, second);
  assert.equal(loads, 1);
});

test('PhysicsWorld replaces and removes bounded collider groups', async () => {
  const rapier = await initRapier(() => import('@dimforge/rapier3d-compat'));
  const physics = new PhysicsWorld(rapier);
  const floor = {
    vertices: new Float32Array([-2, 0, -2, -2, 0, 2, 2, 0, 2, 2, 0, -2]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  physics.setChunkCollider('0:0', floor);
  assert.equal(physics.colliderCount, 1);
  physics.setChunkCollider('0:0', floor);
  assert.equal(physics.colliderCount, 1);
  physics.setActorCollider('rock', {
    shape: 'box', halfWidth: 0.4, halfLength: 0.4,
    minimumY: 0, maximumY: 0.6, x: 1, y: 0, z: 1, yaw: 0,
  });
  assert.equal(physics.colliderCount, 2);
  physics.removeActorCollider('rock');
  physics.removeChunkCollider('0:0');
  assert.equal(physics.colliderCount, 0);
  physics.dispose();
});

test('new colliders become visible to KCC queries only after step', async () => {
  const rapier = await initRapier(() => import('@dimforge/rapier3d-compat'));
  const physics = new PhysicsWorld(rapier);
  physics.setChunkCollider('floor', {
    vertices: new Float32Array([-2, 0, -2, -2, 0, 2, 2, 0, 2, 2, 0, -2]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  physics.createCharacter('player', { x: 0, y: 0, z: 0, radius: 0.42, halfHeight: 0.42 });
  const before = physics.computeCharacterMovement('player', { x: 0, y: -0.1, z: 0 });
  assert.equal(before.grounded, false);

  physics.setCharacterTranslation('player', { x: 0, y: 0, z: 0 });
  physics.step();
  const after = physics.computeCharacterMovement('player', { x: 0, y: -0.1, z: 0 });
  assert.equal(after.grounded, true);
  assert.ok(after.movement.y > -0.001);
  physics.dispose();
});

test('Rapier camera sphere cast sees CAMERA-only authoring', async () => {
  const rapier = await initRapier(() => import('@dimforge/rapier3d-compat'));
  const physics = new PhysicsWorld(rapier);
  physics.setActorCollider('camera-only', {
    shape: 'box', x: 0, y: 0, z: 2, yaw: 0,
    halfWidth: 1, halfLength: 0.2, minimumY: 0, maximumY: 3,
    layers: 2,
  });
  physics.prepareQueries();
  const ratio = physics.castCameraSphere([0, 1, 0], [0, 1, 5], 0.2);
  assert.ok(ratio > 0 && ratio < 0.5, `unexpected camera hit ratio ${ratio}`);
  physics.dispose();
});

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

/**
 * 只挪位姿、不删了重建：主线程每帧把所有 Actor 碰撞体重建一遍是 `sim-colliders`
 * 那几毫秒的来源。挪过去的碰撞体必须在新位置上挡得住角色，旧位置上不再挡。
 */
test('moveActorCollider moves an existing collider without rebuilding it', async () => {
  const rapier = await initRapier(() => import('@dimforge/rapier3d-compat'));
  const physics = new PhysicsWorld(rapier);
  physics.setChunkCollider('floor', {
    vertices: new Float32Array([-8, 0, -8, -8, 0, 8, 8, 0, 8, 8, 0, -8]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const definition = {
    shape: 'box', halfWidth: 0.5, halfLength: 0.5,
    minimumY: 0, maximumY: 1, x: 2, y: 0, z: 0, yaw: 0,
  };
  physics.setActorCollider('rock', definition);
  physics.createCharacter('player', { x: 0, y: 0.5, z: 0, radius: 0.4, halfHeight: 0.4 });
  const colliderCount = physics.colliderCount;
  physics.prepareQueries();
  const blocked = physics.computeCharacterMovement('player', { x: 3, y: 0, z: 0 });
  assert.ok(blocked.movement.x < 1.5, `石头在 x=2 时应当挡住：走了 ${blocked.movement.x}`);

  // 没登记过的、数量不符的都挪不动，交给 setActorCollider 重建。
  assert.equal(physics.moveActorCollider('nobody', definition), false);
  assert.equal(physics.moveActorCollider('rock', [definition, definition]), false);

  assert.equal(physics.moveActorCollider('rock', { ...definition, x: 2, z: 5 }), true);
  assert.equal(physics.colliderCount, colliderCount, '挪不新建');
  physics.setCharacterTranslation('player', { x: 0, y: 0.5, z: 0 });
  physics.prepareQueries();
  const free = physics.computeCharacterMovement('player', { x: 3, y: 0, z: 0 });
  assert.ok(free.movement.x > 2.5, `石头挪走之后不该再挡：走了 ${free.movement.x}`);
  physics.setCharacterTranslation('player', { x: 0, y: 0.5, z: 5 });
  physics.prepareQueries();
  const blockedAgain = physics.computeCharacterMovement('player', { x: 3, y: 0, z: 0 });
  assert.ok(blockedAgain.movement.x < 1.5, `石头在新位置上应当挡住：走了 ${blockedAgain.movement.x}`);
  physics.dispose();
});

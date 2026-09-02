import test from 'node:test';
import assert from 'node:assert/strict';
import { initRapier } from '../../shared/physics/RapierRuntime.mjs';
import { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';

/**
 * 钉住 `PhysicsWorld` 的惰性 step 语义（引擎迁移路线图 第 0.5 步）。
 *
 * `step()` 上那句 `do not remove this apparently empty tick` 描述的是一条隐含契约：
 * Rapier 的新 collider 要等一次 `world.step()` 之后才对查询可见，所以查询入口
 * 靠 `prepareQueries()` 补跑一步。这类「空 step 其实有意义」的地方最容易在迁移
 * 时被当成冗余删掉，而症状是「偶尔查不到刚加的碰撞体」，不是崩溃。
 *
 * 观测手段全是黑箱的：`castCameraSphere()` 会调 `prepareQueries()`，
 * `castRay()` 不会。两者的差值就是「这一步到底跑没跑」。
 */

const FLOOR = {
  vertices: new Float32Array([-4, 0, -4, -4, 0, 4, 4, 0, 4, 4, 0, -4]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

async function createWorld(options) {
  const rapier = await initRapier(() => import('@dimforge/rapier3d-compat'));
  return new PhysicsWorld(rapier, options);
}

/** 从上往下打一条射线，返回是否命中——castRay 不会自己补 step。 */
function raycastFloor(physics) {
  return physics.castRay({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, 5) !== undefined;
}

test('新 collider 在补跑一步之前对查询不可见', async () => {
  const physics = await createWorld();
  try {
    physics.setChunkCollider('floor', FLOOR);
    assert.equal(raycastFloor(physics), false, '未 step 时新 collider 不应可见');

    physics.step();
    assert.equal(raycastFloor(physics), true, 'step 之后同一条射线必须命中');
  } finally {
    physics.dispose();
  }
});

test('prepareQueries 只在脏的时候补跑，跑完即清标记', async () => {
  const physics = await createWorld();
  try {
    physics.setChunkCollider('floor', FLOOR);
    // castCameraSphere 内部会 prepareQueries：这一次调用兑现了那个空 tick。
    physics.castCameraSphere([0, 1, -3], [0, 1, 3], 0.2);
    assert.equal(raycastFloor(physics), true, 'prepareQueries 应当已经补跑过一步');

    // 已经不脏了：再查一次不能再偷偷推进世界。用一个下落中的刚体当探针——
    // 多跑一步它就会多掉一截。
    physics.createDynamicActor('probe', { x: 0, y: 3, z: 0, radius: 0.2, linearDamping: 0 });
    physics.setDynamicActorVelocity('probe', { x: 0, y: -1, z: 0 });
    physics.prepareQueries();
    const settled = physics.getDynamicActorState('probe').position.y;
    physics.prepareQueries();
    physics.prepareQueries();
    assert.equal(
      physics.getDynamicActorState('probe').position.y,
      settled,
      '标记已清空时 prepareQueries 必须是纯查询，不能推进刚体',
    );
  } finally {
    physics.dispose();
  }
});

test('prepareQueries 补跑的是真实一步，会推进动态刚体', async () => {
  // 这是惰性 step 最容易被忽略的副作用：一次「只读」的查询会让世界前进一个
  // timestep。迁移到 worker、把查询挪到别的线程时，这条必须原样保留，
  // 否则同一段玩法代码在两端会得到不同的轨迹。
  const timestep = 1 / 20;
  const physics = await createWorld({ timestep });
  try {
    physics.createDynamicActor('probe', { x: 0, y: 5, z: 0, radius: 0.2, linearDamping: 0 });
    physics.setDynamicActorVelocity('probe', { x: 0, y: -2, z: 0 });
    const before = physics.getDynamicActorState('probe').position.y;

    physics.prepareQueries();
    const after = physics.getDynamicActorState('probe').position.y;
    assert.ok(
      Math.abs((before - after) - 2 * timestep) < 1e-6,
      `查询应恰好推进一个 timestep，实际位移 ${before - after}`,
    );
  } finally {
    physics.dispose();
  }
});

test('每一类碰撞体变更都会重新置脏', async () => {
  const physics = await createWorld();
  try {
    const mutations = [
      ['setChunkCollider', () => physics.setChunkCollider('floor', FLOOR)],
      ['removeChunkCollider', () => physics.removeChunkCollider('floor')],
      ['setActorCollider', () => physics.setActorCollider('rock', {
        shape: 'box', x: 0, y: 0, z: 0, yaw: 0,
        halfWidth: 0.4, halfLength: 0.4, minimumY: 0, maximumY: 0.6,
      })],
      ['removeActorCollider', () => physics.removeActorCollider('rock')],
      ['setStaticColliderGroup', () => physics.setStaticColliderGroup('props', [{
        id: 'stump', shape: 'box', x: 1, y: 0, z: 1, yaw: 0,
        halfWidth: 0.3, halfLength: 0.3, minimumY: 0, maximumY: 0.5,
      }])],
      ['removeStaticColliderGroup', () => physics.removeStaticColliderGroup('props')],
      ['createCharacter', () => physics.createCharacter('player', {
        x: 0, y: 1, z: 0, radius: 0.42, halfHeight: 0.42,
      })],
      ['setCharacterTranslation', () => physics.setCharacterTranslation('player', {
        x: 0, y: 1, z: 0,
      })],
      ['removeCharacter', () => physics.removeCharacter('player')],
    ];

    for (const [name, mutate] of mutations) {
      // 用下落刚体做探针：置脏了，下一次 prepareQueries 就必须补跑一步。
      physics.createDynamicActor('probe', { x: 3, y: 5, z: 3, radius: 0.1, linearDamping: 0 });
      physics.setDynamicActorVelocity('probe', { x: 0, y: -2, z: 0 });
      physics.prepareQueries();
      const settled = physics.getDynamicActorState('probe').position.y;

      mutate();
      physics.prepareQueries();
      assert.ok(
        physics.getDynamicActorState('probe').position.y < settled - 1e-9,
        `${name} 之后 prepareQueries 没有补跑，新的碰撞体对查询不可见`,
      );
      physics.removeDynamicActor('probe');
    }
  } finally {
    physics.dispose();
  }
});

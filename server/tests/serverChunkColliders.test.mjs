import assert from 'node:assert/strict';
import test from 'node:test';
import { CollisionWorld } from '../../shared/collision/CollisionWorld.mjs';
import { ServerChunkColliders } from '../scene/ServerChunkColliders.mjs';
import { CHUNK_SIZE, MAXIMUM_CHUNK_COORDINATE } from '../../shared/world/worldConfig.mjs';

const SEED = 0x5c1a2d0b;

function createResidency(options = {}) {
  const world = new CollisionWorld();
  return {
    world,
    residency: new ServerChunkColliders({ world, worldSeed: SEED, ...options }),
  };
}

test('常驻集合是玩家所在 chunk 周围的一圈，数量与世界面积无关', () => {
  const { world, residency } = createResidency();
  residency.sync([{ x: 0, z: 0 }]);
  assert.equal(residency.residentCount, 9);
  assert.ok(world.colliderCount > 0);
  assert.equal(world.staticGroupCount, 9);
});

test('走远之后旧 chunk 被卸载，keepRadius 提供了迟滞', () => {
  const { world, residency } = createResidency();
  residency.sync([{ x: 1, z: 1 }]);
  assert.equal(world.hasStaticGroup('0:0'), true);

  // 只走出一圈：新的 3×3 进来，出生地还在 keepRadius 之内，先留着不拆。
  residency.sync([{ x: CHUNK_SIZE + 1, z: CHUNK_SIZE + 1 }]);
  assert.equal(world.hasStaticGroup('0:0'), true);

  // 走远之后出生地那一片彻底出了 keepRadius，常驻数量回到一名玩家的量级。
  residency.sync([{ x: CHUNK_SIZE * 6 + 1, z: CHUNK_SIZE * 6 + 1 }]);
  assert.equal(world.hasStaticGroup('0:0'), false);
  assert.ok(residency.residentCount <= 25, `常驻 ${residency.residentCount} 个 chunk`);
});

test('没有人跨过 chunk 边界时 sync 不做任何事', () => {
  const { world, residency } = createResidency();
  residency.sync([{ x: 1, z: 1 }]);
  const before = world.colliderCount;
  let inserted = 0;
  const originalSet = world.setStaticGroup.bind(world);
  world.setStaticGroup = (key, instances) => {
    inserted += 1;
    originalSet(key, instances);
  };
  residency.sync([{ x: 2, z: 2 }]);
  residency.sync([{ x: 3, z: 3 }]);
  assert.equal(inserted, 0);
  assert.equal(world.colliderCount, before);
});

test('多名玩家各自带一片常驻区，互相不会把对方的卸载掉', () => {
  const { residency } = createResidency();
  const far = CHUNK_SIZE * 6 + 1;
  residency.sync([{ x: 0, z: 0 }, { x: far, z: far }]);
  assert.equal(residency.residentCount, 18);
});

test('世界边缘之外不生成 chunk', () => {
  const { residency } = createResidency();
  const edge = MAXIMUM_CHUNK_COORDINATE * CHUNK_SIZE + 1;
  residency.sync([{ x: edge, z: edge }]);
  // 角落只有 2×2 个 chunk 落在世界内。
  assert.equal(residency.residentCount, 4);
});

test('ensureAround 把还没轮到 sync 的那一片补上，重复调用不做无用功', () => {
  const { world, residency } = createResidency();
  residency.ensureAround(0, 0);
  assert.equal(residency.residentCount, 9);
  const before = world.colliderCount;
  residency.ensureAround(1, 1);
  assert.equal(world.colliderCount, before);
});

test('非流式场景不登记任何静态碰撞体', () => {
  const { world, residency } = createResidency({ enabled: false });
  residency.sync([{ x: 0, z: 0 }]);
  residency.ensureAround(0, 0);
  assert.equal(residency.residentCount, 0);
  assert.equal(world.colliderCount, 0);
});

test('clear 把这一份静态碰撞全部撤走', () => {
  const { world, residency } = createResidency();
  residency.sync([{ x: 0, z: 0 }]);
  residency.clear();
  assert.equal(residency.residentCount, 0);
  assert.equal(world.colliderCount, 0);
});

test('树 override 只重建所在 chunk，并在卸载重载后继续生效', () => {
  const { world, residency } = createResidency();
  residency.ensureAround(0, 0);
  const before = world.colliderCount;
  assert.equal(residency.setPropSkipped(0, 0, 0, true), true);
  assert.equal(residency.skippedPropCount, 1);
  assert.ok(world.colliderCount <= before);
  assert.equal(residency.setPropSkipped(0, 0, 0, true), false);

  residency.sync([{ x: CHUNK_SIZE * 6 + 1, z: CHUNK_SIZE * 6 + 1 }]);
  residency.ensureAround(0, 0);
  assert.equal(residency.getSkipMask(0, 0).low & 1, 1);
});

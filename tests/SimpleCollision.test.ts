import assert from 'node:assert/strict';
import test from 'node:test';
import {
  circleTouchesSimpleCollision,
  createSimpleCollisionDefinition,
  createSimpleCollisionFromRender,
  resolveCircleAgainstSimpleCollision,
  resolveCircleAgainstSimpleCollisions,
} from '../shared/actor/simpleCollision.mjs';

test('Actor 模型尺寸会生成稳定的简易碰撞盒', () => {
  const crate = createSimpleCollisionFromRender({
    model: 'line-art-cargo-crate',
    width: 0.9,
    length: 1.1,
    height: 0.72,
  });
  assert.equal(crate.halfWidth, 0.49);
  assert.ok(Math.abs(crate.halfLength - 0.59) < 1e-12);
  assert.equal(crate.minimumY, 0);
  assert.ok(crate.maximumY > 0.6);

  const pbfSlime = createSimpleCollisionFromRender({
    model: 'line-art-pbf-slime',
    radius: 0.95,
    collisionRadius: 0.52,
    collisionHeight: 0.72,
  });
  assert.equal(pbfSlime.halfWidth, 0.52);
  assert.equal(pbfSlime.halfLength, 0.52);
  assert.equal(pbfSlime.shape, 'cylinder');
  assert.equal(pbfSlime.minimumY, 0);
  assert.equal(pbfSlime.maximumY, 0.72);
});

test('圆柱按圆形截面推出，不会在外接方盒的四角形成隐形墙', () => {
  const collision = createSimpleCollisionDefinition({
    shape: 'cylinder',
    halfWidth: 1,
    halfLength: 1,
    minimumY: 0,
    maximumY: 1,
  });
  const instance = { collision, transform: { x: 0, z: 0, yaw: 0 } };

  // 到圆心 1.697m，已经在圆柱半径 1m + 移动体半径 0.5m 之外；
  // 若误用 2x2 方盒，这个位置仍会被盒角挡住。
  assert.deepEqual(
    resolveCircleAgainstSimpleCollision({ x: 1.2, z: 1.2 }, 0.5, instance),
    { x: 1.2, z: 1.2 },
  );

  const resolved = resolveCircleAgainstSimpleCollision({ x: 1, z: 1 }, 0.5, instance);
  assert.ok(Math.abs(Math.hypot(resolved.x, resolved.z) - 1.5) < 1e-9);
  assert.ok(Math.abs(resolved.x - resolved.z) < 1e-9);
});

test('圆形移动体会从带 yaw 的 Actor 有向盒最近侧面推出', () => {
  const collision = createSimpleCollisionDefinition({
    halfWidth: 1,
    halfLength: 2,
    minimumY: 0,
    maximumY: 1,
  });
  const instance = {
    collision,
    transform: { x: 0, z: 0, yaw: Math.PI / 2 },
  };
  const resolved = resolveCircleAgainstSimpleCollision({ x: 2.2, z: 0 }, 0.5, instance);
  assert.ok(Math.abs(resolved.x - 2.5) < 1e-9);
  assert.ok(Math.abs(resolved.z) < 1e-9);
  assert.equal(circleTouchesSimpleCollision(resolved, 0.5, instance), true);
});

test('完全位于盒内时仍能稳定推出，多个碰撞体的迭代次数保持固定', () => {
  const collision = createSimpleCollisionDefinition({
    halfWidth: 1,
    halfLength: 1,
    minimumY: 0,
    maximumY: 1,
  });
  const resolved = resolveCircleAgainstSimpleCollisions({ x: 0, z: 0 }, 0.42, [{
    collision,
    transform: { x: 0, z: 0, yaw: 0 },
  }]);
  assert.ok(Math.abs(resolved.x + 1.42) < 1e-9);
  assert.equal(resolved.z, 0);
});

test('玩家只被高于可跨越高度且与身体垂直重叠的 Actor 挡住', () => {
  const lowStep = {
    collision: createSimpleCollisionDefinition({
      halfWidth: 1,
      halfLength: 1,
      minimumY: 0,
      maximumY: 0.12,
    }),
    transform: { x: 0, y: 0, z: 0, yaw: 0 },
  };
  const profile = { minimumY: 0, maximumY: 0.84, maximumStepHeight: 0.2 };
  assert.deepEqual(
    resolveCircleAgainstSimpleCollisions({ x: 0, z: 0 }, 0.42, [lowStep], profile),
    { x: 0, z: 0 },
  );

  const wall = {
    ...lowStep,
    collision: createSimpleCollisionDefinition({
      halfWidth: 1,
      halfLength: 1,
      minimumY: 0,
      maximumY: 1,
    }),
  };
  const blocked = resolveCircleAgainstSimpleCollisions(
    { x: 0, z: 0 },
    0.42,
    [wall],
    profile,
  );
  assert.ok(Math.abs(blocked.x + 1.42) < 1e-9);

  const floating = {
    ...wall,
    collision: createSimpleCollisionDefinition({
      halfWidth: 1,
      halfLength: 1,
      minimumY: 1.2,
      maximumY: 2,
    }),
  };
  assert.deepEqual(
    resolveCircleAgainstSimpleCollisions({ x: 0, z: 0 }, 0.42, [floating], profile),
    { x: 0, z: 0 },
  );
});

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

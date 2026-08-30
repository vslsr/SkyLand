import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_BOUNDS,
  PLAYER_MAXIMUM_SPEED,
  PLAYER_MOVE_SPEED,
  SPAWN_SLOT_COUNT,
  applyPlayerMovement,
  createSpawnPoint,
  lerpAngle,
  normalizeAngle,
  sanitizeMoveInput,
} from '../../shared/playerMovement.mjs';

test('相同输入在两端得到相同位置', () => {
  const input = { x: 0.6, z: -0.8, sprint: false };
  const browserSide = applyPlayerMovement({ x: 0, z: 0 }, input, 0.05);
  const serverSide = applyPlayerMovement({ x: 0, z: 0 }, input, 0.05);
  assert.deepEqual(browserSide, serverSide);
  assert.ok(Math.abs(Math.hypot(browserSide.x, browserSide.z) - PLAYER_MOVE_SPEED * 0.05) < 1e-9);
});

test('加速只放大到约定的倍率', () => {
  const walking = applyPlayerMovement({ x: 0, z: 0 }, { x: 1, z: 0, sprint: false }, 1);
  const sprinting = applyPlayerMovement({ x: 0, z: 0 }, { x: 1, z: 0, sprint: true }, 1);
  assert.ok(Math.abs(walking.x - PLAYER_MOVE_SPEED) < 1e-9);
  assert.ok(Math.abs(sprinting.x - PLAYER_MAXIMUM_SPEED) < 1e-9);
});

test('超长方向向量被归一化', () => {
  const sanitized = sanitizeMoveInput({ x: 30, z: 40 });
  assert.ok(Math.abs(Math.hypot(sanitized.x, sanitized.z) - 1) < 1e-9);
});

test('位置始终被限制在活动范围内', () => {
  const moved = applyPlayerMovement({ x: PLAYER_BOUNDS.maximumX, z: 0 }, { x: 1, z: 0, sprint: true }, 10);
  assert.equal(moved.x, PLAYER_BOUNDS.maximumX);
});

test('朝向被收敛到 [-π, π] 并沿最短弧插值', () => {
  assert.ok(Math.abs(normalizeAngle(Math.PI * 7)) - Math.PI < 1e-9);
  assert.ok(normalizeAngle(Math.PI * 2 + 0.3) - 0.3 < 1e-9);

  // 从 -3.0 到 3.0 走的是跨越 ±π 的短弧，而不是绕回去的长弧。
  const stepped = lerpAngle(-3.0, 3.0, 0.5);
  assert.ok(Math.abs(stepped) > 3.0);
});

test('每个座位号的出生点互不重叠且落在活动范围内', () => {
  const points = [];
  for (let slot = 0; slot < SPAWN_SLOT_COUNT; slot += 1) {
    const point = createSpawnPoint(slot);
    assert.ok(point.x >= PLAYER_BOUNDS.minimumX && point.x <= PLAYER_BOUNDS.maximumX);
    assert.ok(point.z >= PLAYER_BOUNDS.minimumZ && point.z <= PLAYER_BOUNDS.maximumZ);
    for (const other of points) {
      assert.ok(Math.hypot(point.x - other.x, point.z - other.z) > 0.8);
    }
    points.push(point);
  }
});

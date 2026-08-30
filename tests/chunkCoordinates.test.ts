import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_HALF_SIZE,
  CHUNK_SIZE,
  chunkCenter,
  chunkDistance,
  chunkKey,
  isSpawnChunk,
  listChunksInRadius,
  toChunkAxis,
  toChunkCoordinate,
} from '../shared/chunkCoordinates.mjs';

test('分块以原点为中心对齐，出生地覆盖原点四周', () => {
  assert.equal(toChunkAxis(0), 0);
  assert.equal(toChunkAxis(CHUNK_HALF_SIZE - 0.001), 0);
  assert.equal(toChunkAxis(-CHUNK_HALF_SIZE), 0);
  assert.equal(toChunkAxis(CHUNK_HALF_SIZE), 1);
  assert.equal(toChunkAxis(-CHUNK_HALF_SIZE - 0.001), -1);
});

test('出生地包含现有手工场景的全部范围', () => {
  // 手工摆放的树与草丛横跨 x∈[-9.8, 9.6]、z∈[-12.5, 1.4]
  for (const [x, z] of [
    [-9.8, -12.5],
    [9.6, 1.4],
    [0, 4.5],
  ] as const) {
    const coordinate = toChunkCoordinate(x, z);
    assert.ok(isSpawnChunk(coordinate.x, coordinate.z), `(${x}, ${z}) 应当落在出生地`);
  }
});

test('地块中心与世界坐标互相对应', () => {
  for (const [x, z] of [
    [0, 0],
    [3, -2],
    [-5, 7],
  ] as const) {
    const center = chunkCenter(x, z);
    assert.equal(center.x, x * CHUNK_SIZE);
    const roundTrip = toChunkCoordinate(center.x, center.z);
    assert.deepEqual(roundTrip, { x, z });
  }
});

test('地块之间用切比雪夫距离，对应方形加载半径', () => {
  assert.equal(chunkDistance(0, 0, 2, 1), 2);
  assert.equal(chunkDistance(0, 0, -2, -2), 2);
  assert.equal(chunkDistance(3, 3, 3, 3), 0);
});

test('地块键唯一且能区分正负坐标', () => {
  assert.notEqual(chunkKey(-1, 1), chunkKey(1, -1));
  assert.equal(chunkKey(2, -3), chunkKey(2, -3));
});

test('半径内的地块按由近及远排序', () => {
  const chunks = listChunksInRadius(0, 0, 2);
  assert.equal(chunks.length, 25);
  assert.deepEqual(chunks[0], { x: 0, z: 0 });

  const distances = chunks.map((chunk) => chunk.x ** 2 + chunk.z ** 2);
  for (let index = 1; index < distances.length; index += 1) {
    assert.ok(distances[index] >= distances[index - 1], '排序必须单调不减');
  }
});

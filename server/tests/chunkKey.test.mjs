import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkCenter,
  chunkOrigin,
  chunkRingDistance,
  listChunksInRadius,
  parseChunkKey,
  toChunkCoordinate,
  toChunkKey,
} from '../../shared/world/chunkKey.mjs';
import {
  CHUNK_SIZE,
  MAXIMUM_CHUNK_COORDINATE,
  MINIMUM_CHUNK_COORDINATE,
  WORLD_PLAY_AREA,
  isChunkInsideWorld,
} from '../../shared/world/worldConfig.mjs';

test('世界坐标向下取整到 chunk，负半轴不与正半轴重叠', () => {
  assert.equal(toChunkCoordinate(0), 0);
  assert.equal(toChunkCoordinate(CHUNK_SIZE - 0.001), 0);
  assert.equal(toChunkCoordinate(CHUNK_SIZE), 1);
  assert.equal(toChunkCoordinate(-0.001), -1);
  assert.equal(toChunkCoordinate(-CHUNK_SIZE), -1);
});

test('chunk key 可以往返', () => {
  assert.equal(toChunkKey(-3, 5), '-3:5');
  assert.deepEqual(parseChunkKey('-3:5'), { chunkX: -3, chunkZ: 5 });
  assert.equal(parseChunkKey('3:'), undefined);
  assert.equal(parseChunkKey('a:b'), undefined);
});

test('chunk 原点与中心相差半个 chunk', () => {
  assert.equal(chunkOrigin(2), 2 * CHUNK_SIZE);
  assert.equal(chunkCenter(2), 2 * CHUNK_SIZE + CHUNK_SIZE / 2);
});

test('圈距离取两轴的较大值', () => {
  assert.equal(chunkRingDistance(0, 0, 3, 1), 3);
  assert.equal(chunkRingDistance(0, 0, -1, -4), 4);
});

test('半径查询覆盖正方形区域并按由近及远排序', () => {
  const chunks = listChunksInRadius(0, 0, 2);
  assert.equal(chunks.length, 25);
  assert.equal(chunks[0].key, '0:0');
  for (let index = 1; index < chunks.length; index += 1) {
    assert.ok(chunks[index].distanceSquared >= chunks[index - 1].distanceSquared);
  }
});

test('半径查询不会越过世界边界', () => {
  const corner = listChunksInRadius(MINIMUM_CHUNK_COORDINATE, MINIMUM_CHUNK_COORDINATE, 2);
  assert.equal(corner.length, 9);
  for (const chunk of corner) assert.ok(isChunkInsideWorld(chunk.chunkX, chunk.chunkZ));
});

test('玩家活动范围完全落在已生成的世界内部', () => {
  // 活动范围向内收了若干个 chunk，玩家永远走不到没有内容的世界边缘旁边。
  assert.ok(toChunkCoordinate(WORLD_PLAY_AREA.minimumX) > MINIMUM_CHUNK_COORDINATE);
  assert.ok(toChunkCoordinate(WORLD_PLAY_AREA.maximumX) < MAXIMUM_CHUNK_COORDINATE);
  assert.ok(toChunkCoordinate(WORLD_PLAY_AREA.minimumZ) > MINIMUM_CHUNK_COORDINATE);
  assert.ok(toChunkCoordinate(WORLD_PLAY_AREA.maximumZ) < MAXIMUM_CHUNK_COORDINATE);
});

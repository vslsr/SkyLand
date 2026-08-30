import test from 'node:test';
import assert from 'node:assert/strict';
import { createChunkContent } from '../src/world/worldGen.ts';
import { CHUNK_HALF_SIZE } from '../shared/chunkCoordinates.mjs';

test('同一个地块坐标永远生成同一份内容', () => {
  for (const [x, z] of [
    [4, -7],
    [-31, 12],
    [1000, -1000],
  ] as const) {
    assert.deepEqual(createChunkContent(x, z), createChunkContent(x, z));
  }
});

test('出生地沿用手工布置，不走程序化生成', () => {
  const spawn = createChunkContent(0, 0);
  assert.equal(spawn.trees.length, 3);
  assert.equal(spawn.grassPatches.length, 13);
  assert.deepEqual(spawn.trees[0], { x: -5.2, z: -3.8, rotation: 0.14, scale: 1.05 });
});

test('相邻地块的内容互不相同', () => {
  const a = createChunkContent(0, 1);
  const b = createChunkContent(1, 0);
  assert.notDeepEqual(a, b);
  // -1 与 1 不能因为哈希折叠而撞在一起
  assert.notDeepEqual(createChunkContent(-1, 0), createChunkContent(1, 0));
  assert.notDeepEqual(createChunkContent(0, -1), createChunkContent(0, 1));
});

test('生成的物体都落在地块范围内', () => {
  for (let x = -3; x <= 3; x += 1) {
    for (let z = -3; z <= 3; z += 1) {
      const content = createChunkContent(x, z);
      for (const item of [...content.trees, ...content.grassPatches]) {
        assert.ok(Math.abs(item.x) <= CHUNK_HALF_SIZE, `x=${item.x} 越界`);
        assert.ok(Math.abs(item.z) <= CHUNK_HALF_SIZE, `z=${item.z} 越界`);
      }
    }
  }
});

test('程序化地块的内容密度与出生地相当', () => {
  let trees = 0;
  let patches = 0;
  const sampleCount = 200;
  for (let index = 1; index <= sampleCount; index += 1) {
    const content = createChunkContent(index * 13, index * 29 + 5);
    trees += content.trees.length;
    patches += content.grassPatches.length;
  }

  assert.ok(trees / sampleCount > 1.5 && trees / sampleCount < 6, '树木密度应当接近出生地的 3 棵');
  assert.ok(patches / sampleCount > 8 && patches / sampleCount < 18, '草丛密度应当接近出生地的 13 处');
});

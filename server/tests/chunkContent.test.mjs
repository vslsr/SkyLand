import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROP_BUFFER_LENGTH,
  PROP_FIELD,
  PROP_STRIDE,
  generateChunkContent,
  generateChunkProps,
} from '../../shared/world/chunkContent.mjs';
import {
  CHUNK_SIZE,
  DEFAULT_WORLD_SEED,
  MAXIMUM_PROPS_PER_CHUNK,
  PROP_KIND,
} from '../../shared/world/worldConfig.mjs';

test('同一个种子与坐标永远生成同一批物件', () => {
  const first = generateChunkContent(DEFAULT_WORLD_SEED, 3, -4);
  const second = generateChunkContent(DEFAULT_WORLD_SEED, 3, -4);
  assert.deepEqual(first, second);
});

test('换种子或换 chunk 就是另一批物件', () => {
  const base = generateChunkContent(DEFAULT_WORLD_SEED, 3, -4);
  assert.notDeepEqual(base, generateChunkContent(DEFAULT_WORLD_SEED, 3, -5));
  assert.notDeepEqual(base, generateChunkContent(DEFAULT_WORLD_SEED + 1, 3, -4));
});

test('物件全部落在自己的 chunk 内，不会骑在接缝上', () => {
  for (let chunkX = -2; chunkX <= 2; chunkX += 1) {
    for (let chunkZ = -2; chunkZ <= 2; chunkZ += 1) {
      const originX = chunkX * CHUNK_SIZE;
      const originZ = chunkZ * CHUNK_SIZE;
      for (const prop of generateChunkContent(DEFAULT_WORLD_SEED, chunkX, chunkZ)) {
        assert.ok(prop.x >= originX && prop.x < originX + CHUNK_SIZE, `x 越界：${prop.x}`);
        assert.ok(prop.z >= originZ && prop.z < originZ + CHUNK_SIZE, `z 越界：${prop.z}`);
      }
    }
  }
});

test('朝向、缩放与种类都在约定范围内', () => {
  const kinds = new Set(Object.values(PROP_KIND));
  for (const prop of generateChunkContent(DEFAULT_WORLD_SEED, 0, 0)) {
    assert.ok(kinds.has(prop.kind));
    assert.ok(prop.rotation >= 0 && prop.rotation < Math.PI * 2);
    assert.ok(prop.scale >= 0.7 && prop.scale <= 1.4);
  }
});

test('物件数量不会超过放置格总数，缓冲区够用', () => {
  const buffer = new Int32Array(PROP_BUFFER_LENGTH);
  let maximum = 0;
  for (let chunkX = -8; chunkX <= 7; chunkX += 1) {
    for (let chunkZ = -8; chunkZ <= 7; chunkZ += 1) {
      maximum = Math.max(maximum, generateChunkProps(DEFAULT_WORLD_SEED, chunkX, chunkZ, buffer));
    }
  }
  assert.ok(maximum > 0);
  assert.ok(maximum <= MAXIMUM_PROPS_PER_CHUNK);
  assert.equal(PROP_BUFFER_LENGTH, MAXIMUM_PROPS_PER_CHUNK * PROP_STRIDE);
});

test('密度噪声让世界有疏有密，而不是均匀铺开', () => {
  const counts = [];
  for (let chunkX = -8; chunkX <= 7; chunkX += 1) {
    for (let chunkZ = -8; chunkZ <= 7; chunkZ += 1) {
      counts.push(generateChunkContent(DEFAULT_WORLD_SEED, chunkX, chunkZ).length);
    }
  }
  assert.ok(Math.max(...counts) - Math.min(...counts) >= 8, '疏密差异过小，密度噪声可能失效');
});

test('蘑菇在世界中稳定散布，频率略低于草', () => {
  const counts = new Map(Object.values(PROP_KIND).map((kind) => [kind, 0]));
  for (let chunkX = -8; chunkX <= 7; chunkX += 1) {
    for (let chunkZ = -8; chunkZ <= 7; chunkZ += 1) {
      for (const prop of generateChunkContent(DEFAULT_WORLD_SEED, chunkX, chunkZ)) {
        counts.set(prop.kind, counts.get(prop.kind) + 1);
      }
    }
  }
  const mushroomCount = counts.get(PROP_KIND.MUSHROOM);
  const grassCount = counts.get(PROP_KIND.GRASS);
  assert.ok(mushroomCount > 0);
  assert.ok(mushroomCount < grassCount, '蘑菇应比草稍少');
  assert.ok(mushroomCount / grassCount > 0.6, '蘑菇不应稀疏到明显低于草');
});

test('整数记录解码成米与弧度的换算是稳定的', () => {
  const buffer = new Int32Array(PROP_BUFFER_LENGTH);
  const count = generateChunkProps(DEFAULT_WORLD_SEED, 1, 1, buffer);
  const props = generateChunkContent(DEFAULT_WORLD_SEED, 1, 1);
  assert.equal(props.length, count);
  assert.equal(props[0].x, buffer[PROP_FIELD.X_MM] / 1000);
  assert.equal(props[0].scale, buffer[PROP_FIELD.SCALE_THOUSANDTHS] / 1000);
});

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
  CHUNK_SIZE_MM,
  DEFAULT_WORLD_SEED,
  MAXIMUM_PROPS_PER_CHUNK,
  PROP_CELL_SIZE_MM,
  PROP_GRID,
  PROP_KIND,
} from '../../shared/world/worldConfig.mjs';
import {
  terrainCellBiome,
  terrainCellCodeAtMillimeters,
  terrainCellShape,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_BIOME_COUNT,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';

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

const BIOME_NAME = Object.fromEntries(
  Object.entries(TERRAIN_BIOME).map(([name, value]) => [value, name]),
);

/**
 * 按地皮分桶统计一片世界：每种地皮有多少个可放置格（平坦陆地），
 * 以及那些格上真正长出来的四类物件各有多少。
 */
function surveyBiomes(worldSeed, chunkRadius) {
  const survey = [];
  for (let index = 0; index < TERRAIN_BIOME_COUNT; index += 1) {
    survey.push({ slots: 0, total: 0, kinds: new Array(4).fill(0) });
  }
  for (let chunkZ = -chunkRadius; chunkZ <= chunkRadius; chunkZ += 1) {
    for (let chunkX = -chunkRadius; chunkX <= chunkRadius; chunkX += 1) {
      for (let cellZ = 0; cellZ < PROP_GRID; cellZ += 1) {
        for (let cellX = 0; cellX < PROP_GRID; cellX += 1) {
          // 用格心判断这一格属于哪种地皮：物件的落点在格内抖动，抖动不改变
          // 归属的量级，用格心统计足以给出可放置格的分母。
          const code = terrainCellCodeAtMillimeters(
            worldSeed,
            chunkX * CHUNK_SIZE_MM + cellX * PROP_CELL_SIZE_MM + PROP_CELL_SIZE_MM / 2,
            chunkZ * CHUNK_SIZE_MM + cellZ * PROP_CELL_SIZE_MM + PROP_CELL_SIZE_MM / 2,
          );
          if (
            terrainCellSurface(code) !== TERRAIN_SURFACE.GROUND
            || terrainCellShape(code) !== TERRAIN_SHAPE.FLAT
          ) continue;
          survey[terrainCellBiome(code)].slots += 1;
        }
      }
      for (const prop of generateChunkContent(worldSeed, chunkX, chunkZ)) {
        const biome = terrainCellBiome(terrainCellCodeAtMillimeters(
          worldSeed,
          Math.round(prop.x * 1000),
          Math.round(prop.z * 1000),
        ));
        survey[biome].total += 1;
        survey[biome].kinds[prop.kind] += 1;
      }
    }
  }
  return survey;
}

test('物件按脚下的地皮生长，五种地皮各有各的产出', () => {
  const survey = surveyBiomes(DEFAULT_WORLD_SEED, 6);
  for (const [name, biome] of Object.entries(TERRAIN_BIOME)) {
    assert.ok(
      survey[biome].total > 60,
      `${name} 只统计到 ${survey[biome].total} 个物件，样本太小，下面的断言没有意义`,
    );
  }
  const share = (biome, kind) => survey[biome].kinds[kind] / survey[biome].total;
  const occupancy = (biome) => survey[biome].total / survey[biome].slots;

  // 干燥与寒冷的地皮不长蘑菇——这一条是 0，不是「少」。
  assert.equal(survey[TERRAIN_BIOME.SAND].kinds[PROP_KIND.MUSHROOM], 0);
  assert.equal(survey[TERRAIN_BIOME.SNOW].kinds[PROP_KIND.MUSHROOM], 0);

  assert.ok(share(TERRAIN_BIOME.ROCK, PROP_KIND.ROCK) > 0.5, '石头地应该以石头为主');
  assert.ok(share(TERRAIN_BIOME.SAND, PROP_KIND.ROCK) > 0.4, '沙地应该以风蚀石为主');
  assert.ok(share(TERRAIN_BIOME.MUD, PROP_KIND.MUSHROOM) > 0.4, '烂泥地应该长满蘑菇');
  assert.ok(share(TERRAIN_BIOME.SNOW, PROP_KIND.TREE) > 0.35, '雪地应该留着针叶林');

  // 沙地与雪地空旷：同样的可放置格里长出来的东西明显更少。
  assert.ok(
    occupancy(TERRAIN_BIOME.SAND) < occupancy(TERRAIN_BIOME.GRASSLAND) * 0.6,
    `沙地占用率 ${occupancy(TERRAIN_BIOME.SAND).toFixed(2)} 没有比草原稀疏`,
  );
  assert.ok(
    occupancy(TERRAIN_BIOME.SNOW) < occupancy(TERRAIN_BIOME.GRASSLAND) * 0.6,
    `雪地占用率 ${occupancy(TERRAIN_BIOME.SNOW).toFixed(2)} 没有比草原稀疏`,
  );

  // 草原是基准：扣掉树与岩石之后仍按 3:4 分蘑菇与草，与引入群系之前一致。
  const grassland = survey[TERRAIN_BIOME.GRASSLAND];
  const ratio = grassland.kinds[PROP_KIND.MUSHROOM] / grassland.kinds[PROP_KIND.GRASS];
  assert.ok(
    ratio > 0.6 && ratio < 0.9,
    `草原的蘑菇/草比例 ${ratio.toFixed(2)} 偏离了 3:4，草原的产出不该被群系层改动`,
  );
});

test('每种地皮的产出跨种子稳定，不是某一颗种子的巧合', () => {
  for (const worldSeed of [0x1234_5678, 0xdead_beef]) {
    const survey = surveyBiomes(worldSeed, 5);
    for (const biome of [TERRAIN_BIOME.SAND, TERRAIN_BIOME.SNOW]) {
      assert.equal(
        survey[biome].kinds[PROP_KIND.MUSHROOM],
        0,
        `种子 ${worldSeed.toString(16)} 的 ${BIOME_NAME[biome]} 上长出了蘑菇`,
      );
    }
    if (survey[TERRAIN_BIOME.ROCK].total > 60) {
      assert.ok(
        survey[TERRAIN_BIOME.ROCK].kinds[PROP_KIND.ROCK] / survey[TERRAIN_BIOME.ROCK].total > 0.5,
      );
    }
  }
});

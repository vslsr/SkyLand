import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BIOME_REGION_SHIFT,
  BIOME_REGION_SIZE,
  BIOME_SITE_MARGIN,
  BIOME_SITE_SPAN,
  terrainBiomeAt,
  terrainBiomeFromClimate,
  terrainBiomeRegionSite,
} from '../../shared/world/terrainBiome.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_BIOME_COUNT,
  TERRAIN_BIOME_MASK,
} from '../../shared/world/terrainConfig.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';

const BIOME_NAME = Object.fromEntries(
  Object.entries(TERRAIN_BIOME).map(([name, value]) => [value, name]),
);
/** 活动区是 384 × 384 米，即 ±96 格。 */
const PLAY_AREA_CELLS = 96;

function countBiomes(worldSeed, range = PLAY_AREA_CELLS) {
  const counts = new Array(TERRAIN_BIOME_COUNT).fill(0);
  for (let cellZ = -range; cellZ < range; cellZ += 1) {
    for (let cellX = -range; cellX < range; cellX += 1) {
      counts[terrainBiomeAt(worldSeed, cellX, cellZ)] += 1;
    }
  }
  return counts;
}

test('群系是种子与格坐标的纯函数，换种子换世界', () => {
  for (let index = 0; index < 64; index += 1) {
    const cellX = ((index * 37) % 211) - 105;
    const cellZ = ((index * 53) % 197) - 98;
    const first = terrainBiomeAt(DEFAULT_WORLD_SEED, cellX, cellZ);
    assert.equal(terrainBiomeAt(DEFAULT_WORLD_SEED, cellX, cellZ), first);
    assert.ok(first >= 0 && first < TERRAIN_BIOME_COUNT);
    assert.equal(first & TERRAIN_BIOME_MASK, first, '群系必须能塞进 code 的 3 位');
  }

  const left = countBiomes(DEFAULT_WORLD_SEED, 48);
  const right = countBiomes((DEFAULT_WORLD_SEED ^ 0x5a5a_5a5a) >>> 0, 48);
  assert.notDeepEqual(left, right, '换一颗种子应该得到另一张地皮分布');
});

test('只扫 3×3 区块与暴力扫 7×7 得到同一个最近站点', () => {
  // 站点内缩 BIOME_SITE_MARGIN 就是为了让这条成立。哪天有人把内缩调小、
  // 或者把区块调大，这里会先报红，而不是让世界里出现几格突兀的异色。
  const site = {};
  const radius = 3;
  for (const worldSeed of [DEFAULT_WORLD_SEED, 0, 0xffff_ffff]) {
    for (let cellZ = -70; cellZ <= 70; cellZ += 3) {
      for (let cellX = -70; cellX <= 70; cellX += 3) {
        const regionX = cellX >> BIOME_REGION_SHIFT;
        const regionZ = cellZ >> BIOME_REGION_SHIFT;
        let nearestDistance = Number.POSITIVE_INFINITY;
        let nearestOffsetX = 0;
        let nearestOffsetZ = 0;
        for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            terrainBiomeRegionSite(worldSeed, regionX + offsetX, regionZ + offsetZ, site);
            const deltaX = site.x - cellX;
            const deltaZ = site.z - cellZ;
            const distance = deltaX * deltaX + deltaZ * deltaZ;
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearestOffsetX = offsetX;
              nearestOffsetZ = offsetZ;
            }
          }
        }
        assert.ok(
          Math.abs(nearestOffsetX) <= 1 && Math.abs(nearestOffsetZ) <= 1,
          `格 (${cellX}, ${cellZ}) 的最近站点在偏移 (${nearestOffsetX}, ${nearestOffsetZ}) 的区块，`
          + '3×3 扫描已经不等于精确 Voronoi',
        );
      }
    }
  }
});

test('站点落在自己区块内并留出内缩', () => {
  const site = {};
  for (let regionZ = -4; regionZ <= 4; regionZ += 1) {
    for (let regionX = -4; regionX <= 4; regionX += 1) {
      terrainBiomeRegionSite(DEFAULT_WORLD_SEED, regionX, regionZ, site);
      const originX = regionX * BIOME_REGION_SIZE;
      const originZ = regionZ * BIOME_REGION_SIZE;
      assert.ok(site.x >= originX + BIOME_SITE_MARGIN);
      assert.ok(site.x < originX + BIOME_SITE_MARGIN + BIOME_SITE_SPAN);
      assert.ok(site.z >= originZ + BIOME_SITE_MARGIN);
      assert.ok(site.z < originZ + BIOME_SITE_MARGIN + BIOME_SITE_SPAN);
    }
  }
});

test('地皮成片而不是逐格跳色', () => {
  let sameNeighbor = 0;
  let total = 0;
  for (let cellZ = -PLAY_AREA_CELLS; cellZ < PLAY_AREA_CELLS; cellZ += 1) {
    for (let cellX = -PLAY_AREA_CELLS; cellX < PLAY_AREA_CELLS - 1; cellX += 1) {
      if (
        terrainBiomeAt(DEFAULT_WORLD_SEED, cellX, cellZ)
        === terrainBiomeAt(DEFAULT_WORLD_SEED, cellX + 1, cellZ)
      ) sameNeighbor += 1;
      total += 1;
    }
  }
  // 斑块平均跨度约 78 米（39 格），相邻格同色率应当远高于随机分布的 ~0.25。
  assert.ok(
    sameNeighbor / total > 0.9,
    `相邻格同群系比例只有 ${(sameNeighbor / total).toFixed(3)}，地皮碎成了噪点`,
  );
});

test('每颗种子的活动区里五种地皮都拿得到', () => {
  const seeds = [DEFAULT_WORLD_SEED, 0, 1, 0xdead_beef, 0xffff_ffff, 0x0001_6062];
  for (const seed of seeds) {
    const counts = countBiomes(seed >>> 0);
    for (const [name, value] of Object.entries(TERRAIN_BIOME)) {
      assert.ok(
        counts[value] > 0,
        `种子 ${(seed >>> 0).toString(16)} 的活动区里没有 ${name}：${counts.join('/')}`,
      );
    }
    // 草原是世界的底色，不能被其它地皮挤成配角。
    const total = counts.reduce((sum, count) => sum + count, 0);
    assert.ok(
      counts[TERRAIN_BIOME.GRASSLAND] / total > 0.2,
      `种子 ${(seed >>> 0).toString(16)} 的草原只占 `
      + `${(counts[TERRAIN_BIOME.GRASSLAND] / total * 100).toFixed(1)}%`,
    );
  }
});

test('气候查表覆盖五个分支', () => {
  const cases = [
    { temperature: 0, moisture: 128, expected: TERRAIN_BIOME.SNOW },
    { temperature: 255, moisture: 0, expected: TERRAIN_BIOME.SAND },
    { temperature: 255, moisture: 255, expected: TERRAIN_BIOME.MUD },
    { temperature: 128, moisture: 0, expected: TERRAIN_BIOME.ROCK },
    { temperature: 128, moisture: 128, expected: TERRAIN_BIOME.GRASSLAND },
  ];
  for (const { temperature, moisture, expected } of cases) {
    assert.equal(
      terrainBiomeFromClimate(temperature, moisture),
      expected,
      `温度 ${temperature} 湿度 ${moisture} 应该是 ${BIOME_NAME[expected]}`,
    );
  }
});

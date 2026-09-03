import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTerrainChunkData,
  encodeTerrainCell,
  sampleTerrain,
  terrainCellBiome,
  terrainCellCodeAt,
  terrainCellCornerHeight,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import { terrainBiomeAt } from '../../shared/world/terrainBiome.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_CELL_COUNT,
  TERRAIN_CELL_SIZE,
  TERRAIN_GRID,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';

const CORNER_SHAPES = [
  {
    shape: TERRAIN_SHAPE.CORNER_HIGH_NORTH_EAST,
    cornerX: 1,
    cornerZ: 1,
    lowCorner: false,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_HIGH_SOUTH_EAST,
    cornerX: 1,
    cornerZ: 0,
    lowCorner: false,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_HIGH_SOUTH_WEST,
    cornerX: 0,
    cornerZ: 0,
    lowCorner: false,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST,
    cornerX: 0,
    cornerZ: 1,
    lowCorner: false,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_LOW_NORTH_EAST,
    cornerX: 1,
    cornerZ: 1,
    lowCorner: true,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_LOW_SOUTH_EAST,
    cornerX: 1,
    cornerZ: 0,
    lowCorner: true,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_LOW_SOUTH_WEST,
    cornerX: 0,
    cornerZ: 0,
    lowCorner: true,
  },
  {
    shape: TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST,
    cornerX: 0,
    cornerZ: 1,
    lowCorner: true,
  },
];

function findCell(predicate) {
  for (let z = -128; z < 128; z += 1) {
    for (let x = -128; x < 128; x += 1) {
      const code = terrainCellCodeAt(DEFAULT_WORLD_SEED, x, z);
      if (predicate(code, x, z)) return { code, x, z };
    }
  }
  throw new Error('测试范围内没有找到所需地形格');
}

function findGroundCliff() {
  const inset = 0.6;
  const seamProbe = 0.001;
  for (let z = -127; z < 127; z += 1) {
    for (let x = -127; x < 126; x += 1) {
      const boundaryX = (x + 1) * TERRAIN_CELL_SIZE;
      const centerZ = (z + 0.5) * TERRAIN_CELL_SIZE;
      const leftEdge = sampleTerrain(DEFAULT_WORLD_SEED, boundaryX - seamProbe, centerZ);
      const rightEdge = sampleTerrain(DEFAULT_WORLD_SEED, boundaryX + seamProbe, centerZ);
      if (
        leftEdge.surface !== TERRAIN_SURFACE.GROUND
        || rightEdge.surface !== TERRAIN_SURFACE.GROUND
        || Math.abs(leftEdge.groundY - rightEdge.groundY) < 0.4
      ) continue;

      const left = { x: boundaryX - inset, z: centerZ };
      const right = { x: boundaryX + inset, z: centerZ };
      return leftEdge.groundY > rightEdge.groundY
        ? { high: left, low: right }
        : { high: right, low: left };
    }
  }
  throw new Error('测试范围内没有找到陆地高低断崖');
}

test('同一种子与全局格坐标稳定生成带正负高度的地形', () => {
  const first = [];
  const repeated = [];
  const levels = new Set();
  const surfaces = new Set();
  for (let z = -48; z <= 48; z += 1) {
    for (let x = -48; x <= 48; x += 1) {
      const code = terrainCellCodeAt(DEFAULT_WORLD_SEED, x, z);
      first.push(code);
      repeated.push(terrainCellCodeAt(DEFAULT_WORLD_SEED, x, z));
      levels.add(terrainCellHeightLevel(code));
      surfaces.add(terrainCellSurface(code));
    }
  }
  assert.deepEqual(first, repeated);
  assert.ok([...levels].some((level) => level < 0));
  assert.ok([...levels].some((level) => level > 0));
  assert.deepEqual([...surfaces].sort(), [TERRAIN_SURFACE.GROUND, TERRAIN_SURFACE.WATER]);
});

test('chunk 数据固定为 16×16，负坐标与接缝使用同一套全局寻址', () => {
  const left = buildTerrainChunkData(DEFAULT_WORLD_SEED, -1, 0);
  const right = buildTerrainChunkData(DEFAULT_WORLD_SEED, 0, 0);
  assert.equal(left.heights.length, TERRAIN_CELL_COUNT);
  assert.equal(left.meta.length, TERRAIN_CELL_COUNT);

  for (let localZ = 0; localZ < TERRAIN_GRID; localZ += 1) {
    const leftIndex = localZ * TERRAIN_GRID + TERRAIN_GRID - 1;
    const rightIndex = localZ * TERRAIN_GRID;
    assert.equal(
      left.heights[leftIndex],
      terrainCellHeightLevel(terrainCellCodeAt(DEFAULT_WORLD_SEED, -1, localZ)),
    );
    assert.equal(
      right.heights[rightIndex],
      terrainCellHeightLevel(terrainCellCodeAt(DEFAULT_WORLD_SEED, 0, localZ)),
    );
  }
});

test('四个方向的斜坡都会生成，并按方向连续插值一层高度', () => {
  for (const shape of [
    TERRAIN_SHAPE.RAMP_NORTH,
    TERRAIN_SHAPE.RAMP_EAST,
    TERRAIN_SHAPE.RAMP_SOUTH,
    TERRAIN_SHAPE.RAMP_WEST,
  ]) {
    const cell = findCell((code) => terrainCellShape(code) === shape);
    const originX = cell.x * TERRAIN_CELL_SIZE;
    const originZ = cell.z * TERRAIN_CELL_SIZE;
    const samples = shape === TERRAIN_SHAPE.RAMP_NORTH
      ? [[originX + 1, originZ + 0.05], [originX + 1, originZ + 1.95]]
      : shape === TERRAIN_SHAPE.RAMP_EAST
        ? [[originX + 0.05, originZ + 1], [originX + 1.95, originZ + 1]]
        : shape === TERRAIN_SHAPE.RAMP_SOUTH
          ? [[originX + 1, originZ + 1.95], [originX + 1, originZ + 0.05]]
          : [[originX + 1.95, originZ + 1], [originX + 0.05, originZ + 1]];
    const low = sampleTerrain(DEFAULT_WORLD_SEED, samples[0][0], samples[0][1]);
    const high = sampleTerrain(DEFAULT_WORLD_SEED, samples[1][0], samples[1][1]);
    assert.ok(high.groundY - low.groundY > 0.9, `shape ${shape} 高差不足`);
    assert.ok(high.normalY < 1);
  }
});

test('单高角与单低角都补齐四个方向，角点高度和表面采样一致', () => {
  for (const { shape, cornerX, cornerZ, lowCorner } of CORNER_SHAPES) {
    const encoded = encodeTerrainCell(2, TERRAIN_SURFACE.GROUND, shape);
    for (let testZ = 0; testZ <= 1; testZ += 1) {
      for (let testX = 0; testX <= 1; testX += 1) {
        const isNamedCorner = testX === cornerX && testZ === cornerZ;
        const expectedLevel = lowCorner === isNamedCorner ? 2 : 3;
        assert.equal(
          terrainCellCornerHeight(encoded, testX, testZ),
          expectedLevel,
          `shape ${shape} 的 (${testX}, ${testZ}) 角点高度错误`,
        );
      }
    }

    const cell = findCell((code) => terrainCellShape(code) === shape);
    const originX = cell.x * TERRAIN_CELL_SIZE;
    const originZ = cell.z * TERRAIN_CELL_SIZE;
    const namedCorner = sampleTerrain(
      DEFAULT_WORLD_SEED,
      originX + (cornerX === 1 ? 1.9 : 0.1),
      originZ + (cornerZ === 1 ? 1.9 : 0.1),
    );
    const oppositeCorner = sampleTerrain(
      DEFAULT_WORLD_SEED,
      originX + (cornerX === 1 ? 0.1 : 1.9),
      originZ + (cornerZ === 1 ? 0.1 : 1.9),
    );
    const rise = lowCorner
      ? oppositeCorner.groundY - namedCorner.groundY
      : namedCorner.groundY - oppositeCorner.groundY;
    assert.ok(rise > 0.8, `shape ${shape} 没有沿正确角方向跨越一层`);
    assert.ok(namedCorner.normalY < 1);
    assert.ok(oppositeCorner.normalY < 1);
  }
});

test('群系与高度、表面、形状在 code 里互不干扰', () => {
  for (const biome of Object.values(TERRAIN_BIOME)) {
    for (const heightLevel of [-128, -2, 0, 3, 127]) {
      for (const surface of [TERRAIN_SURFACE.GROUND, TERRAIN_SURFACE.WATER]) {
        for (const shape of [TERRAIN_SHAPE.FLAT, TERRAIN_SHAPE.RAMP_WEST, TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST]) {
          const code = encodeTerrainCell(heightLevel, surface, shape, biome);
          assert.equal(terrainCellHeightLevel(code), heightLevel);
          assert.equal(terrainCellSurface(code), surface);
          assert.equal(terrainCellShape(code), shape);
          assert.equal(terrainCellBiome(code), biome);
        }
      }
    }
  }
  // 不传群系的旧调用方仍然得到草原，手写 code 的测试与编辑器不受影响。
  assert.equal(
    terrainCellBiome(encodeTerrainCell(1, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT)),
    TERRAIN_BIOME.GRASSLAND,
  );
});

test('生成的格子带着所在片区的地皮，水底也一样', () => {
  let waterCells = 0;
  for (let cellZ = -40; cellZ < 40; cellZ += 1) {
    for (let cellX = -40; cellX < 40; cellX += 1) {
      const code = terrainCellCodeAt(DEFAULT_WORLD_SEED, cellX, cellZ);
      assert.equal(terrainCellBiome(code), terrainBiomeAt(DEFAULT_WORLD_SEED, cellX, cellZ));
      if (terrainCellSurface(code) === TERRAIN_SURFACE.WATER) waterCells += 1;
    }
  }
  assert.ok(waterCells > 0, '扫描区里应该有水面，否则这条断言没盖到水底');
});

test('sampleTerrain 把群系一并交出来，meta 字节也留着它', () => {
  const sample = sampleTerrain(DEFAULT_WORLD_SEED, 37.4, -58.9);
  assert.equal(sample.biome, terrainBiomeAt(DEFAULT_WORLD_SEED, sample.globalCellX, sample.globalCellZ));

  const chunkX = 1;
  const chunkZ = -2;
  const { meta } = buildTerrainChunkData(DEFAULT_WORLD_SEED, chunkX, chunkZ);
  for (let localZ = 0; localZ < TERRAIN_GRID; localZ += 1) {
    for (let localX = 0; localX < TERRAIN_GRID; localX += 1) {
      assert.equal(
        terrainCellBiome(meta[localZ * TERRAIN_GRID + localX]),
        terrainBiomeAt(
          DEFAULT_WORLD_SEED,
          chunkX * TERRAIN_GRID + localX,
          chunkZ * TERRAIN_GRID + localZ,
        ),
      );
    }
  }
});

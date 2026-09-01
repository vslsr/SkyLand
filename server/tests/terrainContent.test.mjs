import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTerrainChunkData,
  encodeTerrainCell,
  sampleTerrain,
  terrainCellCodeAt,
  terrainCellCornerHeight,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_CELL_COUNT,
  TERRAIN_CELL_SIZE,
  TERRAIN_GRID,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { resolveTerrainMovement } from '../../shared/world/terrainMovement.mjs';
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

test('共享移动允许斜坡和水域通行，河床与浮力共同决定支撑高度', () => {
  const ramp = findCell((code) => terrainCellShape(code) === TERRAIN_SHAPE.RAMP_EAST);
  const originX = ramp.x * TERRAIN_CELL_SIZE;
  const originZ = ramp.z * TERRAIN_CELL_SIZE;
  const low = { x: originX + 0.1, z: originZ + 1 };
  const high = { x: originX + 1.9, z: originZ + 1 };
  const climbed = resolveTerrainMovement(DEFAULT_WORLD_SEED, low, high, {
    radius: 0,
    maximumStepHeight: 0.2,
  });
  assert.equal(climbed.x, high.x);
  assert.ok(climbed.y > sampleTerrain(DEFAULT_WORLD_SEED, low.x, low.z).groundY + 0.8);

  const shore = findCell((code, x, z) => (
    terrainCellSurface(code) === TERRAIN_SURFACE.GROUND
    && terrainCellHeightLevel(code) === 0
    && terrainCellSurface(terrainCellCodeAt(DEFAULT_WORLD_SEED, x + 1, z))
      === TERRAIN_SURFACE.WATER
  ));
  const start = { x: shore.x * TERRAIN_CELL_SIZE + 1, z: shore.z * TERRAIN_CELL_SIZE + 1 };
  const water = { x: start.x + TERRAIN_CELL_SIZE, z: start.z };
  const enteredWater = resolveTerrainMovement(DEFAULT_WORLD_SEED, start, water, {
    radius: 0,
    maximumStepHeight: 0.2,
  });
  assert.deepEqual({ x: enteredWater.x, z: enteredWater.z }, water);
  assert.equal(
    enteredWater.y,
    sampleTerrain(DEFAULT_WORLD_SEED, water.x, water.z).groundY,
    '没有浮力时角色沿河床高度移动',
  );

  const blockedByRiverbed = resolveTerrainMovement(DEFAULT_WORLD_SEED, water, start, {
    radius: 0,
    maximumStepHeight: 0.2,
  });
  assert.notDeepEqual(
    { x: blockedByRiverbed.x, z: blockedByRiverbed.z },
    start,
    '河床到高岸的落差仍应按可跨越高度阻挡',
  );

  const floatingOptions = {
    radius: 0,
    maximumStepHeight: 0.2,
    waterLevel: 0,
    buoyancyDraft: 0.18,
  };
  const floated = resolveTerrainMovement(DEFAULT_WORLD_SEED, start, water, floatingOptions);
  assert.deepEqual({ x: floated.x, z: floated.z }, water);
  assert.equal(floated.y, -0.18);
  const leftWater = resolveTerrainMovement(DEFAULT_WORLD_SEED, water, start, floatingOptions);
  assert.deepEqual(
    { x: leftWater.x, z: leftWater.z },
    start,
    '浮力把脚下支撑抬到岸边可跨越范围后应能离水',
  );
});

test('角色可以跳下地块边界，向上越级仍受 maximumStepHeight 限制', () => {
  const cliff = findGroundCliff();
  const movement = { radius: 0.25, maximumStepHeight: 0.2 };
  const dropped = resolveTerrainMovement(DEFAULT_WORLD_SEED, cliff.high, cliff.low, movement);
  assert.deepEqual(
    { x: dropped.x, z: dropped.z },
    cliff.low,
    '向下越过断崖不应被台阶高度挡住',
  );
  assert.equal(
    dropped.y,
    sampleTerrain(DEFAULT_WORLD_SEED, cliff.low.x, cliff.low.z).groundY,
  );

  const blockedClimb = resolveTerrainMovement(
    DEFAULT_WORLD_SEED,
    cliff.low,
    cliff.high,
    movement,
  );
  assert.notDeepEqual(
    { x: blockedClimb.x, z: blockedClimb.z },
    cliff.high,
    '超过角色可跨越高度的上台阶必须阻挡',
  );

  const capableClimb = resolveTerrainMovement(DEFAULT_WORLD_SEED, cliff.low, cliff.high, {
    radius: movement.radius,
    maximumStepHeight: TERRAIN_CELL_SIZE,
  });
  assert.deepEqual(
    { x: capableClimb.x, z: capableClimb.z },
    cliff.high,
    '可跨越高度足够时应允许向上通过同一边界',
  );
});

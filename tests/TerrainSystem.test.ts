import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  encodeTerrainCell,
  terrainCellCodeAt,
  terrainCellShape,
  terrainCellSurface,
} from '../shared/world/terrainContent.mjs';
import {
  TERRAIN_CELL_SIZE,
  TERRAIN_GRID,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../shared/world/terrainConfig.mjs';
import { createTerrainChunkGeometry } from '../src/models/terrain/createTerrainChunkGeometry';
import {
  STREAMED_WATER_SHORE_CLEARANCE,
  STREAMED_WATER_SHORE_WIDTH,
} from '../src/models/terrain/terrainWaterStyle';
import type { OceanVisualDefinition } from '../src/scenes/data/SceneDefinition';
import { TerrainWorld } from '../src/world/TerrainWorld';

const SEED = 0x5c1a2d0b;
const WATER_DEFINITION: OceanVisualDefinition = {
  size: 32,
  segments: 16,
  waveHeight: 0.32,
  waveSpeed: 0.82,
  noiseScale: 0.085,
  noiseStrength: 1.15,
  interlaceStrength: 0.42,
  surfaceColor: '#c9e6f2',
  secondaryColor: '#b7dbea',
  deepColor: '#2f6f96',
  depthColorRange: 2.5,
  gridLineColor: '#5f8195',
  gridLineOpacity: 0.25,
};

const CORNER_DIAGONALS = [
  { shape: TERRAIN_SHAPE.CORNER_HIGH_NORTH_EAST, northWestSouthEast: false },
  { shape: TERRAIN_SHAPE.CORNER_HIGH_SOUTH_EAST, northWestSouthEast: true },
  { shape: TERRAIN_SHAPE.CORNER_HIGH_SOUTH_WEST, northWestSouthEast: false },
  { shape: TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST, northWestSouthEast: true },
  { shape: TERRAIN_SHAPE.CORNER_LOW_NORTH_EAST, northWestSouthEast: false },
  { shape: TERRAIN_SHAPE.CORNER_LOW_SOUTH_EAST, northWestSouthEast: true },
  { shape: TERRAIN_SHAPE.CORNER_LOW_SOUTH_WEST, northWestSouthEast: false },
  { shape: TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST, northWestSouthEast: true },
];

function findCell(surface: number, shape?: number): { x: number; z: number } {
  for (let z = -128; z < 128; z += 1) {
    for (let x = -128; x < 128; x += 1) {
      const code = terrainCellCodeAt(SEED, x, z);
      if (
        terrainCellSurface(code) === surface
        && (shape === undefined || terrainCellShape(code) === shape)
      ) return { x, z };
    }
  }
  throw new Error('测试范围内没有找到目标地形格');
}

function cornerKey(x: number, z: number): string {
  return `${x},${z}`;
}

function findShoreCell(): { x: number; z: number } {
  for (let z = -128; z < 128; z += 1) {
    for (let x = -128; x < 128; x += 1) {
      if (terrainCellSurface(terrainCellCodeAt(SEED, x, z)) !== TERRAIN_SURFACE.WATER) {
        continue;
      }
      const neighbors = [[x, z - 1], [x + 1, z], [x, z + 1], [x - 1, z]];
      if (neighbors.some(([neighborX, neighborZ]) => (
        terrainCellSurface(terrainCellCodeAt(SEED, neighborX, neighborZ))
          !== TERRAIN_SURFACE.WATER
      ))) return { x, z };
    }
  }
  throw new Error('测试范围内没有找到水岸格');
}

function findWaterSeam(): { leftChunkX: number; chunkZ: number; cellX: number; cellZ: number } {
  for (let leftChunkX = -4; leftChunkX < 4; leftChunkX += 1) {
    const cellX = (leftChunkX + 1) * TERRAIN_GRID - 1;
    for (let cellZ = -64; cellZ < 64; cellZ += 1) {
      const leftSurface = terrainCellSurface(terrainCellCodeAt(SEED, cellX, cellZ));
      const rightSurface = terrainCellSurface(terrainCellCodeAt(SEED, cellX + 1, cellZ));
      if (leftSurface === TERRAIN_SURFACE.WATER && rightSurface === TERRAIN_SURFACE.WATER) {
        return {
          leftChunkX,
          chunkZ: Math.floor(cellZ / TERRAIN_GRID),
          cellX,
          cellZ,
        };
      }
    }
  }
  throw new Error('测试范围内没有找到跨 chunk 的连续水格');
}

function countLineSegment(
  geometry: THREE.BufferGeometry,
  a: [number, number],
  b: [number, number],
): number {
  const positions = geometry.getAttribute('position');
  let count = 0;
  for (let index = 0; index < positions.count; index += 2) {
    const start: [number, number] = [positions.getX(index), positions.getZ(index)];
    const end: [number, number] = [positions.getX(index + 1), positions.getZ(index + 1)];
    if (
      (start[0] === a[0] && start[1] === a[1] && end[0] === b[0] && end[1] === b[1])
      || (start[0] === b[0] && start[1] === b[1] && end[0] === a[0] && end[1] === a[1])
    ) count += 1;
  }
  return count;
}

function topDiagonalForCell(
  terrain: ReturnType<typeof createTerrainChunkGeometry>,
  cellX: number,
  cellZ: number,
): string[] {
  const positions = terrain.groundFill.getAttribute('position');
  const normals = terrain.groundFill.getAttribute('normal');
  const minimumX = cellX * TERRAIN_CELL_SIZE;
  const maximumX = minimumX + TERRAIN_CELL_SIZE;
  const minimumZ = cellZ * TERRAIN_CELL_SIZE;
  const maximumZ = minimumZ + TERRAIN_CELL_SIZE;
  const triangles: Set<string>[] = [];

  for (let index = 0; index < positions.count; index += 3) {
    if (normals.getY(index) <= 0.5) continue;
    const corners = new Set<string>();
    let insideCell = true;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const x = positions.getX(index + vertex);
      const z = positions.getZ(index + vertex);
      if (x < minimumX || x > maximumX || z < minimumZ || z > maximumZ) {
        insideCell = false;
        break;
      }
      corners.add(cornerKey(x, z));
    }
    if (insideCell && corners.size === 3) triangles.push(corners);
  }

  assert.equal(triangles.length, 2, `格 (${cellX}, ${cellZ}) 顶面应恰好由两个三角形组成`);
  return [...triangles[0]].filter((corner) => triangles[1].has(corner)).sort();
}

test('地形 chunk 生成 water.scene 风格的三角水面、粗岸线和轻量水花', () => {
  const seaLevel = -0.4;
  const water = findShoreCell();
  const chunkX = Math.floor(water.x / TERRAIN_GRID);
  const chunkZ = Math.floor(water.z / TERRAIN_GRID);
  const terrain = createTerrainChunkGeometry({
    worldSeed: SEED,
    chunkX,
    chunkZ,
    groundColor: '#f1eddf',
    oceanDefinition: WATER_DEFINITION,
    seaLevel,
  });
  const positions = terrain.groundFill.getAttribute('position');
  const minimumX = chunkX * TERRAIN_GRID * TERRAIN_CELL_SIZE;
  const maximumX = minimumX + TERRAIN_GRID * TERRAIN_CELL_SIZE;
  const minimumZ = chunkZ * TERRAIN_GRID * TERRAIN_CELL_SIZE;
  const maximumZ = minimumZ + TERRAIN_GRID * TERRAIN_CELL_SIZE;

  assert.ok(positions.count >= TERRAIN_GRID * TERRAIN_GRID * 6);
  for (let index = 0; index < positions.count; index += 1) {
    assert.ok(positions.getX(index) >= minimumX && positions.getX(index) <= maximumX);
    assert.ok(positions.getZ(index) >= minimumZ && positions.getZ(index) <= maximumZ);
  }
  assert.ok(terrain.waterSurface);
  assert.ok(terrain.waterGrid);
  assert.ok(terrain.waterShore);
  assert.ok(terrain.waterSplash);
  assert.equal(
    terrain.waterSurface!.getAttribute('position').count,
    terrain.waterSurface!.getAttribute('color').count,
  );
  const waterColors = terrain.waterSurface!.getAttribute('color');
  const waterPositions = terrain.waterSurface!.getAttribute('position');
  for (let index = 0; index < waterPositions.count; index += 1) {
    assert.ok(Math.abs(waterPositions.getY(index) - seaLevel) < 1e-6);
  }
  for (let face = 0; face < waterColors.count; face += 3) {
    const tint = [waterColors.getX(face), waterColors.getY(face), waterColors.getZ(face)];
    assert.deepEqual(
      [waterColors.getX(face + 1), waterColors.getY(face + 1), waterColors.getZ(face + 1)],
      tint,
    );
    assert.deepEqual(
      [waterColors.getX(face + 2), waterColors.getY(face + 2), waterColors.getZ(face + 2)],
      tint,
    );
  }
  const waterMinimumX = water.x * TERRAIN_CELL_SIZE;
  const waterMinimumZ = water.z * TERRAIN_CELL_SIZE;
  assert.equal(
    countLineSegment(
      terrain.waterGrid!,
      [waterMinimumX, waterMinimumZ],
      [waterMinimumX + TERRAIN_CELL_SIZE, waterMinimumZ + TERRAIN_CELL_SIZE],
    ),
    1,
    '每个水格都应保留 water.scene 线框中的三角面对角线',
  );
  assert.equal(terrain.waterShore!.getAttribute('position').count % 6, 0);
  const splashPositions = terrain.waterSplash!.getAttribute('position');
  assert.ok(splashPositions.count > 0);
  assert.equal(terrain.waterSplash!.getAttribute('aPhase').count, splashPositions.count);
  assert.equal(terrain.waterSplash!.getAttribute('aScale').count, splashPositions.count);
  assert.equal(terrain.waterSplash!.getAttribute('aDirection').count, splashPositions.count);
  terrain.groundFill.dispose();
  terrain.groundGrid.dispose();
  terrain.waterSurface?.dispose();
  terrain.waterGrid?.dispose();
  terrain.waterShore?.dispose();
  terrain.waterSplash?.dispose();
});

test('配置海平面同时驱动水体填充与渲染，并保留实体岸线宽度', () => {
  const seaLevel = -0.4;
  assert.ok(
    seaLevel + WATER_DEFINITION.waveHeight
      <= -STREAMED_WATER_SHORE_CLEARANCE,
    '最高波峰也必须低于岸面',
  );
  assert.ok(STREAMED_WATER_SHORE_WIDTH >= 0.05);
});

test('水面使用蓝色系顶点色，并随斜海床深度连续变深', () => {
  const rampWater = encodeTerrainCell(
    -1,
    TERRAIN_SURFACE.WATER,
    TERRAIN_SHAPE.RAMP_NORTH,
  );
  const dryGround = encodeTerrainCell(
    0,
    TERRAIN_SURFACE.GROUND,
    TERRAIN_SHAPE.FLAT,
  );
  const terrain = createTerrainChunkGeometry({
    worldSeed: SEED,
    chunkX: 0,
    chunkZ: 0,
    groundColor: '#f1eddf',
    oceanDefinition: WATER_DEFINITION,
    seaLevel: -0.4,
    cellCodeAt: (cellX, cellZ) => (
      cellX === 0 && cellZ === 0 ? rampWater : dryGround
    ),
  });
  const colors = terrain.waterSurface!.getAttribute('color');
  const luminance = (index: number): number => (
    colors.getX(index) * 0.2126
    + colors.getY(index) * 0.7152
    + colors.getZ(index) * 0.0722
  );
  assert.ok(colors.getZ(1) > colors.getX(1), '浅水应保持蓝色系');
  assert.ok(luminance(0) < luminance(1), '同一三角面中更深的西南角应更暗');
  assert.deepEqual(
    [colors.getX(0), colors.getY(0), colors.getZ(0)],
    [colors.getX(2), colors.getY(2), colors.getZ(2)],
    '同深度角点应得到同一颜色',
  );
  terrain.groundFill.dispose();
  terrain.groundGrid.dispose();
  terrain.waterSurface?.dispose();
  terrain.waterGrid?.dispose();
  terrain.waterShore?.dispose();
  terrain.waterSplash?.dispose();
});

test('连续水域跨 chunk 只绘制一条共享边，波浪顶点保持世界坐标', () => {
  const seam = findWaterSeam();
  const left = createTerrainChunkGeometry({
    worldSeed: SEED,
    chunkX: seam.leftChunkX,
    chunkZ: seam.chunkZ,
    groundColor: '#f1eddf',
    oceanDefinition: WATER_DEFINITION,
  });
  const right = createTerrainChunkGeometry({
    worldSeed: SEED,
    chunkX: seam.leftChunkX + 1,
    chunkZ: seam.chunkZ,
    groundColor: '#f1eddf',
    oceanDefinition: WATER_DEFINITION,
  });
  assert.ok(left.waterGrid && right.waterGrid);
  const seamX = (seam.cellX + 1) * TERRAIN_CELL_SIZE;
  const minimumZ = seam.cellZ * TERRAIN_CELL_SIZE;
  const maximumZ = minimumZ + TERRAIN_CELL_SIZE;
  assert.equal(
    countLineSegment(left.waterGrid!, [seamX, minimumZ], [seamX, maximumZ])
      + countLineSegment(right.waterGrid!, [seamX, minimumZ], [seamX, maximumZ]),
    1,
  );
  for (const terrain of [left, right]) {
    terrain.groundFill.dispose();
    terrain.groundGrid.dispose();
    terrain.waterSurface?.dispose();
    terrain.waterGrid?.dispose();
    terrain.waterShore?.dispose();
    terrain.waterSplash?.dispose();
  }
});

test('两类角坡的四个方向都沿特殊角点对角线切分顶面', () => {
  for (const { shape, northWestSouthEast } of CORNER_DIAGONALS) {
    const cell = findCell(TERRAIN_SURFACE.GROUND, shape);
    const chunkX = Math.floor(cell.x / TERRAIN_GRID);
    const chunkZ = Math.floor(cell.z / TERRAIN_GRID);
    const terrain = createTerrainChunkGeometry({
      worldSeed: SEED,
      chunkX,
      chunkZ,
      groundColor: '#f1eddf',
    });
    const minimumX = cell.x * TERRAIN_CELL_SIZE;
    const maximumX = minimumX + TERRAIN_CELL_SIZE;
    const minimumZ = cell.z * TERRAIN_CELL_SIZE;
    const maximumZ = minimumZ + TERRAIN_CELL_SIZE;
    const expected = northWestSouthEast
      ? [cornerKey(minimumX, maximumZ), cornerKey(maximumX, minimumZ)].sort()
      : [cornerKey(minimumX, minimumZ), cornerKey(maximumX, maximumZ)].sort();
    assert.deepEqual(topDiagonalForCell(terrain, cell.x, cell.z), expected, `shape ${shape}`);
    terrain.groundFill.dispose();
    terrain.groundGrid.dispose();
    terrain.waterSurface?.dispose();
    terrain.waterGrid?.dispose();
    terrain.waterShore?.dispose();
    terrain.waterSplash?.dispose();
  }
});

test('TerrainWorld 射线、斜坡采样与浮力高度保持一致', () => {
  const world = new TerrainWorld(SEED, -0.4);
  const ramp = findCell(TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.RAMP_EAST);
  const centerZ = (ramp.z + 0.5) * TERRAIN_CELL_SIZE;
  const from = { x: (ramp.x + 0.1) * TERRAIN_CELL_SIZE, z: centerZ };
  const to = { x: (ramp.x + 0.9) * TERRAIN_CELL_SIZE, z: centerZ };
  assert.ok(world.sampleGroundHeight(to.x, to.z) > world.sampleGroundHeight(from.x, from.z));

  const hit = world.raycast([to.x, 10, to.z], [0, -1, 0], 20);
  assert.ok(hit);
  assert.ok(Math.abs(hit!.y - world.sampleGroundHeight(to.x, to.z)) < 1e-6);

  const water = findCell(TERRAIN_SURFACE.WATER);
  const waterCenter = {
    x: (water.x + 0.5) * TERRAIN_CELL_SIZE,
    z: (water.z + 0.5) * TERRAIN_CELL_SIZE,
  };
  const riverbed = world.sampleGroundHeight(waterCenter.x, waterCenter.z);
  assert.ok(riverbed < -0.18);
  assert.ok(
    Math.abs(world.sampleMovementHeight(waterCenter.x, waterCenter.z, 0.18) + 0.58) < 1e-9,
  );
});

test('TerrainWorld 的稀疏编辑会同时驱动采样与 chunk 水面几何，并可恢复默认值', () => {
  const world = new TerrainWorld(SEED, -0.4);
  assert.equal(world.editor.flood(0, 0), true);
  assert.equal(world.patches.size, 1);
  assert.equal(world.sampleGroundHeight(1, 1), -1);
  assert.ok(Math.abs(world.sampleWaterDepth(1, 1) - 0.6) < 1e-6);

  const terrain = createTerrainChunkGeometry({
    worldSeed: SEED,
    chunkX: 0,
    chunkZ: 0,
    groundColor: '#f1eddf',
    oceanDefinition: WATER_DEFINITION,
    seaLevel: world.seaLevel,
    cellCodeAt: (cellX, cellZ) => world.patches.cellCodeAt(cellX, cellZ),
  });
  assert.ok(terrain.waterGrid);
  assert.equal(
    countLineSegment(
      terrain.waterGrid!,
      [0, 0],
      [TERRAIN_CELL_SIZE, TERRAIN_CELL_SIZE],
    ),
    1,
  );

  assert.equal(world.resetCell(0, 0), true);
  assert.equal(world.patches.size, 0);
  assert.equal(world.sampleGroundHeight(1, 1), 0);
  terrain.groundFill.dispose();
  terrain.groundGrid.dispose();
  terrain.waterSurface?.dispose();
  terrain.waterGrid?.dispose();
  terrain.waterShore?.dispose();
  terrain.waterSplash?.dispose();
});

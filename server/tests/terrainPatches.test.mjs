import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeTerrainCell,
  sampleTerrain,
  terrainCellCodeAt,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_CELL_SIZE,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import {
  TerrainEditor,
  TERRAIN_RAMP_DIRECTION,
} from '../../shared/world/terrainEditing.mjs';
import { TerrainPatchStore } from '../../shared/world/terrainPatches.mjs';
import { terrainWaterDepth } from '../../shared/world/terrainWater.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';

test('TerrainPatchStore 只保存偏离默认生成结果的格子，并按 chunk 紧凑导出', () => {
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const baseline = terrainCellCodeAt(DEFAULT_WORLD_SEED, -1, 1);
  const override = encodeTerrainCell(3, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.RAMP_EAST);

  assert.equal(patches.size, 0);
  assert.equal(patches.cellCodeAt(-1, 1), baseline);
  assert.equal(patches.setCellCode(-1, 1, override), true);
  assert.equal(patches.setCellCode(-1, 1, override), false);
  assert.equal(patches.size, 1);
  assert.equal(patches.cellCodeAt(-1, 1), override);
  assert.deepEqual(
    [...patches.readChunk(-1, 0)],
    [31, override],
    '负坐标 -1 应落到 chunk -1 的 localX=15',
  );

  assert.equal(patches.setCellCode(-1, 1, baseline), true);
  assert.equal(patches.size, 0);
  assert.equal(patches.readChunk(-1, 0).length, 0);
});

test('边界 patch 只通知当前 chunk 与读取该边界的相邻 chunk', () => {
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const changes = [];
  const unsubscribe = patches.subscribe((change) => changes.push(change));
  patches.setCellCode(
    0,
    0,
    encodeTerrainCell(2, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT),
  );
  unsubscribe();

  assert.equal(changes.length, 1);
  assert.deepEqual(
    changes[0].affectedChunks.map((chunk) => chunk.key).sort(),
    ['-1:0', '0:-1', '0:0'],
  );
});

test('共享地形采样可以读取同一份稀疏地形覆盖', () => {
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const override = encodeTerrainCell(2, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT);
  patches.setCellCode(0, 0, override);
  const cellCodeAt = (cellX, cellZ) => patches.cellCodeAt(cellX, cellZ);
  const center = { x: TERRAIN_CELL_SIZE * 0.5, z: TERRAIN_CELL_SIZE * 0.5 };

  assert.equal(
    sampleTerrain(DEFAULT_WORLD_SEED, center.x, center.z, {}, cellCodeAt).groundY,
    2,
  );
});

test('孤立深坑保持干燥，只有低于海平面且四邻域接水时才成为水域', () => {
  const seaLevel = -0.4;
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const editor = new TerrainEditor(patches, { seaLevel });

  editor.lower(0, 0, 1);
  const dryPit = editor.readCell(0, 0);
  assert.equal(dryPit.heightLevel, -1);
  assert.equal(dryPit.surface, TERRAIN_SURFACE.GROUND);
  assert.equal(dryPit.waterDepth, 0);

  let shore;
  for (let z = -128; z < 128 && !shore; z += 1) {
    for (let x = -128; x < 128 && !shore; x += 1) {
      if (terrainCellSurface(terrainCellCodeAt(DEFAULT_WORLD_SEED, x, z)) !== TERRAIN_SURFACE.GROUND) {
        continue;
      }
      const neighbors = [[0, 1], [1, 0], [0, -1], [-1, 0]];
      if (neighbors.some(([dx, dz]) => (
        terrainCellSurface(terrainCellCodeAt(DEFAULT_WORLD_SEED, x + dx, z + dz))
          === TERRAIN_SURFACE.WATER
      ))) shore = { x, z };
    }
  }
  assert.ok(shore);
  const shoreLevel = terrainCellHeightLevel(patches.cellCodeAt(shore.x, shore.z));
  editor.lower(shore.x, shore.z, shoreLevel + 1);
  const flooded = editor.readCell(shore.x, shore.z);
  assert.equal(flooded.heightLevel, -1);
  assert.equal(flooded.surface, TERRAIN_SURFACE.WATER);
  assert.ok(Math.abs(flooded.waterDepth - 0.6) < 1e-9);

  editor.setSurface(shore.x, shore.z, TERRAIN_SURFACE.GROUND);
  const preservedBed = editor.readCell(shore.x, shore.z);
  assert.equal(preservedBed.heightLevel, -1, '切换类型不能把海床重新抬到海平面');
  assert.equal(preservedBed.waterDepth, 0);
});

test('显式注水会原子降低过高河床并形成可见水深', () => {
  const seaLevel = -0.4;
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const editor = new TerrainEditor(patches, { seaLevel });
  const before = editor.readCell(0, 0);
  assert.equal(before.surface, TERRAIN_SURFACE.GROUND);
  assert.equal(before.waterDepth, 0);

  assert.equal(editor.flood(0, 0), true);
  const flooded = editor.readCell(0, 0);
  assert.equal(flooded.surface, TERRAIN_SURFACE.WATER);
  assert.ok(flooded.bedY < seaLevel);
  assert.ok(flooded.waterDepth > 0);
  assert.equal(patches.size, 1, '注水的河床与 surface 应由同一个 patch 原子保存');
});

test('抬高水格至海面以上会清除 WATER，避免高台继续触发浮力', () => {
  const seaLevel = 0;
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const editor = new TerrainEditor(patches, { seaLevel });
  const cellX = -60;
  const cellZ = -60;

  patches.setCellCode(
    cellX,
    cellZ,
    encodeTerrainCell(-1, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT),
  );
  assert.equal(editor.readCell(cellX, cellZ).surface, TERRAIN_SURFACE.WATER);
  assert.ok(editor.readCell(cellX, cellZ).waterDepth > 0);

  editor.raise(cellX, cellZ, 1);
  const raised = editor.readCell(cellX, cellZ);
  assert.equal(raised.heightLevel, 0);
  assert.equal(raised.surface, TERRAIN_SURFACE.GROUND);
  assert.equal(raised.waterDepth, 0);

  editor.raise(cellX, cellZ, 2);
  const platform = editor.readCell(cellX, cellZ);
  assert.equal(platform.heightLevel, 2);
  assert.equal(platform.surface, TERRAIN_SURFACE.GROUND);
  assert.equal(platform.waterDepth, 0);
});

test('稀疏编辑器抬高、下挖和四向斜坡都只改目标字段', () => {
  const patches = new TerrainPatchStore(DEFAULT_WORLD_SEED);
  const editor = new TerrainEditor(patches, { seaLevel: -0.4 });
  const original = patches.cellCodeAt(0, 0);

  editor.raise(0, 0, 2);
  assert.equal(terrainCellHeightLevel(patches.cellCodeAt(0, 0)), 2);
  assert.equal(terrainCellSurface(patches.cellCodeAt(0, 0)), terrainCellSurface(original));

  const directions = [
    [TERRAIN_RAMP_DIRECTION.NORTH, TERRAIN_SHAPE.RAMP_NORTH],
    [TERRAIN_RAMP_DIRECTION.EAST, TERRAIN_SHAPE.RAMP_EAST],
    [TERRAIN_RAMP_DIRECTION.SOUTH, TERRAIN_SHAPE.RAMP_SOUTH],
    [TERRAIN_RAMP_DIRECTION.WEST, TERRAIN_SHAPE.RAMP_WEST],
  ];
  for (const [direction, shape] of directions) {
    editor.setRamp(0, 0, direction);
    assert.equal(terrainCellShape(patches.cellCodeAt(0, 0)), shape);
    assert.equal(terrainCellHeightLevel(patches.cellCodeAt(0, 0)), 2);
  }

  editor.lower(0, 0, 1);
  const sample = sampleTerrain(
    DEFAULT_WORLD_SEED,
    TERRAIN_CELL_SIZE * 0.5,
    TERRAIN_CELL_SIZE * 0.5,
    {},
    (x, z) => patches.cellCodeAt(x, z),
  );
  assert.equal(terrainWaterDepth(sample, -0.4), 0);
  assert.equal(terrainCellHeightLevel(sample.code), 1);
  assert.equal(terrainCellShape(sample.code), TERRAIN_SHAPE.RAMP_WEST);
  assert.equal(patches.size, 1);
});

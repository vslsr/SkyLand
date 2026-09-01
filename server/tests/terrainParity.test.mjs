import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readWasmTerrainCellCode } from '../../shared/world/chunkGeneratorWasm.mjs';
import {
  terrainCellCodeAt,
  terrainCellHeightLevel,
  terrainCellShape,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_GRID,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';

const WASM_PATH = fileURLToPath(new URL('../../shared/world/wasm/chunkgen.wasm', import.meta.url));

/** 与 chunkGenerator.test.mjs 的放置比对覆盖同一片 chunk。 */
const CHUNK_MINIMUM = -4;
const CHUNK_MAXIMUM = 4;
const CELL_MINIMUM = CHUNK_MINIMUM * TERRAIN_GRID;
const CELL_MAXIMUM = (CHUNK_MAXIMUM + 1) * TERRAIN_GRID - 1;

const SHAPE_NAME = Object.fromEntries(
  Object.entries(TERRAIN_SHAPE).map(([name, value]) => [value, name]),
);

async function instantiateTerrain() {
  const { instance } = await WebAssembly.instantiate(await readFile(WASM_PATH), {});
  return instance;
}

/**
 * 扫一片格子，逐格比对两个后端，并统计实际覆盖到的形状与表面。
 * @param {WebAssembly.Instance} instance
 * @param {number} seed
 */
function compareArea(instance, seed, minimum, maximum) {
  const shapes = new Map();
  const surfaces = new Map();
  let cells = 0;
  for (let cellZ = minimum; cellZ <= maximum; cellZ += 1) {
    for (let cellX = minimum; cellX <= maximum; cellX += 1) {
      const fromJavaScript = terrainCellCodeAt(seed, cellX, cellZ);
      const fromWasm = readWasmTerrainCellCode(instance, seed, cellX, cellZ);
      if (fromWasm !== fromJavaScript) {
        // 出错时把三个字段都拆开报出来，省得再拿 code 手算一遍。
        assert.fail(
          `种子 ${seed >>> 0} 的格 (${cellX}, ${cellZ}) 两端不一致：`
          + `wasm 高度 ${terrainCellHeightLevel(fromWasm)} 表面 ${terrainCellSurface(fromWasm)} `
          + `形状 ${SHAPE_NAME[terrainCellShape(fromWasm)]}，`
          + `js 高度 ${terrainCellHeightLevel(fromJavaScript)} 表面 ${terrainCellSurface(fromJavaScript)} `
          + `形状 ${SHAPE_NAME[terrainCellShape(fromJavaScript)]}`,
        );
      }
      const shape = terrainCellShape(fromJavaScript);
      const surface = terrainCellSurface(fromJavaScript);
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      surfaces.set(surface, (surfaces.get(surface) ?? 0) + 1);
      cells += 1;
    }
  }
  return { cells, shapes, surfaces };
}

test('WASM 与 JS 的地形逐格相同，覆盖全部形状与水面', async () => {
  const instance = await instantiateTerrain();
  const { cells, shapes, surfaces } = compareArea(
    instance,
    DEFAULT_WORLD_SEED,
    CELL_MINIMUM,
    CELL_MAXIMUM,
  );
  assert.equal(cells, (CELL_MAXIMUM - CELL_MINIMUM + 1) ** 2);

  // 这一条是这个测试的护栏。物件只落在平地上（placement.rs 的 FLAT/GROUND
  // 过滤），所以放置记录的 parity 永远采样不到斜坡、角点和水面。如果将来生成
  // 参数变得扫不出这些形状，必须在这里报错，而不是让覆盖率悄悄退回只有平地。
  for (const [name, value] of Object.entries(TERRAIN_SHAPE)) {
    assert.ok(
      (shapes.get(value) ?? 0) > 0,
      `扫描区里没有出现形状 ${name}，地形比对已经退化为只覆盖部分分支`,
    );
  }
  assert.ok((surfaces.get(TERRAIN_SURFACE.GROUND) ?? 0) > 0, '扫描区里应该有陆地');
  assert.ok((surfaces.get(TERRAIN_SURFACE.WATER) ?? 0) > 0, '扫描区里应该有水面');
});

test('换种子仍然逐格相同，负坐标也一样', async () => {
  const instance = await instantiateTerrain();
  for (const seed of [0, 1, 0x5c1a2d0b, 0xdead_beef, 0xffff_ffff]) {
    // 只取负坐标区：cell → chunk 的取整在两端分别是 div_euclid 与 Math.floor，
    // 一旦有人换掉其中一侧，负半轴是最先分裂的地方。
    const { cells } = compareArea(instance, seed, -48, -1);
    assert.equal(cells, 48 * 48);
  }
});

test('原点附近的出生安全区在两端是同一片平地', async () => {
  const instance = await instantiateTerrain();
  for (let cellZ = -6; cellZ <= 6; cellZ += 1) {
    for (let cellX = -6; cellX <= 6; cellX += 1) {
      const code = terrainCellCodeAt(DEFAULT_WORLD_SEED, cellX, cellZ);
      assert.equal(readWasmTerrainCellCode(instance, DEFAULT_WORLD_SEED, cellX, cellZ), code);
    }
  }
});

test('缺少 terrain_cell_code_at 导出时给出可诊断的错误', async () => {
  // 忘了 npm run build:wasm 是这个仓库最容易犯的错，报错必须直说是产物没重建。
  assert.throws(
    () => readWasmTerrainCellCode({ exports: {} }, DEFAULT_WORLD_SEED, 0, 0),
    /terrain_cell_code_at 导出/,
  );
});

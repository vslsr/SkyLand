import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainWorld } from '../src/world/TerrainWorld';

/**
 * 渲染世界自己那一份地形（实现路径文档 §3）。
 *
 * 天气要按地面高度落雨。它原来收一个指向玩法侧 `TerrainWorld` 的回调——
 * 渲染侧每帧反向读一次玩法侧，而回调过不了线程边界。
 *
 * 现在两侧各按同一个种子建一份。这一组钉住那个办法成立的两个条件：
 * **同种子必然同高度**，以及**编辑镜像过去之后仍然一致**。
 * 第二条失效的症状很轻微——雨落在被改过的地形的旧高度上——轻微到不会有人报 bug，
 * 所以得有条用例盯着。
 */

const SEED = 0x5c1a2d0b;
const SEA_LEVEL = 0;

/** 找一个地形高度会随编辑变化的格子，返回它的世界坐标与原始高度。 */
function findSampleCell(): { x: number; z: number; cellX: number; cellZ: number } {
  const probe = new TerrainWorld(SEED, SEA_LEVEL);
  for (let cellX = 0; cellX < 24; cellX += 1) {
    for (let cellZ = 0; cellZ < 24; cellZ += 1) {
      // 格中心；TERRAIN_CELL_SIZE 是 2 米。
      const x = cellX * 2 + 1;
      const z = cellZ * 2 + 1;
      if (Number.isFinite(probe.sampleGroundHeight(x, z))) return { x, z, cellX, cellZ };
    }
  }
  throw new Error('没找到可采样的地形格');
}

test('同一个种子建两份地形，高度逐点相同——这是两侧各推各的前提', () => {
  const game = new TerrainWorld(SEED, SEA_LEVEL);
  const render = new TerrainWorld(SEED, SEA_LEVEL);
  for (let index = 0; index < 200; index += 1) {
    const x = (index % 20) * 3.7 - 30;
    const z = Math.floor(index / 20) * 4.3 - 20;
    assert.equal(
      render.sampleGroundHeight(x, z),
      game.sampleGroundHeight(x, z),
      `(${x}, ${z}) 两侧地形不一致`,
    );
  }
});

test('编辑镜像过去之后两份仍然一致；不镜像就会分叉', () => {
  const cell = findSampleCell();
  const game = new TerrainWorld(SEED, SEA_LEVEL);
  const render = new TerrainWorld(SEED, SEA_LEVEL);
  const before = game.sampleGroundHeight(cell.x, cell.z);

  // 找一个真的会改变高度的格子码——地形码不是所有值都对应不同高度。
  let editedCode: number | undefined;
  for (let code = 0; code < 64; code += 1) {
    const probe = new TerrainWorld(SEED, SEA_LEVEL);
    probe.setCellCode(cell.cellX, cell.cellZ, code);
    if (probe.sampleGroundHeight(cell.x, cell.z) !== before) {
      editedCode = code;
      break;
    }
  }
  assert.ok(editedCode !== undefined, '没找到会改变高度的格子码');

  // 只改玩法侧：两份分叉——这正是「不镜像」会发生的事。
  game.setCellCode(cell.cellX, cell.cellZ, editedCode);
  assert.notEqual(
    render.sampleGroundHeight(cell.x, cell.z),
    game.sampleGroundHeight(cell.x, cell.z),
    '这一步该分叉，否则这条用例证明不了镜像有用',
  );

  // 把同一批格子镜像过去（`SceneWorld.applyTerrainPatches` 做的就是这件事）。
  render.setCellCode(cell.cellX, cell.cellZ, editedCode);
  assert.equal(
    render.sampleGroundHeight(cell.x, cell.z),
    game.sampleGroundHeight(cell.x, cell.z),
    '镜像之后两侧必须重新一致，否则雨会落在旧高度上',
  );
});

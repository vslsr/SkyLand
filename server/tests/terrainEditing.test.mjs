import assert from 'node:assert/strict';
import test from 'node:test';
import { TERRAIN_CELL_SIZE, TERRAIN_SURFACE } from '../../shared/world/terrainConfig.mjs';
import {
  sampleTerrain,
  terrainCellHeightLevel,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

const SEED = 0x5c1a2d0b;

async function createScene(sceneId = 'open-world') {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require(sceneId), {
    worldSeed: SEED,
    now: () => 1_000_000_000,
  });
  scene.addPlayer({ id: 'builder', name: '建造者', slot: 0 });
  return { scene, player: scene.players.get('builder') };
}

/** 把玩家挪到某一格旁边，返回那一格的坐标。 */
function standNextTo(scene, cellX, cellZ) {
  const centerX = (cellX + 0.5) * TERRAIN_CELL_SIZE;
  const centerZ = (cellZ + 0.5) * TERRAIN_CELL_SIZE;
  scene.players.get('builder').setPosition(centerX, centerZ);
  return { centerX, centerZ };
}

/** 找一格玩家够得到、且当前是陆地的格子。 */
function nearbyGroundCell(scene) {
  const player = scene.players.get('builder');
  const baseX = Math.floor(player.x / TERRAIN_CELL_SIZE);
  const baseZ = Math.floor(player.z / TERRAIN_CELL_SIZE);
  for (let radius = 0; radius <= 3; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const cellX = baseX + dx;
        const cellZ = baseZ + dz;
        const code = scene.terrainPatches.cellCodeAt(cellX, cellZ);
        if (terrainCellSurface(code) === TERRAIN_SURFACE.GROUND) return { cellX, cellZ };
      }
    }
  }
  return undefined;
}

test('抬高一格会写进权威覆盖层，并立刻改变服务端算出的地面高度', async () => {
  const { scene } = await createScene();
  const cell = nearbyGroundCell(scene);
  assert.ok(cell);
  const { centerX, centerZ } = standNextTo(scene, cell.cellX, cell.cellZ);

  const before = sampleTerrain(SEED, centerX, centerZ, {}, scene.terrainCellCodeAt).groundY;
  const changed = scene.editTerrain('builder', {
    sequence: 1,
    cellX: cell.cellX,
    cellZ: cell.cellZ,
    operation: 'raise',
  });
  assert.equal(changed.length, 1);
  assert.deepEqual(
    { cellX: changed[0].cellX, cellZ: changed[0].cellZ },
    { cellX: cell.cellX, cellZ: cell.cellZ },
  );

  const after = sampleTerrain(SEED, centerX, centerZ, {}, scene.terrainCellCodeAt).groundY;
  assert.ok(after > before, `抬高后地面应该更高：${before} → ${after}`);
  // 基础地形一个字节都没动，改的只是覆盖层。
  assert.equal(sampleTerrain(SEED, centerX, centerZ).groundY, before);
  assert.equal(
    terrainCellHeightLevel(changed[0].code),
    terrainCellHeightLevel(scene.terrainPatches.cellCodeAt(cell.cellX, cell.cellZ)),
  );
});

test('够不到的格子改不动', async () => {
  const { scene } = await createScene();
  const cell = nearbyGroundCell(scene);
  standNextTo(scene, cell.cellX, cell.cellZ);
  // 站在原地去改 40 格外（80 米）的地形。
  const changed = scene.editTerrain('builder', {
    sequence: 1,
    cellX: cell.cellX + 40,
    cellZ: cell.cellZ,
    operation: 'raise',
  });
  assert.deepEqual(changed, []);
  assert.equal(scene.terrainPatches.size, 0);
});

test('重放的序号不生效，未知操作也不生效', async () => {
  const { scene } = await createScene();
  const cell = nearbyGroundCell(scene);
  standNextTo(scene, cell.cellX, cell.cellZ);
  const edit = { cellX: cell.cellX, cellZ: cell.cellZ, operation: 'raise' };

  assert.equal(scene.editTerrain('builder', { ...edit, sequence: 5 }).length, 1);
  // 同一个序号重放：抬第二次不该发生。
  assert.deepEqual(scene.editTerrain('builder', { ...edit, sequence: 5 }), []);
  assert.deepEqual(scene.editTerrain('builder', { ...edit, sequence: 4 }), []);
  assert.equal(scene.terrainPatches.size, 1);

  // 未知操作被拒，但序号照样推进，避免拿坏操作卡住后续合法请求。
  assert.deepEqual(scene.editTerrain('builder', { ...edit, sequence: 6, operation: 'nuke' }), []);
  assert.equal(scene.editTerrain('builder', { ...edit, sequence: 7 }).length, 1);
});

test('还原会把覆盖层删掉，不是写一个等于默认值的 patch', async () => {
  const { scene } = await createScene();
  const cell = nearbyGroundCell(scene);
  standNextTo(scene, cell.cellX, cell.cellZ);
  const edit = { cellX: cell.cellX, cellZ: cell.cellZ };

  scene.editTerrain('builder', { ...edit, sequence: 1, operation: 'raise' });
  assert.equal(scene.terrainPatches.size, 1);
  const restored = scene.editTerrain('builder', { ...edit, sequence: 2, operation: 'reset' });
  assert.equal(restored.length, 1);
  assert.equal(scene.terrainPatches.size, 0, '回到默认就不该继续占状态');
});

test('readTerrainPatches 把已有编辑交给新加入的玩家', async () => {
  const { scene } = await createScene();
  const cell = nearbyGroundCell(scene);
  standNextTo(scene, cell.cellX, cell.cellZ);
  scene.editTerrain('builder', {
    sequence: 1,
    cellX: cell.cellX,
    cellZ: cell.cellZ,
    operation: 'raise',
  });

  const patches = scene.readTerrainPatches();
  assert.equal(patches.length, 1);
  assert.equal(patches[0].cellX, cell.cellX);
  assert.equal(patches[0].cellZ, cell.cellZ);
  assert.equal(patches[0].code, scene.terrainPatches.cellCodeAt(cell.cellX, cell.cellZ));
});

test('非流式场景没有可编辑地形，编辑入口直接是空操作', async () => {
  const { scene } = await createScene('water');
  assert.equal(scene.terrainPatches, undefined);
  assert.deepEqual(
    scene.editTerrain('builder', { sequence: 1, cellX: 0, cellZ: 0, operation: 'raise' }),
    [],
  );
  assert.deepEqual(scene.readTerrainPatches(), []);
});
import './initRapier.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTerrainChunkCodes,
  buildTerrainCollisionMesh,
  buildTerrainCollisionMeshFromCodes,
  sampleTerrainChunkCodes,
  TERRAIN_CHUNK_CODE_SPAN,
} from '../shared/world/terrainCollisionMesh.mjs';
import { TERRAIN_GRID } from '../shared/world/terrainConfig.mjs';
import { TerrainPatchStore } from '../shared/world/terrainPatches.mjs';

/**
 * 地形碰撞网格拆成「采样」+「建网格」两半（实现路径文档 §2 的第 2 项）。
 *
 * 拆开是为了让后一半能扔进工作线程；这组用例守住的是**拆开之后两条路径必须
 * 长出同一块地面**——客户端走 worker、服务端走回调，两边不一样就是穿地。
 */

/** 一片有高有低的地形：全平的话崖面三角一条都不会生成，用例就测不到东西。 */
const codeAt = (cellX: number, cellZ: number): number => (
  ((cellX * 73856093) ^ (cellZ * 19349663)) & 0x3f
);

test('采样窗口是闭区间 [0, TERRAIN_GRID]：东、北两侧的崖面归本格所有', () => {
  assert.equal(TERRAIN_CHUNK_CODE_SPAN, TERRAIN_GRID + 1);
  const codes = sampleTerrainChunkCodes(2, -3, codeAt);
  assert.equal(codes.length, TERRAIN_CHUNK_CODE_SPAN * TERRAIN_CHUNK_CODE_SPAN);
  // 最后一行一列就是多读的那一圈，必须真的取到隔壁格子的码。
  const last = TERRAIN_CHUNK_CODE_SPAN - 1;
  assert.equal(
    codes[last * TERRAIN_CHUNK_CODE_SPAN + last],
    codeAt(2 * TERRAIN_GRID + last, -3 * TERRAIN_GRID + last),
  );
});

test('两条路径逐字节一致——只有一份拓扑实现', () => {
  for (const [chunkX, chunkZ] of [[0, 0], [3, -2], [-5, 7]] as const) {
    const viaCallback = buildTerrainCollisionMesh(chunkX, chunkZ, codeAt);
    const viaCodes = buildTerrainCollisionMeshFromCodes(
      chunkX,
      chunkZ,
      sampleTerrainChunkCodes(chunkX, chunkZ, codeAt),
    );
    assert.equal(viaCodes.triangleCount, viaCallback.triangleCount);
    assert.deepEqual(Array.from(viaCodes.vertices), Array.from(viaCallback.vertices));
    assert.deepEqual(Array.from(viaCodes.indices), Array.from(viaCallback.indices));
    assert.ok(viaCallback.triangleCount > TERRAIN_GRID * TERRAIN_GRID * 2, '这片地形应当有崖面');
  }
});

test('窗口尺寸不对就直接报错，而不是默默长出一块缺角的地面', () => {
  assert.throws(
    () => buildTerrainCollisionMeshFromCodes(0, 0, new Int32Array(TERRAIN_GRID * TERRAIN_GRID)),
    /window/,
  );
});

/**
 * 工作线程只拿到「世界种子 + 这一窗里的编辑覆盖」，格子码由它自己推。
 *
 * 这条等价性是整条链路的安全绳：推错一格，玩家脚下的碰撞网格就和看到的地面
 * 对不上——而那是穿地，不是画面瑕疵。
 */
const WORLD_SEED = 1337;

/** 照 ChunkStreamer 的做法把覆盖摊成三元组：窗口跨四个 chunk。 */
function collectOverrides(store: TerrainPatchStore, chunkX: number, chunkZ: number): Int32Array {
  const triples: number[] = [];
  for (const [offsetX, offsetZ] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const neighbourX = chunkX + offsetX;
    const neighbourZ = chunkZ + offsetZ;
    const patch = store.readChunk(neighbourX, neighbourZ);
    for (let index = 0; index + 1 < patch.length; index += 2) {
      const localIndex = patch[index];
      triples.push(
        neighbourX * TERRAIN_GRID + (localIndex % TERRAIN_GRID),
        neighbourZ * TERRAIN_GRID + Math.floor(localIndex / TERRAIN_GRID),
        patch[index + 1],
      );
    }
  }
  return Int32Array.from(triples);
}

test('没有编辑时，工作线程推出来的格子码和权威存储逐格相同', () => {
  const store = new TerrainPatchStore(WORLD_SEED);
  for (const [chunkX, chunkZ] of [[0, 0], [4, -1]] as const) {
    assert.deepEqual(
      Array.from(buildTerrainChunkCodes(WORLD_SEED, chunkX, chunkZ, new Int32Array())),
      Array.from(sampleTerrainChunkCodes(
        chunkX,
        chunkZ,
        (cellX: number, cellZ: number) => store.cellCodeAt(cellX, cellZ),
      )),
    );
  }
});

test('编辑过的格子也要一致，包括落在东、北那多出来的一行一列上的', () => {
  const store = new TerrainPatchStore(WORLD_SEED);
  const chunkX = 2;
  const chunkZ = 3;
  const originCellX = chunkX * TERRAIN_GRID;
  const originCellZ = chunkZ * TERRAIN_GRID;
  const flip = (cellX: number, cellZ: number): void => {
    // 改成一个和默认值不同的码，否则 setCellCode 会把 patch 删掉。
    const current = store.cellCodeAt(cellX, cellZ);
    store.setCellCode(cellX, cellZ, current ^ 0b100);
  };
  flip(originCellX + 1, originCellZ + 1);              // 本 chunk 内
  flip(originCellX + TERRAIN_GRID, originCellZ + 2);   // 东邻的那一列
  flip(originCellX + 3, originCellZ + TERRAIN_GRID);   // 北邻的那一行
  flip(originCellX + TERRAIN_GRID, originCellZ + TERRAIN_GRID); // 对角那一格

  const derived = buildTerrainChunkCodes(
    WORLD_SEED,
    chunkX,
    chunkZ,
    collectOverrides(store, chunkX, chunkZ),
  );
  const authoritative = sampleTerrainChunkCodes(
    chunkX,
    chunkZ,
    (cellX: number, cellZ: number) => store.cellCodeAt(cellX, cellZ),
  );
  assert.deepEqual(Array.from(derived), Array.from(authoritative));
  // 反过来确认这条用例真的碰到了覆盖层，而不是两边都是默认地形。
  const untouched = buildTerrainChunkCodes(WORLD_SEED, chunkX, chunkZ, new Int32Array());
  assert.notDeepEqual(Array.from(derived), Array.from(untouched));
});

test('窗口外的覆盖格被忽略，不会写坏相邻 chunk 的那一窗', () => {
  const outside = Int32Array.from([-999, -999, 7]);
  assert.deepEqual(
    Array.from(buildTerrainChunkCodes(WORLD_SEED, 0, 0, outside)),
    Array.from(buildTerrainChunkCodes(WORLD_SEED, 0, 0, new Int32Array())),
  );
});

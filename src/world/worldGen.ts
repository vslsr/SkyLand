import { CHUNK_HALF_SIZE, isSpawnChunk } from '../../shared/chunkCoordinates.mjs';

export interface TreePlacement {
  x: number;
  z: number;
  rotation: number;
  scale: number;
}

export interface GrassPatch {
  x: number;
  z: number;
  bladeCount: number;
  scale: number;
  rotation: number;
}

/** 一个地块的内容，坐标都是相对地块中心的局部坐标。 */
export interface ChunkContent {
  trees: TreePlacement[];
  grassPatches: GrassPatch[];
}

// 出生地保持原来手工摆放的布局，向外才程序化生成。
const SPAWN_TREES: readonly TreePlacement[] = [
  { x: -5.2, z: -3.8, rotation: 0.14, scale: 1.05 },
  { x: 0.5, z: -8.2, rotation: -0.22, scale: 1.34 },
  { x: 5.1, z: -4.8, rotation: 0.3, scale: 0.92 },
];

const SPAWN_GRASS: readonly GrassPatch[] = [
  { x: -7.2, z: 1.4, bladeCount: 3, scale: 1.05, rotation: 0.2 },
  { x: -4.2, z: 0.3, bladeCount: 2, scale: 0.9, rotation: 1.1 },
  { x: -2.1, z: -3.2, bladeCount: 3, scale: 1.15, rotation: 2.2 },
  { x: 1.8, z: 0.8, bladeCount: 2, scale: 0.82, rotation: 0.5 },
  { x: 4.2, z: -1.3, bladeCount: 3, scale: 1.2, rotation: 1.8 },
  { x: 7.4, z: -3.8, bladeCount: 2, scale: 0.96, rotation: 2.7 },
  { x: -7.8, z: -6.6, bladeCount: 2, scale: 1.1, rotation: 1.4 },
  { x: -2.8, z: -7.5, bladeCount: 3, scale: 0.88, rotation: 0.7 },
  { x: 3.3, z: -9.2, bladeCount: 2, scale: 1.08, rotation: 2.4 },
  { x: 7.6, z: -8.0, bladeCount: 3, scale: 0.86, rotation: 0.1 },
  { x: -9.8, z: -11.0, bladeCount: 3, scale: 1, rotation: 2 },
  { x: 0.1, z: -12.5, bladeCount: 2, scale: 1.15, rotation: 0.9 },
  { x: 9.6, z: -12.0, bladeCount: 3, scale: 0.92, rotation: 1.5 },
];

// 抖动网格：把地块切成均匀的格子，每格按概率放一个物体并在格内随机偏移。
// 比纯随机撒点更不容易出现空洞和堆叠，而且格子数就是数量上限。
const TREE_GRID = 3;
const TREE_CHANCE = 0.42;
const GRASS_GRID = 4;
const GRASS_CHANCE = 0.8;
const EDGE_MARGIN = 1.6;

function hashChunk(chunkX: number, chunkZ: number): number {
  let hash = 2166136261;
  for (const value of [chunkX, chunkZ]) {
    // 先把有符号整数折叠成非负数，避免 -1 和 1 撞到一起。
    let folded = value < 0 ? -value * 2 - 1 : value * 2;
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= folded & 0xff;
      hash = Math.imul(hash, 16777619);
      folded >>>= 8;
    }
  }
  return hash >>> 0;
}

/** mulberry32：小而稳定的伪随机数发生器，同一个种子永远给出同一串数。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function scatter(
  random: () => number,
  gridSize: number,
  chance: number,
  emit: (x: number, z: number, random: () => number) => void,
): void {
  const span = (CHUNK_HALF_SIZE - EDGE_MARGIN) * 2;
  const cell = span / gridSize;
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      if (random() > chance) continue;
      const originX = -CHUNK_HALF_SIZE + EDGE_MARGIN + column * cell;
      const originZ = -CHUNK_HALF_SIZE + EDGE_MARGIN + row * cell;
      emit(originX + random() * cell, originZ + random() * cell, random);
    }
  }
}

/** 同一个地块坐标永远生成同一份内容，不需要保存，也不需要在网络上传输。 */
export function createChunkContent(chunkX: number, chunkZ: number): ChunkContent {
  if (isSpawnChunk(chunkX, chunkZ)) {
    return { trees: [...SPAWN_TREES], grassPatches: [...SPAWN_GRASS] };
  }

  const random = createRandom(hashChunk(chunkX, chunkZ));
  const trees: TreePlacement[] = [];
  const grassPatches: GrassPatch[] = [];

  scatter(random, TREE_GRID, TREE_CHANCE, (x, z, next) => {
    trees.push({ x, z, rotation: next() * Math.PI * 2, scale: 0.85 + next() * 0.55 });
  });

  scatter(random, GRASS_GRID, GRASS_CHANCE, (x, z, next) => {
    grassPatches.push({
      x,
      z,
      bladeCount: 2 + Math.floor(next() * 2),
      scale: 0.82 + next() * 0.4,
      rotation: next() * Math.PI * 2,
    });
  });

  return { trees, grassPatches };
}

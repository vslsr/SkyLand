import {
  terrainCellCodeAt,
  terrainCellCornerHeight,
  terrainCellShape,
} from './terrainContent.mjs';
import {
  TERRAIN_CELL_SIZE,
  TERRAIN_GRID,
  TERRAIN_SHAPE,
} from './terrainConfig.mjs';

/** Heightfields cannot represent SkyLand's vertical one-metre cliff faces; use a trimesh. */
export function usesNorthWestSouthEastDiagonal(shape) {
  return shape === TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST
    || shape === TERRAIN_SHAPE.CORNER_HIGH_SOUTH_EAST
    || shape === TERRAIN_SHAPE.CORNER_LOW_NORTH_WEST
    || shape === TERRAIN_SHAPE.CORNER_LOW_SOUTH_EAST;
}

/** Shared top-face topology used by both Three.js rendering and Rapier collision. */
export function terrainTopTriangles(shape, corners) {
  const [southWest, southEast, northEast, northWest] = corners;
  return usesNorthWestSouthEastDiagonal(shape)
    ? [southWest, northWest, southEast, northWest, northEast, southEast]
    : [southWest, northEast, southEast, southWest, northWest, northEast];
}

function createVertexAppender(vertices, indices) {
  const lookup = new Map();
  const indexOf = (point) => {
    const key = `${point.x},${point.y},${point.z}`;
    let index = lookup.get(key);
    if (index !== undefined) return index;
    index = vertices.length / 3;
    lookup.set(key, index);
    vertices.push(point.x, point.y, point.z);
    return index;
  };
  return (a, b, c) => indices.push(indexOf(a), indexOf(b), indexOf(c));
}

/**
 * 建一块 chunk 的网格要读的格子码窗口边长。
 *
 * 网格按格子铺三角，但东、北两侧的崖面归本格所有，所以还要多读一行一列——
 * 正好是 `TERRAIN_GRID + 1`。窗口是闭区间 `[0, TERRAIN_GRID]`，不是开区间。
 */
export const TERRAIN_CHUNK_CODE_SPAN = TERRAIN_GRID + 1;

/**
 * 把建这块网格要用到的格子码一次性采样出来。
 *
 * 采出来之后建网格就只依赖数据，不再依赖回调——那是它能被扔进 worker 的前提
 * （实现路径文档 §2 的第 2 项）。采样本身只有 289 次查表，留在调用方这一侧。
 */
export function sampleTerrainChunkCodes(chunkX, chunkZ, cellCodeAt) {
  if (typeof cellCodeAt !== 'function') throw new TypeError('cellCodeAt must be a function.');
  const span = TERRAIN_CHUNK_CODE_SPAN;
  const codes = new Int32Array(span * span);
  const originCellX = chunkX * TERRAIN_GRID;
  const originCellZ = chunkZ * TERRAIN_GRID;
  for (let localZ = 0; localZ < span; localZ += 1) {
    for (let localX = 0; localX < span; localX += 1) {
      codes[localZ * span + localX] = cellCodeAt(originCellX + localX, originCellZ + localZ);
    }
  }
  return codes;
}

/**
 * 把稀疏的编辑覆盖包成一个 `cellCodeAt`。
 *
 * 地形几何和碰撞网格都只有两个输入：世界种子（程序化底图）和这一小撮被编辑过的
 * 格子。前者两侧各自推得出来，后者必须传。所以覆盖层过边界的形状是
 * `[globalCellX, globalCellZ, code, ...]` 这一串数，而不是一个读 patch store 的
 * 回调——回调过不了线程边界（实现路径文档 §3）。
 *
 * 没被编辑过的世界返回空数组，这时查表退化成一次 Map.get(undefined)，
 * 和直接调程序化函数差不多。
 *
 * @param {number} worldSeed
 * @param {Int32Array | readonly number[]} overrides
 * @returns {(globalCellX: number, globalCellZ: number) => number}
 */
export function createOverrideCellCodeAt(worldSeed, overrides) {
  if (!overrides || overrides.length === 0) {
    return (globalCellX, globalCellZ) => terrainCellCodeAt(worldSeed, globalCellX, globalCellZ);
  }
  const edits = new Map();
  for (let offset = 0; offset + 2 < overrides.length; offset += 3) {
    edits.set(`${overrides[offset]},${overrides[offset + 1]}`, overrides[offset + 2]);
  }
  return (globalCellX, globalCellZ) => {
    const edited = edits.get(`${globalCellX},${globalCellZ}`);
    return edited === undefined
      ? terrainCellCodeAt(worldSeed, globalCellX, globalCellZ)
      : edited;
  };
}

/**
 * 只用「世界种子 + 这一窗里的编辑覆盖」推出同一窗格子码。
 *
 * 和 `sampleTerrainChunkCodes` 得到的结果必须逐格相同——那个走的是
 * `TerrainPatchStore.cellCodeAt` 回调，这个走的是同一条推导（程序化底图 + 覆盖层）。
 * 分成两个函数是因为**回调过不了线程边界，而种子和一小把覆盖格可以**：
 * 工作线程拿到这两样就能自己把 289 格算出来，不必让主线程先算一遍
 * （实现路径文档 §2 的第 2 项）。
 *
 * `overrides` 是三个一组的扁平数组：`[globalCellX, globalCellZ, code, ...]`。
 * 没被编辑过的 chunk 传空数组，这是绝大多数情况。
 */
export function buildTerrainChunkCodes(worldSeed, chunkX, chunkZ, overrides) {
  const span = TERRAIN_CHUNK_CODE_SPAN;
  const codes = new Int32Array(span * span);
  const originCellX = chunkX * TERRAIN_GRID;
  const originCellZ = chunkZ * TERRAIN_GRID;
  for (let localZ = 0; localZ < span; localZ += 1) {
    for (let localX = 0; localX < span; localX += 1) {
      codes[localZ * span + localX] = terrainCellCodeAt(
        worldSeed,
        originCellX + localX,
        originCellZ + localZ,
      );
    }
  }
  for (let offset = 0; offset + 2 < overrides.length; offset += 3) {
    const localX = overrides[offset] - originCellX;
    const localZ = overrides[offset + 1] - originCellZ;
    // 覆盖格来自相邻 chunk 时可能落在窗口外，直接跳过。
    if (localX < 0 || localX >= span || localZ < 0 || localZ >= span) continue;
    codes[localZ * span + localX] = overrides[offset + 2];
  }
  return codes;
}

/**
 * Build one world-space chunk mesh: two triangles per cell plus east/north-owned cliffs.
 * Static terrain is derived only from cellCodeAt, so client and server need no network payload.
 */
export function buildTerrainCollisionMesh(chunkX, chunkZ, cellCodeAt) {
  return buildTerrainCollisionMeshFromCodes(
    chunkX,
    chunkZ,
    sampleTerrainChunkCodes(chunkX, chunkZ, cellCodeAt),
  );
}

/**
 * 和 `buildTerrainCollisionMesh` 是同一套拓扑，只是输入换成了采样好的格子码。
 *
 * **只有这一份实现**：上面那个函数是它的包装。两份拓扑各自演化的话，客户端走
 * worker、服务端走回调，两边的地面就会悄悄长得不一样。
 */
export function buildTerrainCollisionMeshFromCodes(chunkX, chunkZ, codes) {
  const span = TERRAIN_CHUNK_CODE_SPAN;
  if (codes.length !== span * span) {
    throw new RangeError(`terrain code window must be ${span}x${span}, got ${codes.length}`);
  }
  const originCellX = chunkX * TERRAIN_GRID;
  const originCellZ = chunkZ * TERRAIN_GRID;
  const cellCodeAt = (cellX, cellZ) => {
    const localX = cellX - originCellX;
    const localZ = cellZ - originCellZ;
    return codes[localZ * span + localX];
  };
  const vertices = [];
  const indices = [];
  const appendTriangle = createVertexAppender(vertices, indices);

  const cornersAt = (cellX, cellZ) => {
    const code = cellCodeAt(cellX, cellZ);
    const x0 = cellX * TERRAIN_CELL_SIZE;
    const z0 = cellZ * TERRAIN_CELL_SIZE;
    const x1 = x0 + TERRAIN_CELL_SIZE;
    const z1 = z0 + TERRAIN_CELL_SIZE;
    return [
      { x: x0, y: terrainCellCornerHeight(code, 0, 0), z: z0 },
      { x: x1, y: terrainCellCornerHeight(code, 1, 0), z: z0 },
      { x: x1, y: terrainCellCornerHeight(code, 1, 1), z: z1 },
      { x: x0, y: terrainCellCornerHeight(code, 0, 1), z: z1 },
    ];
  };

  for (let localZ = 0; localZ < TERRAIN_GRID; localZ += 1) {
    for (let localX = 0; localX < TERRAIN_GRID; localX += 1) {
      const cellX = originCellX + localX;
      const cellZ = originCellZ + localZ;
      const code = cellCodeAt(cellX, cellZ);
      const corners = cornersAt(cellX, cellZ);
      const top = terrainTopTriangles(terrainCellShape(code), corners);
      appendTriangle(top[0], top[1], top[2]);
      appendTriangle(top[3], top[4], top[5]);

      const [, southEast, northEast, northWest] = corners;
      const east = cornersAt(cellX + 1, cellZ);
      if (southEast.y !== east[0].y || northEast.y !== east[3].y) {
        appendTriangle(southEast, northEast, east[3]);
        appendTriangle(southEast, east[3], east[0]);
      }
      const north = cornersAt(cellX, cellZ + 1);
      if (northWest.y !== north[0].y || northEast.y !== north[1].y) {
        appendTriangle(northWest, north[0], north[1]);
        appendTriangle(northWest, north[1], northEast);
      }
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
  };
}


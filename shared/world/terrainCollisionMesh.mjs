import {
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
 * Build one world-space chunk mesh: two triangles per cell plus east/north-owned cliffs.
 * Static terrain is derived only from cellCodeAt, so client and server need no network payload.
 */
export function buildTerrainCollisionMesh(chunkX, chunkZ, cellCodeAt) {
  if (typeof cellCodeAt !== 'function') throw new TypeError('cellCodeAt must be a function.');
  const vertices = [];
  const indices = [];
  const appendTriangle = createVertexAppender(vertices, indices);
  const originCellX = chunkX * TERRAIN_GRID;
  const originCellZ = chunkZ * TERRAIN_GRID;

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


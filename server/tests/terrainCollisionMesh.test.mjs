import test from 'node:test';
import assert from 'node:assert/strict';
import './initRapier.mjs';
import {
  buildTerrainCollisionMesh,
  terrainTopTriangles,
} from '../../shared/world/terrainCollisionMesh.mjs';
import {
  encodeTerrainCell,
  terrainCellCodeAt,
} from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_GRID,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import { ServerTerrainColliders } from '../scene/ServerTerrainColliders.mjs';

const flat = (height) => encodeTerrainCell(height, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT);

function verticalTrianglesAtX(mesh, x) {
  let count = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const points = [0, 1, 2].map((index) => {
      const vertex = mesh.indices[offset + index] * 3;
      return {
        x: mesh.vertices[vertex],
        y: mesh.vertices[vertex + 1],
        z: mesh.vertices[vertex + 2],
      };
    });
    if (points.every((point) => point.x === x) && new Set(points.map((point) => point.y)).size > 1) {
      count += 1;
    }
  }
  return count;
}

test('flat chunk contains exactly two top triangles per terrain cell', () => {
  const mesh = buildTerrainCollisionMesh(0, 0, () => flat(0));
  assert.equal(mesh.triangleCount, TERRAIN_GRID * TERRAIN_GRID * 2);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3);
});

test('fixed seed topology count is stable and has no duplicate triangle', () => {
  const mesh = buildTerrainCollisionMesh(
    0,
    0,
    (x, z) => terrainCellCodeAt(DEFAULT_WORLD_SEED, x, z),
  );
  assert.equal(mesh.triangleCount, 570);
  const triangles = new Set();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const key = [...mesh.indices.slice(offset, offset + 3)].sort((a, b) => a - b).join(':');
    assert.equal(triangles.has(key), false, `duplicate triangle ${key}`);
    triangles.add(key);
  }
});

test('east/west chunk seam has one cliff owner, not two overlapping faces', () => {
  const codeAt = (x) => flat(x < TERRAIN_GRID ? 0 : 1);
  const west = buildTerrainCollisionMesh(0, 0, codeAt);
  const east = buildTerrainCollisionMesh(1, 0, codeAt);
  const seamX = TERRAIN_GRID * 2;
  assert.equal(verticalTrianglesAtX(west, seamX), TERRAIN_GRID * 2);
  assert.equal(verticalTrianglesAtX(east, seamX), 0);
});

test('negative water-bed level closes the full cliff up to adjacent land', () => {
  const codeAt = (x) => flat(x < TERRAIN_GRID ? -1 : 0);
  const bed = buildTerrainCollisionMesh(0, 0, codeAt);
  const seamX = TERRAIN_GRID * 2;
  assert.equal(verticalTrianglesAtX(bed, seamX), TERRAIN_GRID * 2);
  const seamYs = [];
  for (let vertex = 0; vertex < bed.vertices.length; vertex += 3) {
    if (bed.vertices[vertex] === seamX) seamYs.push(bed.vertices[vertex + 1]);
  }
  assert.equal(Math.min(...seamYs), -1);
  assert.equal(Math.max(...seamYs), 0);
});

test('shared top topology selects the NW-SE diagonal for matching corner shapes', () => {
  const corners = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 0, z: 2 },
    { x: 0, y: 1, z: 2 },
  ];
  const triangles = terrainTopTriangles(TERRAIN_SHAPE.CORNER_HIGH_NORTH_WEST, corners);
  assert.deepEqual(triangles, [corners[0], corners[3], corners[1], corners[3], corners[2], corners[1]]);
});

test('长距离跑图后 terrain collider 数量保持 keep-radius 有界且无旧句柄', () => {
  const physics = new PhysicsWorld(getRapier());
  const terrain = new ServerTerrainColliders({
    physics,
    worldSeed: DEFAULT_WORLD_SEED,
    residentRadius: 1,
    keepRadius: 2,
  });
  const chunkSize = TERRAIN_GRID * 2;
  for (const chunkX of [0, 8, -12, 20, -24]) {
    terrain.sync([{ x: chunkX * chunkSize + 1, z: -chunkX * chunkSize + 1 }]);
    assert.ok(terrain.residentCount <= 9);
    assert.equal(physics.colliderCount, terrain.residentCount);
  }
  terrain.dispose();
  assert.equal(physics.colliderCount, 0);
  physics.dispose();
});

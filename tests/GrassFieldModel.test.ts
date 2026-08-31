import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PROP_KIND } from '../shared/world/worldConfig.mjs';
import { StreamingGrassSystem } from '../src/grass/StreamingGrassSystem';
import {
  createGrassBladeGeometry,
  createGrassFieldGeometry,
  createPlacedGrassGeometry,
  GRASS_BLADE_GEOMETRY_STATS,
} from '../src/models/grass';

test('grass blade keeps the seven-vertex five-triangle budget', () => {
  const blade = createGrassBladeGeometry();
  assert.equal(blade.getAttribute('position').count, GRASS_BLADE_GEOMETRY_STATS.vertexCount);
  assert.equal(blade.index?.count, GRASS_BLADE_GEOMETRY_STATS.indexCount);
  blade.dispose();
});

test('placed grass keeps every generated cluster center and sparse three-blade count', () => {
  const placement = { x: 12.5, z: -4.25, rotation: 0.7, scale: 1.1 };
  const field = createPlacedGrassGeometry([placement]);
  const offsets = field.fill.getAttribute('aOffset');
  let averageX = 0;
  let averageZ = 0;
  for (let index = 0; index < offsets.count; index += 1) {
    averageX += offsets.getX(index);
    averageZ += offsets.getZ(index);
  }

  assert.equal(field.instanceCount, 3);
  const sine = Math.sin(placement.rotation);
  const cosine = Math.cos(placement.rotation);
  for (let index = 0; index < field.instanceCount; index += 1) {
    const angle = (index / field.instanceCount) * Math.PI * 2;
    const localX = Math.cos(angle) * 0.09 * placement.scale;
    const localZ = Math.sin(angle) * 0.09 * placement.scale;
    const expectedX = placement.x + cosine * localX + sine * localZ;
    const expectedZ = placement.z + cosine * localZ - sine * localX;
    assert.ok(Math.abs(offsets.getX(index) - expectedX) < 0.000_01);
    assert.ok(Math.abs(offsets.getZ(index) - expectedZ) < 0.000_01);
  }
  assert.ok(Math.abs(averageX / offsets.count - placement.x) < 0.000_01);
  assert.ok(Math.abs(averageZ / offsets.count - placement.z) < 0.000_01);
  assert.equal(field.outline.instanceCount, field.fill.instanceCount);

  field.fill.dispose();
  field.outline.dispose();
});

test('streaming grass replaces only grass records and unloads with its chunk', () => {
  const system = new StreamingGrassSystem({
    color: '#c1d7a6',
    environment: { fogColor: '#fdfbf6', fogNear: 22, fogFar: 52 },
    bendTextureSize: 4,
  });
  system.mountChunk('0,0', {
    fillPositions: new Float32Array(0),
    fillNormals: new Float32Array(0),
    fillTints: new Float32Array(0),
    linePositions: new Float32Array(0),
    props: new Int32Array([
      PROP_KIND.GRASS, 12_500, -4_250, 700, 1_100,
      PROP_KIND.TREE, 10_000, -2_000, 0, 1_000,
    ]),
    propCount: 2,
  });

  const chunk = system.root.children[0] as THREE.Group;
  const fill = chunk.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry>;
  assert.equal(system.root.children.length, 1);
  assert.equal(fill.geometry.instanceCount, 3);

  system.unmountChunk('0,0');
  assert.equal(system.root.children.length, 0);
  system.dispose();
});

test('streaming grass keeps a bounded local bend window across large focus jumps', () => {
  const system = new StreamingGrassSystem({
    color: '#c1d7a6',
    environment: { fogColor: '#fdfbf6', fogNear: 22, fogFar: 52 },
    bendTextureSize: 4,
    bendWindowSize: 32,
    bendWindowStep: 4,
  });

  assert.deepEqual(system.bendWindowBounds, {
    minimumX: -16,
    maximumX: 16,
    minimumZ: -16,
    maximumZ: 16,
  });

  system.update(1 / 60, 1, { focusX: 5, focusZ: -5 });
  assert.deepEqual(system.bendWindowBounds, {
    minimumX: -12,
    maximumX: 20,
    minimumZ: -20,
    maximumZ: 12,
  });

  system.update(1 / 60, 1.5, { focusX: 3.9, focusZ: -3.9 });
  assert.deepEqual(system.bendWindowBounds, {
    minimumX: -12,
    maximumX: 20,
    minimumZ: -20,
    maximumZ: 12,
  });

  system.update(1 / 60, 2, { focusX: 100_003, focusZ: -100_003 });
  const jumpedBounds = system.bendWindowBounds;
  assert.equal(jumpedBounds.maximumX - jumpedBounds.minimumX, 32);
  assert.equal(jumpedBounds.maximumZ - jumpedBounds.minimumZ, 32);
  assert.ok(jumpedBounds.minimumX > 99_000);
  assert.ok(jumpedBounds.maximumZ < -99_000);
  system.dispose();
});

test('grass field shares one instanced layout across fill and line passes', () => {
  const field = createGrassFieldGeometry({
    bounds: { minimumX: -2, maximumX: 2, minimumZ: -3, maximumZ: 3 },
    bladeCount: 64,
    seed: 7,
  });

  assert.equal(field.instanceCount, 64);
  assert.equal(field.fill.instanceCount, 64);
  assert.equal(field.outline.instanceCount, 64);
  for (const name of ['aOffset', 'aScale', 'aRotation', 'aPhase', 'aTone']) {
    assert.equal(field.fill.getAttribute(name).count, 64);
    assert.equal(field.outline.getAttribute(name).count, 64);
  }

  field.fill.dispose();
  field.outline.dispose();
});

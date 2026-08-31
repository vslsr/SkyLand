import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGrassBladeGeometry,
  createGrassFieldGeometry,
  GRASS_BLADE_GEOMETRY_STATS,
} from '../src/models/grass';

test('grass blade keeps the seven-vertex five-triangle budget', () => {
  const blade = createGrassBladeGeometry();
  assert.equal(blade.getAttribute('position').count, GRASS_BLADE_GEOMETRY_STATS.vertexCount);
  assert.equal(blade.index?.count, GRASS_BLADE_GEOMETRY_STATS.indexCount);
  blade.dispose();
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

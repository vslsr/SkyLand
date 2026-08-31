import assert from 'node:assert/strict';
import test from 'node:test';
import type * as THREE from 'three';
import { OceanSystem } from '../src/ocean/OceanSystem';
import type { OceanVisualDefinition } from '../src/scenes/data/SceneDefinition';

const definition: OceanVisualDefinition = {
  size: 32,
  segments: 8,
  waveHeight: 0.12,
  waveSpeed: 0.72,
  noiseScale: 0.085,
  noiseStrength: 1.15,
  interlaceStrength: 0.42,
  surfaceColor: '#d7e7e5',
  secondaryColor: '#c6dcdb',
  gridLineColor: '#617f82',
  gridLineOpacity: 0.28,
};

function createSystem(): OceanSystem {
  return new OceanSystem({
    definition,
    seaLevel: 0,
    environment: { fogColor: '#f5f2e9', fogNear: 20, fogFar: 60 },
  });
}

test('海域系统只创建低多边形水面与同拓扑线框', () => {
  const system = createSystem();
  const surface = system.root.getObjectByName('ocean-surface') as THREE.Mesh;
  const grid = system.root.getObjectByName('ocean-low-poly-grid') as THREE.LineSegments;

  assert.ok(surface);
  assert.ok(grid);
  assert.equal((surface.geometry.getAttribute('position') as THREE.BufferAttribute).count, 384);
  assert.ok((grid.geometry.getAttribute('position') as THREE.BufferAttribute).count > 0);
});

test('客户端更新只推进海面与线框 Shader 时间', () => {
  const system = createSystem();
  const surface = system.root.getObjectByName('ocean-surface') as THREE.Mesh;
  const position = surface.geometry.getAttribute('position') as THREE.BufferAttribute;
  const before = position.getY(0);
  const surfaceMaterial = surface.material as THREE.ShaderMaterial;
  const grid = system.root.getObjectByName('ocean-low-poly-grid') as THREE.LineSegments;
  const gridMaterial = grid.material as THREE.ShaderMaterial;

  system.update(1 / 60, 1.25);

  assert.equal(position.getY(0), before);
  assert.equal(surfaceMaterial.uniforms.uTime.value, 1.25);
  assert.equal(gridMaterial.uniforms.uTime.value, 1.25);
  assert.equal(surfaceMaterial.uniforms.uNoiseScale.value, definition.noiseScale);
  assert.equal(surfaceMaterial.uniforms.uNoiseStrength.value, definition.noiseStrength);
  assert.equal(surfaceMaterial.uniforms.uInterlaceStrength.value, definition.interlaceStrength);
  assert.equal(gridMaterial.uniforms.uInterlaceStrength.value, definition.interlaceStrength);
});

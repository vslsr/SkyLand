import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { sampleEvenlyOnSurface } from '../src/models/surfaceSampling';

function serializeSamples(samples: ReturnType<typeof sampleEvenlyOnSurface>): number[][] {
  return samples.map(({ point, normal }) => [
    point.x, point.y, point.z, normal.x, normal.y, normal.z,
  ].map((value) => Number(value.toFixed(8))));
}

test('表面采样按种子确定，并在排除底面后保持均匀间距', () => {
  const geometry = new THREE.CylinderGeometry(0.126, 0.45, 0.72, 9, 3);
  const options = {
    seed: 0xd7a4_2026,
    acceptTriangle: (normal: Readonly<THREE.Vector3>) => normal.y > 0.5,
  };
  const first = sampleEvenlyOnSurface(geometry, 4, options);
  const repeated = sampleEvenlyOnSurface(geometry, 4, options);

  assert.equal(first.length, 4);
  assert.deepEqual(serializeSamples(first), serializeSamples(repeated));
  assert.ok(first.every(({ normal }) => normal.y > 0.5));

  let minimumPairDistance = Number.POSITIVE_INFINITY;
  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      minimumPairDistance = Math.min(
        minimumPairDistance,
        first[left].point.distanceTo(first[right].point),
      );
    }
  }
  assert.ok(minimumPairDistance > 0.1);
  geometry.dispose();
});

test('空几何与非正采样数安全返回空结果', () => {
  assert.deepEqual(sampleEvenlyOnSurface(new THREE.BufferGeometry(), 8), []);
  assert.deepEqual(sampleEvenlyOnSurface(new THREE.BoxGeometry(), 0), []);
});

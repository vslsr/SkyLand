import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createOutlinedObject } from '../src/models/outlinedObject.ts';
import { isSharedGeometry } from '../src/models/sharedGeometry.ts';
import { createTreeModel } from '../src/models/tree.ts';

const FILL_MATERIAL = new THREE.MeshBasicMaterial();

function outlineOf(group: THREE.Group): THREE.BufferGeometry {
  const line = group.children.find((child) => child instanceof THREE.LineSegments);
  return (line as THREE.LineSegments).geometry;
}

function collectGeometries(root: THREE.Object3D): THREE.BufferGeometry[] {
  const geometries: THREE.BufferGeometry[] = [];
  root.traverse((object) => {
    const geometry = (object as Partial<THREE.Mesh>).geometry;
    if (geometry) geometries.push(geometry);
  });
  return geometries;
}

test('同一份几何与阈值只构建一次轮廓线', () => {
  const geometry = new THREE.ConeGeometry(0.5, 1, 6, 1, false);
  const first = createOutlinedObject(geometry, FILL_MATERIAL);
  const second = createOutlinedObject(geometry, FILL_MATERIAL);

  assert.equal(outlineOf(first), outlineOf(second));
});

test('不同阈值各自构建自己的轮廓线', () => {
  const geometry = new THREE.ConeGeometry(0.5, 1, 6, 1, false);
  const shallow = createOutlinedObject(geometry, FILL_MATERIAL, 1);
  const steep = createOutlinedObject(geometry, FILL_MATERIAL, 0.2);

  assert.notEqual(outlineOf(shallow), outlineOf(steep));
});

test('顶点法线只计算一次', () => {
  const geometry = new THREE.ConeGeometry(0.5, 1, 6, 1, false);
  const original = geometry.computeVertexNormals.bind(geometry);
  let calls = 0;
  geometry.computeVertexNormals = () => {
    calls += 1;
    original();
  };

  for (let index = 0; index < 5; index += 1) createOutlinedObject(geometry, FILL_MATERIAL);
  assert.equal(calls, 1);
});

test('缓存出来的轮廓线被登记为共用，不该被单个物体释放', () => {
  const geometry = new THREE.ConeGeometry(0.5, 1, 6, 1, false);
  const outlined = createOutlinedObject(geometry, FILL_MATERIAL);

  assert.equal(isSharedGeometry(outlineOf(outlined)), true);
  assert.equal(isSharedGeometry(geometry), false, '调用方自己传进来的几何不由这里登记');
});

test('多棵树共用同一批几何', () => {
  const first = collectGeometries(createTreeModel());
  const second = collectGeometries(createTreeModel());

  assert.ok(first.length > 0);
  assert.deepEqual(first, second, '两棵树引用的是同一批几何实例');
  assert.ok(first.every((geometry) => isSharedGeometry(geometry)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildChunk } from '../src/world/ChunkBuilder.ts';
import { isSharedGeometry } from '../src/models/sharedGeometry.ts';
import { GRASS_BLADE_GEOMETRY } from '../src/models/grass.ts';
import { TREE_TRUNK_GEOMETRY } from '../src/models/tree.ts';
import { CHUNK_HALF_SIZE, chunkCenter } from '../shared/chunkCoordinates.mjs';

test('一个地块无论内容多少都只有固定数量的 draw call', () => {
  const chunk = buildChunk(0, 0);
  // 地面填充、地面网格、树干实例、树冠实例、草叶实例、合并轮廓线
  assert.equal(chunk.group.children.length, 6);

  const instanced = chunk.group.children.filter((child) => (child as THREE.InstancedMesh).isInstancedMesh);
  const lines = chunk.group.children.filter((child) => (child as THREE.LineSegments).isLineSegments);
  assert.equal(instanced.length, 3);
  assert.equal(lines.length, 2, '地面网格线与合并轮廓线');
  chunk.dispose();
});

test('实例化网格覆盖地块里的每一个物体', () => {
  const chunk = buildChunk(0, 0);
  const counts = chunk.group.children
    .filter((child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh)
    .map((mesh) => mesh.count);

  // 出生地是 3 棵树（树干与树冠各 3 个实例）和 13 处草丛共 33 片草叶
  assert.deepEqual(counts.sort((a, b) => a - b), [3, 3, 33]);
  chunk.dispose();
});

test('实例化几何与源几何共用同一批 attribute，不产生额外上传', () => {
  const chunk = buildChunk(0, 0);
  const meshes = chunk.group.children.filter(
    (child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh,
  );

  const sources = [TREE_TRUNK_GEOMETRY.getAttribute('position'), GRASS_BLADE_GEOMETRY.getAttribute('position')];
  const used = meshes.map((mesh) => mesh.geometry.getAttribute('position'));
  for (const source of sources) {
    assert.ok(used.includes(source), '实例化网格应当直接引用源几何的 attribute');
  }

  for (const mesh of meshes) {
    assert.equal(isSharedGeometry(mesh.geometry), true, '几何视图共用底层数据，不能被单独释放');
    assert.ok(mesh.geometry.boundingSphere, '必须自带覆盖全部实例的包围球');
  }
  chunk.dispose();
});

test('地块自己做包围盒剔除，子物体关闭逐物体判定', () => {
  const chunk = buildChunk(2, -3);
  for (const child of chunk.group.children) {
    assert.equal(child.frustumCulled, false);
  }

  const center = chunkCenter(2, -3);
  assert.ok(chunk.box.containsPoint(new THREE.Vector3(center.x, 1, center.z)));
  assert.ok(
    chunk.box.containsPoint(
      new THREE.Vector3(center.x + CHUNK_HALF_SIZE, 1, center.z + CHUNK_HALF_SIZE),
    ),
    '包围盒必须覆盖到地块边界',
  );
  chunk.dispose();
});

test('地块位于自己的世界坐标上', () => {
  const chunk = buildChunk(-4, 5);
  const center = chunkCenter(-4, 5);
  assert.equal(chunk.group.position.x, center.x);
  assert.equal(chunk.group.position.z, center.z);
  chunk.dispose();
});

test('释放地块不会破坏共用几何', () => {
  buildChunk(7, 7).dispose();

  const rebuilt = buildChunk(7, 7);
  const mesh = rebuilt.group.children.find(
    (child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh,
  );
  assert.ok(mesh && mesh.geometry.getAttribute('position').count > 0);
  rebuilt.dispose();
});

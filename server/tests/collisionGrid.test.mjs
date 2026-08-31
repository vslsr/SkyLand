import assert from 'node:assert/strict';
import test from 'node:test';
import { CollisionGrid } from '../../shared/collision/CollisionGrid.mjs';
import { COLLISION_LAYER } from '../../shared/collision/collisionLayers.mjs';

function boundsOf(x, z, half) {
  return { minimumX: x - half, maximumX: x + half, minimumZ: z - half, maximumZ: z + half };
}

test('查询只访问与查询区域相交的碰撞体，且每个最多访问一次', () => {
  const grid = new CollisionGrid({ cellSize: 4 });
  // 跨格摆放：near 同时落在四个格子里，用来验证去重。
  grid.insert('near', boundsOf(0, 0, 1.2), 'near');
  grid.insert('far', boundsOf(40, 40, 1), 'far');

  const visited = [];
  const count = grid.forEachInCircle(0, 0, 2, 0, (value) => visited.push(value));
  assert.deepEqual(visited, ['near']);
  assert.equal(count, 1);

  const both = [];
  grid.forEachInAabb(-50, -50, 50, 50, 0, (value) => both.push(value));
  assert.deepEqual(both.sort(), ['far', 'near']);
});

test('层掩码过滤掉不相关的碰撞体', () => {
  const grid = new CollisionGrid({ cellSize: 8 });
  grid.insert('crown', boundsOf(0, 0, 1), 'crown', COLLISION_LAYER.CAMERA);
  grid.insert('trunk', boundsOf(0, 0, 0.3), 'trunk', COLLISION_LAYER.MOVEMENT | COLLISION_LAYER.CAMERA);

  const movement = [];
  grid.forEachInCircle(0, 0, 1, COLLISION_LAYER.MOVEMENT, (value) => movement.push(value));
  assert.deepEqual(movement, ['trunk']);

  const camera = [];
  grid.forEachInCircle(0, 0, 1, COLLISION_LAYER.CAMERA, (value) => camera.push(value));
  assert.deepEqual(camera.sort(), ['crown', 'trunk']);
});

test('删除会回收空格子，网格不会随走过的路线无限增长', () => {
  const grid = new CollisionGrid({ cellSize: 4 });
  for (let index = 0; index < 32; index += 1) {
    grid.insert(`box-${index}`, boundsOf(index * 10, 0, 0.5), index);
  }
  assert.equal(grid.size, 32);
  assert.ok(grid.cellCount > 0);
  for (let index = 0; index < 32; index += 1) grid.remove(`box-${index}`);
  assert.equal(grid.size, 0);
  assert.equal(grid.cellCount, 0);
});

test('同一个 id 再次插入就是移动它，跨格后旧格子里不留残影', () => {
  const grid = new CollisionGrid({ cellSize: 4 });
  grid.insert('mover', boundsOf(0, 0, 0.5), 'mover');
  grid.insert('mover', boundsOf(20, 0, 0.5), 'mover');
  assert.equal(grid.size, 1);

  const atOrigin = [];
  grid.forEachInCircle(0, 0, 1, 0, (value) => atOrigin.push(value));
  assert.deepEqual(atOrigin, []);

  const moved = [];
  grid.forEachInCircle(20, 0, 1, 0, (value) => moved.push(value));
  assert.deepEqual(moved, ['mover']);
});

test('跨格过多的碰撞体进 oversized 列表，仍然可被查到也可被删除', () => {
  const grid = new CollisionGrid({ cellSize: 1, maximumCellsPerEntry: 4 });
  grid.insert('huge', boundsOf(0, 0, 20), 'huge');
  assert.equal(grid.oversizedCount, 1);
  assert.equal(grid.cellCount, 0);

  const found = [];
  grid.forEachInCircle(15, 15, 0.5, 0, (value) => found.push(value));
  assert.deepEqual(found, ['huge']);

  grid.remove('huge');
  assert.equal(grid.oversizedCount, 0);
  assert.equal(grid.size, 0);
});

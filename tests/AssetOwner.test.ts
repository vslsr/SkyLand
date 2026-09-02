import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AssetOwner } from '../src/core/assets/index';
import { renderAssets, releaseOwnResources } from '../src/render/renderAssets';
import { GROUND_GRID_MATERIAL, OUTLINE_MATERIAL } from '../src/materials/lineMaterials';

function tracked() {
  const destroyed: string[] = [];
  return {
    destroyed,
    create: (name: string) => () => ({ name }),
    destroy: (value: { name: string }) => destroyed.push(value.name),
  };
}

test('同 key 复用同一份资源，引用计数归零才 destroy', () => {
  const owner = new AssetOwner();
  const { destroyed, create, destroy } = tracked();

  const first = owner.acquire('outline', create('outline'), destroy);
  const second = owner.acquire('outline', create('outline'), destroy);
  assert.equal(first, second, '同 key 必须给回同一个句柄');
  assert.equal(owner.refCount('outline'), 2);
  assert.equal(owner.get(first), owner.get(second));
  assert.equal(owner.size, 1);

  owner.release(first);
  assert.deepEqual(destroyed, [], '还有人持有时不能释放');
  owner.release(second);
  assert.deepEqual(destroyed, ['outline']);
  assert.equal(owner.size, 0);
  assert.equal(owner.refCount('outline'), 0);
});

test('归零后再 acquire 是一份新资源，多释放一次会立刻报错', () => {
  const owner = new AssetOwner();
  const { destroyed, create, destroy } = tracked();

  const handle = owner.acquire('grid', create('grid'), destroy);
  owner.release(handle);
  // 悬空句柄要当场炸，而不是静默返回一个已经 destroy 掉的对象。
  assert.throws(() => owner.get(handle), /句柄已失效/);
  assert.throws(() => owner.release(handle), /不存在的资源句柄/);

  const reacquired = owner.acquire('grid', create('grid-2'), destroy);
  assert.equal((owner.get(reacquired) as { name: string }).name, 'grid-2');
  owner.release(reacquired);
  assert.deepEqual(destroyed, ['grid', 'grid-2']);
});

test('owns 认得表里的资源，认不得别人自己 new 的', () => {
  const owner = new AssetOwner();
  const value = { id: 1 };
  const handle = owner.acquire('thing', () => value, () => undefined);
  assert.equal(owner.owns(value), true);
  assert.equal(owner.owns({ id: 1 }), false);
  owner.release(handle);
  assert.equal(owner.owns(value), false);
});

test('遍历式释放避让共享的线稿材质，只放掉对象自己的资源', () => {
  // 这是 §8.2 那个真实缺陷：轮廓线材质被几乎每个物体指向，而删一个 Actor
  // 就会遍历它的子树无差别 dispose。登记进所有权表之后必须被跳过。
  assert.equal(renderAssets.owns(OUTLINE_MATERIAL), true);
  assert.equal(renderAssets.owns(GROUND_GRID_MATERIAL), true);

  const geometry = new THREE.BufferGeometry();
  let geometryDisposed = 0;
  geometry.dispose = () => { geometryDisposed += 1; };
  let outlineDisposed = 0;
  const originalDispose = OUTLINE_MATERIAL.dispose.bind(OUTLINE_MATERIAL);
  OUTLINE_MATERIAL.dispose = () => { outlineDisposed += 1; originalDispose(); };
  try {
    releaseOwnResources(new THREE.LineSegments(geometry, OUTLINE_MATERIAL));
    assert.equal(geometryDisposed, 1, '对象独占的几何体仍然要释放');
    assert.equal(outlineDisposed, 0, '共享材质不能被非拥有者释放');
  } finally {
    OUTLINE_MATERIAL.dispose = originalDispose;
  }
});

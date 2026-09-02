import assert from 'node:assert/strict';
import test from 'node:test';
import type { PhysicsWorld } from '../shared/physics/PhysicsWorld.mjs';
import { RemotePlayerColliders } from '../src/player/RemotePlayerColliders';

interface ProxyCall {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly halfHeight: number;
}

function createPhysicsSpy(): {
  physics: PhysicsWorld;
  set: ProxyCall[];
  removed: string[];
} {
  const set: ProxyCall[] = [];
  const removed: string[] = [];
  const physics = {
    setCharacterProxy(id: string, options: Omit<ProxyCall, 'id'>) {
      set.push({ id, ...options });
    },
    removeCharacterProxy(id: string) {
      removed.push(id);
      return true;
    },
  } as unknown as PhysicsWorld;
  return { physics, set, removed };
}

const SHAPE = { radius: 0.42, height: 0.84 };

test('每名远端玩家都拿到一个与角色同形的碰撞代理', () => {
  const { physics, set } = createPhysicsSpy();
  const colliders = new RemotePlayerColliders(physics, SHAPE);

  colliders.sync([{ id: 'a', x: 1, y: 2, z: 3 }]);

  assert.deepEqual(set, [{ id: 'a', x: 1, y: 2, z: 3, radius: 0.42, halfHeight: 0.42 }]);
});

test('代理跟随快照位置刷新，不重复登记也不遗漏', () => {
  const { physics, set } = createPhysicsSpy();
  const colliders = new RemotePlayerColliders(physics, SHAPE);

  colliders.sync([{ id: 'a', x: 0, y: 0, z: 0 }]);
  colliders.sync([{ id: 'a', x: 4, y: 1, z: -2 }, { id: 'b', x: 9, y: 0, z: 0 }]);

  assert.equal(set.length, 3);
  assert.deepEqual(set[1], { id: 'a', x: 4, y: 1, z: -2, radius: 0.42, halfHeight: 0.42 });
  assert.equal(set[2].id, 'b');
});

test('玩家离开后代理立刻撤掉，不会留在本地物理世界里挡路', () => {
  const { physics, removed } = createPhysicsSpy();
  const colliders = new RemotePlayerColliders(physics, SHAPE);

  colliders.sync([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 1, y: 0, z: 0 }]);
  colliders.sync([{ id: 'b', x: 1, y: 0, z: 0 }]);
  assert.deepEqual(removed, ['a']);

  colliders.clear();
  assert.deepEqual(removed, ['a', 'b']);
});

test('没有物理世界时静默跳过，纯表现场景不受影响', () => {
  const colliders = new RemotePlayerColliders(undefined, SHAPE);
  colliders.sync([{ id: 'a', x: 0, y: 0, z: 0 }]);
  colliders.clear();
});

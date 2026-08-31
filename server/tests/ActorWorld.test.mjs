import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Actor,
  ActorComponent,
  ActorWorld,
  TransformComponent,
} from '../../shared/actor/index.mjs';

class LifecycleComponent extends ActorComponent {
  constructor(log) {
    super('lifecycle');
    this.log = log;
  }

  onAttach() { this.log.push('attach'); }
  onBeginPlay() { this.log.push('begin'); }
  onEndPlay() { this.log.push('end'); }
  onDetach() { this.log.push('detach'); }
}

test('ActorWorld 管理 Component 的完整生命周期与组合查询', () => {
  const log = [];
  const world = new ActorWorld();
  const actor = new Actor('raft-01', 'raft');
  actor.addComponent(new TransformComponent({ position: [1, 2, 3], yaw: 0.4 }));
  actor.addComponent(new LifecycleComponent(log));

  world.addActor(actor);
  assert.deepEqual(log, ['attach', 'begin']);
  assert.deepEqual(world.query('transform', 'lifecycle'), [actor]);
  assert.equal(actor.requireComponent('transform').x, 1);

  world.removeActor(actor.id);
  assert.deepEqual(log, ['attach', 'begin', 'end', 'detach']);
  assert.equal(world.size, 0);
});

test('ActorWorld 的组合查询缓存会随运行时 Component 变化失效', () => {
  const world = new ActorWorld();
  const actor = new Actor('indexed-actor', 'probe');
  actor.addComponent(new TransformComponent());
  world.addActor(actor);

  const first = world.query('transform');
  assert.equal(world.query('transform'), first);
  assert.deepEqual(world.query('transform', 'lifecycle'), []);

  actor.addComponent(new LifecycleComponent([]));
  assert.deepEqual(world.query('transform', 'lifecycle'), [actor]);
  actor.removeComponent('lifecycle');
  assert.deepEqual(world.query('transform', 'lifecycle'), []);
});

test('System 更新期间增删 Actor 会延迟到本轮结束', () => {
  const world = new ActorWorld();
  const first = new Actor('first', 'test');
  first.addComponent(new TransformComponent());
  world.addActor(first);

  let sizeDuringUpdate = 0;
  world.addSystem({
    update(currentWorld) {
      currentWorld.removeActor('first');
      const second = new Actor('second', 'test');
      second.addComponent(new TransformComponent());
      currentWorld.addActor(second);
      sizeDuringUpdate = currentWorld.size;
    },
  });

  world.update(0.05, 0.05);
  assert.equal(sizeDuringUpdate, 1);
  assert.equal(world.getActor('first'), undefined);
  assert.ok(world.getActor('second'));
});

test('Actor 层级用局部 Transform 递归计算世界坐标并阻止循环', () => {
  const world = new ActorWorld();
  const parent = new Actor('parent', 'node');
  const child = new Actor('child', 'node');
  const grandchild = new Actor('grandchild', 'node');
  parent.addComponent(new TransformComponent({ position: [10, 2, 5], yaw: Math.PI / 2 }));
  child.addComponent(new TransformComponent({ position: [2, 1, 3], yaw: 0.25 }));
  grandchild.addComponent(new TransformComponent({ position: [0, 2, 1], yaw: -0.1 }));
  world.addActor(parent);
  world.addActor(child);
  world.addActor(grandchild);

  world.setActorParent('child', 'parent', { worldPositionStays: false });
  world.setActorParent('grandchild', 'child', { worldPositionStays: false });
  world.resolveTransforms();

  const childTransform = child.requireComponent('transform');
  const grandchildTransform = grandchild.requireComponent('transform');
  assert.ok(Math.abs(childTransform.x - 13) < 1e-9);
  assert.equal(childTransform.y, 3);
  assert.ok(Math.abs(childTransform.z - 3) < 1e-9);
  assert.ok(Math.abs(childTransform.yaw - (Math.PI / 2 + 0.25)) < 1e-9);
  assert.ok(Math.abs(grandchildTransform.y - 5) < 1e-9);
  assert.equal(parent.children[0], child);
  assert.equal(child.parent, parent);
  assert.equal(grandchild.parent, child);
  assert.throws(
    () => world.setActorParent('parent', 'grandchild'),
    /循环/,
  );
  assert.throws(() => world.setActorParent('child', 'missing'), /不存在父 Actor/);
  assert.throws(() => world.setActorParent('parent', 'parent'), /自己的父节点/);

  const preserved = [childTransform.x, childTransform.y, childTransform.z, childTransform.yaw];
  world.setActorParent('child', undefined);
  assert.equal(child.parent, undefined);
  assert.deepEqual(
    [childTransform.localX, childTransform.localY, childTransform.localZ, childTransform.localYaw],
    preserved,
  );
});

test('默认销毁父 Actor 会解绑子节点并保持子节点世界坐标', () => {
  const log = [];
  const world = new ActorWorld();
  const parent = new Actor('parent', 'node');
  const child = new Actor('child', 'node');
  parent.addComponent(new TransformComponent({ position: [5, 1, 2], yaw: 0.4 }));
  child.addComponent(new TransformComponent({ position: [2, 3, -1], yaw: 0.2 }));
  parent.addComponent(new LifecycleComponent({
    push(event) { log.push(`parent:${event}`); },
  }));
  child.addComponent(new LifecycleComponent({
    push(event) { log.push(`child:${event}`); },
  }));
  world.addActor(parent);
  world.addActor(child);
  world.setActorParent('child', 'parent', { worldPositionStays: false });
  const transform = child.requireComponent('transform');
  const worldTransform = [transform.x, transform.y, transform.z, transform.yaw];
  log.length = 0;

  world.removeActor('parent');

  assert.equal(world.size, 1);
  assert.equal(child.parent, undefined);
  assert.deepEqual([transform.x, transform.y, transform.z, transform.yaw], worldTransform);
  assert.deepEqual(
    [transform.localX, transform.localY, transform.localZ, transform.localYaw],
    worldTransform,
  );
  assert.deepEqual(log, ['parent:end', 'parent:detach']);
});

test('显式 cascade 会按子节点优先顺序销毁整棵子树', () => {
  const log = [];
  const world = new ActorWorld();
  const parent = new Actor('parent', 'node');
  const child = new Actor('child', 'node');
  parent.addComponent(new TransformComponent());
  child.addComponent(new TransformComponent());
  parent.addComponent(new LifecycleComponent({ push(event) { log.push(`parent:${event}`); } }));
  child.addComponent(new LifecycleComponent({ push(event) { log.push(`child:${event}`); } }));
  world.addActor(parent);
  world.addActor(child);
  world.setActorParent('child', 'parent', { worldPositionStays: false });
  log.length = 0;

  world.removeActorTree('parent');

  assert.equal(world.size, 0);
  assert.deepEqual(log, ['child:end', 'child:detach', 'parent:end', 'parent:detach']);
});

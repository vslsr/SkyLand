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

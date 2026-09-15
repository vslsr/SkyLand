import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSpatialHash, LocalAvoidance } from '../../shared/navigation/index.mjs';

/**
 * 局部避障这一层不认识 Actor，也不认识世界——它只吃一张位置表，吐一个方向。
 * 所以这里直接摆几个圆去问它，不必先造出一只史莱姆：要证明的每一条都是几何。
 */

function agent(x, z, overrides = {}) {
  return {
    x,
    z,
    radius: 0.4,
    speed: 1.6,
    moving: true,
    goalDistance: 10,
    avoids: true,
    ...overrides,
  };
}

/** 侧向分量：绕行力全部落在这条轴上，所以它就是「让没让」的度量。 */
function lateral(out, directionX = 1, directionZ = 0) {
  return out.x * -directionZ + out.z * directionX;
}

function steerOf(agents, index = 0, directionX = 1, directionZ = 0, options = {}) {
  const avoidance = new LocalAvoidance(options);
  avoidance.beginFrame(agents);
  return { avoidance, out: avoidance.steer(index, directionX, directionZ) };
}

test('空间哈希只交出半径内的下标，且换一帧就换一张表', () => {
  const hash = new AgentSpatialHash(2);
  const agents = [agent(0, 0), agent(1, 0), agent(9, 9)];
  hash.build(agents);
  const near = [...hash.query(0, 0, 2)];
  assert.deepEqual(near.sort(), [0, 1], '两米内只有自己和一米外那个');

  agents[2].x = 0.5;
  agents[2].z = 0.5;
  hash.build(agents);
  assert.equal([...hash.query(0, 0, 2)].length, 3, '重建之后挪过来的那个也算邻居');
});

test('身边没有人时方向原样交回，一位都不动', () => {
  const { out } = steerOf([agent(0, 0)]);
  assert.equal(out.avoided, false);
  assert.equal(out.x, 1);
  assert.equal(out.z, 0);
});

test('正前方站着人时会往旁边让，而不是顶着推——纯径向斥力的死结', () => {
  // 纯径向的斥力在正前方时与前进方向恰好反向，合力只会落在同一条直线上：
  // 前进、停住、后退，没有任何横向分量。那是一个稳定的死结，等多久都不会解开。
  const { out } = steerOf([agent(0, 0), agent(1, 0, { moving: false, goalDistance: Infinity })]);
  assert.equal(out.avoided, true);
  assert.ok(Math.abs(lateral(out)) > 0.5, `应当明显偏向一侧，实际 ${out.z}`);
  assert.ok(Math.hypot(out.x, out.z) > 0.999, '交出来的必须是单位方向');
});

test('迎面相遇的两只选的是相反的世界方向，不会贴上再弹开地跳舞', () => {
  // 手性是固定的（正对着时统一往同一侧让），而两只朝向相反，于是「同一侧」
  // 在世界坐标里正好是相反方向，自然错开。随机选边有一半概率撞同一侧。
  const agents = [agent(0, 0), agent(2, 0, { goalDistance: 10 })];
  const avoidance = new LocalAvoidance();
  avoidance.beginFrame(agents);
  const left = { ...avoidance.steer(0, 1, 0) };
  const right = { ...avoidance.steer(1, -1, 0) };
  assert.ok(left.z * right.z < 0, `两只应当各让一边，实际 ${left.z} / ${right.z}`);
});

test('站着不动的挡路者让得更狠：它不会让路，责任全在我这边', () => {
  const still = steerOf([agent(0, 0), agent(1, 0, { moving: false, goalDistance: Infinity })]);
  const walking = steerOf([agent(0, 0), agent(1, 0, { moving: true, goalDistance: Infinity })]);
  assert.ok(
    Math.abs(lateral(still.out)) > Math.abs(lateral(walking.out)),
    '同样挡在正前方，不动的那个应该被让得更开',
  );
});

test('站在目的地上的那个不是障碍，它就是目的地——不绕圈', () => {
  // 追人的生物的目标点就是那个人本体。把它当障碍绕开，等于绕着人转圈永远追不上。
  const { out } = steerOf([agent(0, 0, { goalDistance: 1 }), agent(1, 0, { moving: false })]);
  assert.ok(Math.abs(lateral(out)) < 1e-9, `不该为目的地本身绕行，实际 ${out.z}`);
});

test('邻居再多也只有最近的 K 个参与受力', () => {
  const crowd = [agent(0, 0)];
  for (let index = 1; index <= 20; index += 1) crowd.push(agent(index * 0.05, 0.6));
  const { avoidance } = steerOf(crowd);
  assert.equal(avoidance.neighborCount, avoidance.config.maxNeighbors);
});

test('完全重合的两只也会被推开，而且方向可复现', () => {
  const first = steerOf([agent(0, 0), agent(0, 0)]);
  const second = steerOf([agent(0, 0), agent(0, 0)]);
  assert.equal(first.out.avoided, true);
  assert.equal(first.out.x, second.out.x, '同样的局面必须给同样的答案：服务端是权威');
  assert.equal(first.out.z, second.out.z);
});

test('写了不让的自己不让，但仍然是别人的障碍', () => {
  const agents = [agent(0, 0, { avoids: false }), agent(1, 0, { moving: false, goalDistance: Infinity })];
  const avoidance = new LocalAvoidance();
  avoidance.beginFrame(agents);
  const stubborn = { ...avoidance.steer(0, 1, 0) };
  assert.equal(stubborn.avoided, false);
  assert.equal(stubborn.x, 1);
  const other = { ...avoidance.steer(1, -1, 0) };
  assert.equal(other.avoided, true, '不让的那只对别人来说还是一个圆');
});

test('一帧之内读的是同一张快照，答案与遍历顺序无关', () => {
  const agents = [agent(0, 0), agent(0.6, 0.2, { moving: false })];
  const avoidance = new LocalAvoidance();
  avoidance.beginFrame(agents);
  const first = { ...avoidance.steer(0, 1, 0) };
  avoidance.steer(1, -1, 0);
  const again = { ...avoidance.steer(0, 1, 0) };
  assert.deepEqual(again, first, '先算谁不该改变答案');
});

test('站定时只推真正重叠的那一部分，站得开的不推', () => {
  const avoidance = new LocalAvoidance();
  avoidance.beginFrame([agent(0, 0, { moving: false }), agent(0.5, 0, { moving: false })]);
  const push = { ...avoidance.separate(0) };
  assert.ok(push.x < -0.99, '应当被推离对方');
  assert.ok(Math.abs(push.strength - (1 - 0.5 / 0.8)) < 1e-9, '推力按重叠深度给');

  avoidance.beginFrame([agent(0, 0, { moving: false }), agent(2, 0, { moving: false })]);
  assert.equal(avoidance.separate(0).strength, 0, '离得开就一动不动');
});

test('过滤器能让一队人马互相穿过', () => {
  const agents = [agent(0, 0, { team: 'red' }), agent(1, 0, { team: 'red', moving: false })];
  const avoidance = new LocalAvoidance({ filter: (self, other) => self.team !== other.team });
  avoidance.beginFrame(agents);
  assert.equal(avoidance.steer(0, 1, 0).avoided, false);
});

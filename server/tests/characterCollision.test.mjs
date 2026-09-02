import './initRapier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import { createCharacterState } from '../../shared/physics/characterState.mjs';
import {
  createCharacterSimulationParams,
  stepCharacter,
} from '../../shared/physics/stepCharacter.mjs';

const DT = 1 / 60;
const RADIUS = 0.42;
const CLEARANCE = RADIUS * 2;
const MOVEMENT = { walkSpeed: 4, sprintMultiplier: 1.5, acceleration: 30, deceleration: 30 };
const JUMP = { impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85 };

function groundWorld() {
  const physics = new PhysicsWorld(getRapier(), { timestep: DT });
  physics.setStaticColliderGroup('ground', [{
    shape: 'box',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    halfWidth: 30,
    halfLength: 30,
    minimumY: -0.2,
    maximumY: 0,
  }]);
  return physics;
}

function walker(physics, id, x) {
  physics.createCharacter(id, { x, y: 0, z: 0, radius: RADIUS, halfHeight: RADIUS });
  return {
    state: createCharacterState({ x, y: 0, z: 0, grounded: true }),
    params: createCharacterSimulationParams(id, MOVEMENT, JUMP),
  };
}

const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('角色不会穿过另一名角色', () => {
  const physics = groundWorld();
  // 站着不动的一方不被模拟，正好对应服务端里没有输入的玩家。
  physics.createCharacter('idle', { x: 0, y: 0, z: 0, radius: RADIUS, halfHeight: RADIUS });
  const mover = walker(physics, 'mover', 2);
  let minimum = Infinity;
  for (let tick = 0; tick < 180; tick += 1) {
    stepCharacter(mover.state, { move: { x: -1, z: 0 } }, DT, physics, mover.params);
    minimum = Math.min(minimum, horizontalDistance(mover.state, { x: 0, z: 0 }));
  }
  assert.ok(minimum >= CLEARANCE, `穿进了对方身体：最近 ${minimum}`);
  physics.dispose();
});

test('两名角色同时移动时也不会重叠', () => {
  const physics = groundWorld();
  const left = walker(physics, 'left', -3);
  const right = walker(physics, 'right', 3);
  let minimum = Infinity;
  for (let tick = 0; tick < 180; tick += 1) {
    stepCharacter(left.state, { move: { x: 1, z: 0 } }, DT, physics, left.params);
    stepCharacter(right.state, { move: { x: -1, z: 0 } }, DT, physics, right.params);
    minimum = Math.min(minimum, horizontalDistance(left.state, right.state));
  }
  assert.ok(minimum >= CLEARANCE, `两人重叠了：最近 ${minimum}`);
  physics.dispose();
});

test('远端玩家的碰撞代理挡得住角色，撤掉后立刻放行', () => {
  const physics = groundWorld();
  physics.setCharacterProxy('remote', { x: 0, y: 0, z: 0, radius: RADIUS, halfHeight: RADIUS });
  const mover = walker(physics, 'local', 2);
  let minimum = Infinity;
  for (let tick = 0; tick < 120; tick += 1) {
    stepCharacter(mover.state, { move: { x: -1, z: 0 } }, DT, physics, mover.params);
    minimum = Math.min(minimum, horizontalDistance(mover.state, { x: 0, z: 0 }));
  }
  assert.ok(minimum >= CLEARANCE, `代理没挡住：最近 ${minimum}`);

  physics.removeCharacterProxy('remote');
  for (let tick = 0; tick < 120; tick += 1) {
    stepCharacter(mover.state, { move: { x: -1, z: 0 } }, DT, physics, mover.params);
  }
  assert.ok(mover.state.x < -CLEARANCE, `代理撤掉后仍被挡：x=${mover.state.x}`);
  physics.dispose();
});

test('代理跟随快照位置移动，不需要重建 collider', () => {
  const physics = groundWorld();
  const mover = walker(physics, 'local', 0);
  const before = physics.colliderCount;
  let minimum = Infinity;
  let proxyX = 3;
  for (let tick = 0; tick < 300; tick += 1) {
    // 远端玩家慢慢往前走，本地玩家以更快的速度追上去再跟在后面。
    proxyX = Math.min(6, 3 + tick * 1.5 * DT);
    physics.setCharacterProxy('remote', { x: proxyX, y: 0, z: 0, radius: RADIUS, halfHeight: RADIUS });
    stepCharacter(mover.state, { move: { x: 1, z: 0 } }, DT, physics, mover.params);
    minimum = Math.min(minimum, horizontalDistance(mover.state, { x: proxyX, z: 0 }));
  }
  assert.ok(mover.state.x > 2, `本地玩家没追上去：x=${mover.state.x}`);
  assert.ok(minimum >= CLEARANCE, `追击时穿模了：最近 ${minimum}`);
  assert.equal(physics.colliderCount, before + 1, '代理每帧都在重建 collider');
  physics.dispose();
});

test('代理换尺寸时重建，移除后不再留下 collider', () => {
  const physics = groundWorld();
  const before = physics.colliderCount;
  physics.setCharacterProxy('remote', { x: 0, y: 0, z: 0, radius: RADIUS, halfHeight: RADIUS });
  assert.equal(physics.colliderCount, before + 1);
  physics.setCharacterProxy('remote', { x: 0, y: 0, z: 0, radius: 0.6, halfHeight: 0.8 });
  assert.equal(physics.colliderCount, before + 1);
  assert.equal(physics.removeCharacterProxy('remote'), true);
  assert.equal(physics.colliderCount, before);
  assert.equal(physics.removeCharacterProxy('remote'), false);
  physics.dispose();
});

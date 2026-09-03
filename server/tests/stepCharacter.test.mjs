import './initRapier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import { createCharacterState } from '../../shared/physics/characterState.mjs';
import {
  createCharacterSimulationParams,
  stepCharacter,
} from '../../shared/physics/stepCharacter.mjs';
import {
  circleOverlapsSimpleCollisionFootprint,
  createSimpleCollisionFromRender,
} from '../../shared/actor/simpleCollision.mjs';
import {
  simpleCollisionGroupToPhysicsDefinitions,
  simpleCollisionInstanceToPhysicsDefinitions,
} from '../../shared/physics/simpleCollisionToPhysics.mjs';
import { sampleBuoyancyBobOffset } from '../../shared/actor/buoyancyMotion.mjs';

const DT = 1 / 60;
const MOVEMENT = {
  walkSpeed: 4,
  sprintMultiplier: 1.5,
  acceleration: 30,
  deceleration: 30,
  airAcceleration: 8,
};
const JUMP = { impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85 };

function box(x, minimumY, maximumY, halfWidth, halfLength = 3) {
  return { shape: 'box', x, y: 0, z: 0, yaw: 0, halfWidth, halfLength, minimumY, maximumY };
}

function setup(position, colliders) {
  const physics = new PhysicsWorld(getRapier(), { timestep: DT });
  physics.setStaticColliderGroup('test', colliders);
  physics.createCharacter('player', {
    ...position,
    radius: 0.42,
    halfHeight: 0.42,
  });
  physics.prepareQueries();
  const state = createCharacterState(position);
  const params = createCharacterSimulationParams('player', MOVEMENT, JUMP);
  return { physics, state, params };
}

test('缺陷A：跳上 1m 高台后持续前进，不在接缝卡死', () => {
  const { physics, state, params } = setup(
    { x: -2, y: 0, z: 0 },
    [box(-2.5, -0.2, 0, 2.5), box(2.5, 0, 1, 2.5)],
  );
  const positions = [];
  for (let tick = 0; tick < 100; tick += 1) {
    stepCharacter(
      state,
      { move: { x: 1, z: 0 }, jump: tick === 8 },
      DT,
      physics,
      params,
    );
    positions.push(state.x);
  }
  assert.ok(state.x > 4, `expected to cross the seam, got x=${state.x}`);
  assert.ok(Math.abs(state.y - 1) < 0.002, `expected high-platform feet y, got ${state.y}`);
  for (let index = 45; index + 10 < positions.length; index += 1) {
    assert.ok(positions[index + 10] > positions[index] + 0.1, `stalled near tick ${index}`);
  }
  physics.dispose();
});

test('缺陷B：走出高台后保留水平惯性并按重力连续下落', () => {
  const { physics, state, params } = setup(
    { x: -1, y: 1, z: 0 },
    [box(-2.5, 0, 1, 2.5), box(2.5, -0.2, 0, 2.5)],
  );
  let leftEdge;
  let previousY = state.y;
  for (let tick = 0; tick < 60; tick += 1) {
    stepCharacter(state, { move: { x: 1, z: 0 } }, DT, physics, params);
    if (!state.grounded && !leftEdge) {
      leftEdge = { x: state.x, y: state.y, deltaY: state.y - previousY, vx: state.vx };
    }
    previousY = state.y;
  }
  assert.ok(leftEdge, 'character never left the ledge');
  assert.ok(leftEdge.vx > 3.5, `horizontal inertia was lost: vx=${leftEdge.vx}`);
  assert.ok(Math.abs(leftEdge.deltaY) < 0.05, `snapped by ${leftEdge.deltaY}m on edge exit`);
  assert.ok(state.x > 2.5, `horizontal trajectory stopped at x=${state.x}`);
  assert.ok(Math.abs(state.y) < 0.002);
  physics.dispose();
});

test('缺陷C：从高处落在石头顶面，沿顶面走并在边缘离地', () => {
  const { physics, state, params } = setup(
    { x: 0, y: 2, z: 0, grounded: false },
    [box(0, -0.2, 0, 5), box(0, 0, 0.6, 0.65, 0.65)],
  );
  state.grounded = false;
  let landed = false;
  for (let tick = 0; tick < 120; tick += 1) {
    stepCharacter(state, { move: { x: 0, z: 0 } }, DT, physics, params);
    if (state.grounded) {
      landed = true;
      break;
    }
    assert.ok(state.y >= 0.599, `penetrated the rock top at y=${state.y}`);
  }
  assert.equal(landed, true);
  assert.ok(Math.abs(state.y - 0.6) < 0.002);

  let leftRock = false;
  for (let tick = 0; tick < 50; tick += 1) {
    stepCharacter(state, { move: { x: 1, z: 0 } }, DT, physics, params);
    if (!state.grounded) leftRock = true;
  }
  assert.equal(leftRock, true);
  assert.ok(state.x > 1.2);
  assert.ok(state.y < 0.6);
  physics.dispose();
});

test('缺陷C：蘑菇菌盖生成独立支撑 collider，角色落下后站在完整菌盖上', () => {
  const collision = createSimpleCollisionFromRender({
    model: 'line-art-elastic-mushroom', radius: 0.5, height: 0.95,
  });
  const mushroom = simpleCollisionInstanceToPhysicsDefinitions({
    collision,
    transform: { x: 0, y: 0, z: 0, yaw: 0 },
    layers: 3,
  });
  assert.equal(mushroom.length, 2);
  const { physics, state, params } = setup(
    { x: 0.38, y: 2, z: 0, grounded: false },
    [box(0, -0.2, 0, 5), ...mushroom],
  );
  state.grounded = false;
  for (let tick = 0; tick < 120 && !state.grounded; tick += 1) {
    stepCharacter(state, { move: { x: 0, z: 0 } }, DT, physics, params);
  }
  assert.equal(state.grounded, true);
  assert.ok(Math.abs(state.y - 0.95) < 0.006, `expected cap top, got y=${state.y}`);
  physics.dispose();
});

test('upward collision clears vertical velocity at a ceiling', () => {
  const { physics, state, params } = setup(
    { x: 0, y: 0, z: 0 },
    [box(0, -0.2, 0, 4), box(0, 1.4, 1.6, 1)],
  );
  let hitCeiling = false;
  for (let tick = 0; tick < 50; tick += 1) {
    stepCharacter(state, { move: { x: 0, z: 0 }, jump: tick === 1 }, DT, physics, params);
    if (!state.grounded && state.vy === 0) {
      hitCeiling = true;
      break;
    }
  }
  assert.equal(hitCeiling, true);
  assert.ok(state.y < 0.58);
  physics.dispose();
});

test('岸边进入水域只通过重力与浮力速度积分下降，不会把 Y 钉到吃水线', () => {
  const targetY = -0.6;
  const { physics, state, params } = setup(
    { x: -1, y: 0, z: 0 },
    [box(-2.5, -0.2, 0, 2.5), box(2.5, -1.2, -1, 2.5)],
  );
  let leftShore;
  let maximumStepDrop = 0;
  let previousY = state.y;
  for (let tick = 0; tick < 300; tick += 1) {
    params.buoyancyHeight = state.x >= 0 ? targetY : undefined;
    stepCharacter(state, { move: { x: 1, z: 0 } }, DT, physics, params);
    const stepDrop = previousY - state.y;
    maximumStepDrop = Math.max(maximumStepDrop, stepDrop);
    if (!state.grounded && !leftShore) leftShore = { y: state.y, vy: state.vy };
    previousY = state.y;
  }

  assert.ok(leftShore, '角色没有离开岸边支撑');
  assert.ok(leftShore.y > targetY + 0.3, `离岸首步被钉到吃水线：${leftShore.y}`);
  assert.ok(leftShore.vy < 0, '离岸后应由向下速度开始下落');
  assert.ok(maximumStepDrop < 0.12, `出现单步 Y 瞬移：${maximumStepDrop}`);
  assert.ok(Math.abs(state.y - targetY) < 0.06, `浮力未稳定在吃水线附近：${state.y}`);
  physics.dispose();
});

test('动态浮力目标产生可见上下起伏，角色 Y 仍由物理逐步积分', () => {
  const supportY = -0.6;
  const { physics, state, params } = setup(
    { x: 0, y: supportY, z: 0 },
    [box(0, -1.2, -1, 4)],
  );
  let minimumY = Infinity;
  let maximumY = -Infinity;
  let maximumStepDelta = 0;
  let previousY = state.y;
  let samplesPinnedToTarget = 0;
  let measuredSamples = 0;

  for (let tick = 0; tick < 600; tick += 1) {
    params.buoyancyHeight = supportY + sampleBuoyancyBobOffset(
      'player',
      tick * DT,
      0.3,
      0.55,
    );
    stepCharacter(state, { move: { x: 0, z: 0 } }, DT, physics, params);
    maximumStepDelta = Math.max(maximumStepDelta, Math.abs(state.y - previousY));
    previousY = state.y;
    if (tick < 120) continue;
    minimumY = Math.min(minimumY, state.y);
    maximumY = Math.max(maximumY, state.y);
    measuredSamples += 1;
    if (Math.abs(state.y - params.buoyancyHeight) < 1e-6) samplesPinnedToTarget += 1;
  }

  assert.ok(maximumY - minimumY > 0.16, `浮力起伏不明显：${maximumY - minimumY}`);
  assert.ok(maximumStepDelta < 0.08, `浮力造成单步 Y 瞬移：${maximumStepDelta}`);
  assert.ok(
    samplesPinnedToTarget < measuredSamples * 0.05,
    `角色 Y 疑似被直接钉到动态目标：${samplesPinnedToTarget}/${measuredSamples}`,
  );
  physics.dispose();
});

test('长方形碰撞盒转成 Rapier 之后朝向不变', () => {
  // 正方形足迹（树干、所有圆柱）看不出朝向错误，长方形才看得出来。流式世界的
  // 石头就是 0.48 × 0.40 的盒子，随机 yaw 摆放：一旦这里的旋转与 simpleCollision
  // 反号，Rapier 里的盒子相对看得见的模型镜像过去，玩家会被不存在的墙挡住，
  // 又能踩进石头里——这条用例逐角度锁死两套模型的边界。
  const instance = {
    collision: {
      shape: 'box',
      centerX: 0,
      centerZ: 0,
      halfWidth: 0.65,
      halfLength: 0.45,
      minimumY: 0,
      maximumY: 0.6,
    },
    transform: { x: 0, y: 0, z: 0, yaw: 4.116 },
  };
  const physics = new PhysicsWorld(getRapier(), { timestep: DT });
  physics.setStaticColliderGroup('rotated', simpleCollisionGroupToPhysicsDefinitions([instance]));
  physics.prepareQueries();

  let worst = 0;
  for (let degrees = 0; degrees < 360; degrees += 15) {
    const angle = degrees * Math.PI / 180;
    const directionX = Math.cos(angle);
    const directionZ = Math.sin(angle);
    // 二分出 simpleCollision 认为的径向边界。
    let inside = 0;
    let outside = 3;
    for (let step = 0; step < 40; step += 1) {
      const middle = (inside + outside) / 2;
      const overlaps = circleOverlapsSimpleCollisionFootprint(
        { x: directionX * middle, z: directionZ * middle },
        1e-4,
        instance,
      );
      if (overlaps) inside = middle;
      else outside = middle;
    }
    // 同一方向上向盒心打一条射线，取 Rapier 的边界。
    const hit = physics.castRay(
      { x: directionX * 3, y: 0.3, z: directionZ * 3 },
      { x: -directionX, y: 0, z: -directionZ },
      6,
    );
    assert.ok(hit, `${degrees}° 方向没有打中盒子`);
    worst = Math.max(worst, Math.abs(inside - (3 - hit.timeOfImpact)));
  }
  assert.ok(worst < 0.01, `两套模型的边界最大相差 ${worst.toFixed(3)} 米，朝向对不上`);
  physics.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Actor } from '../shared/actor/Actor.mjs';
import {
  GRASS_DISPLACEMENT_COMPONENT,
  GrassDisplacementComponent,
} from '../src/actors/components/GrassDisplacementComponent';
import { GrassInteractionQueue } from '../src/grass/GrassInteraction';
import { createObjectPositionSampler } from '../src/player/objectPositionSampler';

test('grass interaction normalizes direction and clamps public input', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    position: { x: 3, z: -4 },
    direction: { x: 3, z: 4 },
    radius: 20,
    strength: 2,
  });

  assert.deepEqual(queue.drain(), [{
    positionX: 3,
    positionZ: -4,
    startPositionX: 3,
    startPositionZ: -4,
    directionX: 0.6,
    directionZ: 0.8,
    radius: 4,
    strength: 1,
    radial: false,
  }]);
});

test('grass interaction ignores impulses without a direction', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    position: { x: 0, z: 0 },
    direction: { x: 0, z: 0 },
  });
  assert.deepEqual(queue.drain(), []);
});

test('radial grass interaction does not require a movement direction', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    mode: 'radial',
    position: { x: 2, z: -1 },
    radius: 0.7,
    strength: 0.25,
  });

  assert.deepEqual(queue.drain(), [{
    positionX: 2,
    positionZ: -1,
    startPositionX: 2,
    startPositionZ: -1,
    directionX: 1,
    directionZ: 0,
    radius: 0.7,
    strength: 0.25,
    radial: true,
  }]);
});

test('radial grass interaction normalizes its center fallback direction', () => {
  const queue = new GrassInteractionQueue();
  queue.applyImpulse({
    mode: 'radial',
    position: { x: 2, z: -1 },
    direction: { x: 3, z: 4 },
  });

  const [impulse] = queue.drain();
  assert.equal(impulse.directionX, 0.6);
  assert.equal(impulse.directionZ, 0.8);
});

test('grass displacement component keeps pressing while its actor remains stationary', () => {
  const queue = new GrassInteractionQueue();
  const root = new THREE.Group();
  root.position.set(3, 0, -4);
  const actor = new Actor('slime-test', 'player-slime');
  const component = actor.addComponent(new GrassDisplacementComponent(createObjectPositionSampler(root), queue, {
    radius: 0.72,
    pressurePerSecond: 3,
  })) as GrassDisplacementComponent;

  component.update(1 / 60);
  const firstPressure = queue.drain();
  component.update(1 / 60);
  const sustainedPressure = queue.drain();

  assert.equal(actor.hasComponents(GRASS_DISPLACEMENT_COMPONENT), true);
  assert.equal(firstPressure.length, 1);
  assert.equal(sustainedPressure.length, 1);
  assert.equal(firstPressure[0].radial, true);
  assert.deepEqual(
    [sustainedPressure[0].positionX, sustainedPressure[0].positionZ],
    [3, -4],
  );
  assert.ok(Math.abs(firstPressure[0].strength - sustainedPressure[0].strength) < 1e-9);
});

test('grass displacement component emits one continuous capsule along movement', () => {
  const queue = new GrassInteractionQueue();
  const root = new THREE.Group();
  const component = new GrassDisplacementComponent(createObjectPositionSampler(root), queue, {
    radius: 0.72,
    pressurePerSecond: 3,
  });

  component.update(1 / 60);
  queue.drain();
  root.position.set(1.5, 0, 2);
  component.update(1 / 60);
  const [pressure] = queue.drain();

  assert.deepEqual(
    [
      pressure.startPositionX,
      pressure.startPositionZ,
      pressure.positionX,
      pressure.positionZ,
    ],
    [0, 0, 1.5, 2],
  );
  assert.equal(pressure.radial, true);
  assert.ok(Math.abs(pressure.directionX - 0.6) < 1e-9);
  assert.ok(Math.abs(pressure.directionZ - 0.8) < 1e-9);
  assert.ok(pressure.strength > 0.24);
});

/** 直连的探针：跳过队列的归一化与丢弃规则，看 Component 原样发出了什么。 */
function createProbe() {
  const impulses: Array<Record<string, unknown>> = [];
  return {
    impulses,
    target: { applyImpulse: (impulse: never) => { impulses.push(impulse); } },
  };
}

test('纯竖直位移：方向退化成零向量而不是 NaN', () => {
  // 两个陷阱同时落在这一帧：canSweep 的守卫用的是**三维**距离，纯竖直位移能通过
  // 它；而要归一化的却是水平分量，长度为 0。原来靠 THREE.Vector2.normalize() 内部
  // 的 `length() || 1` 兜住，结果是方向变成 (0, 0)。换成手写数学必须一模一样——
  // 少了那个 `|| 1` 就是往下游灌 NaN。
  const probe = createProbe();
  const root = new THREE.Group();
  const component = new GrassDisplacementComponent(
    createObjectPositionSampler(root),
    probe.target as never,
    { radius: 0.72, pressurePerSecond: 3 },
  );

  component.update(1 / 60);
  probe.impulses.length = 0;
  root.position.set(0, 1.2, 0);
  component.update(1 / 60);

  const [impulse] = probe.impulses;
  const direction = impulse.direction as { x: number; z: number };
  assert.equal(direction.x, 0);
  assert.equal(direction.z, 0);
  assert.equal(Number.isFinite(impulse.strength as number), true, 'strength 不能是 NaN');
  // 既有行为：零方向的冲量会被 GrassInteractionQueue 按「没有方向」丢掉。
  // 这里一并钉住，免得以后有人以为竖直起跳该压草。
  const queue = new GrassInteractionQueue();
  queue.applyImpulse(impulse as never);
  assert.deepEqual(queue.drain(), []);
});

test('y 参与移动距离：同样的水平位移，带高度差的压强更大', () => {
  // 位移要压在 MAX_MOTION_PRESSURE 的夹取阈值（travel ≈ 0.192）以下，
  // 否则两边都撞上限，y 的贡献会被夹掉、断言变成恒真。
  const sample = (horizontal: number, vertical: number): number => {
    const probe = createProbe();
    const root = new THREE.Group();
    const component = new GrassDisplacementComponent(
      createObjectPositionSampler(root),
      probe.target as never,
      { radius: 0.72, pressurePerSecond: 3 },
    );
    component.update(1 / 60);
    probe.impulses.length = 0;
    root.position.set(horizontal, vertical, 0);
    component.update(1 / 60);
    return probe.impulses[0].strength as number;
  };

  const withHeight = sample(0.05, 0.05);
  const withoutHeight = sample(0.05, 0);
  assert.ok(
    withHeight > withoutHeight,
    `y 没有参与距离计算：${withHeight} 应当大于 ${withoutHeight}`,
  );
});

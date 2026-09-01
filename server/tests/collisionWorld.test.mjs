import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCircleAgainstSimpleCollisions } from '../../shared/actor/simpleCollision.mjs';
import { CollisionWorld } from '../../shared/collision/CollisionWorld.mjs';
import { COLLISION_LAYER } from '../../shared/collision/collisionLayers.mjs';

/** 固定序列的伪随机数，保证这几个用例每次跑的是同一片场地。 */
function createRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function createBox(x, z, yaw, halfWidth, halfLength, layers = COLLISION_LAYER.MOVEMENT | COLLISION_LAYER.CAMERA) {
  return {
    collision: { centerX: 0, centerZ: 0, halfWidth, halfLength, minimumY: 0, maximumY: 2 },
    transform: { x, y: 0, z, yaw },
    layers,
  };
}

test('空间划分给出的推出结果与逐个遍历完全一致', () => {
  const random = createRandom(20240816);
  const world = new CollisionWorld({ cellSize: 8 });
  const all = [];
  for (let index = 0; index < 400; index += 1) {
    const box = createBox(
      random() * 200 - 100,
      random() * 200 - 100,
      random() * Math.PI * 2,
      0.2 + random() * 0.8,
      0.2 + random() * 0.8,
    );
    all.push(box);
  }
  world.setStaticGroup('field', all);

  const radius = 0.42;
  for (let sample = 0; sample < 500; sample += 1) {
    const point = { x: random() * 200 - 100, z: random() * 200 - 100 };
    const viaGrid = world.resolveCircle(point, radius);
    const viaScan = resolveCircleAgainstSimpleCollisions(point, radius, all);
    assert.ok(
      Math.abs(viaGrid.x - viaScan.x) < 1e-9 && Math.abs(viaGrid.z - viaScan.z) < 1e-9,
      `第 ${sample} 个采样点结果不一致：网格 ${JSON.stringify(viaGrid)} / 遍历 ${JSON.stringify(viaScan)}`,
    );
  }
});

test('静态分组整组进出，撤走之后路重新通了', () => {
  const world = new CollisionWorld();
  const blocked = { x: 3, z: 0 };
  world.setStaticGroup('0:0', [createBox(3, 0, 0, 1, 1)]);
  assert.equal(world.colliderCount, 1);
  assert.notDeepEqual(world.resolveCircle(blocked, 0.42), blocked);

  world.removeStaticGroup('0:0');
  assert.equal(world.colliderCount, 0);
  assert.deepEqual(world.resolveCircle(blocked, 0.42), blocked);
});

test('空间划分会把同一份玩家可跨越高度传给窄相', () => {
  const world = new CollisionWorld();
  const step = createBox(0, 0, 0, 1, 1);
  step.collision.maximumY = 0.12;
  world.setStaticGroup('step', [step]);
  const point = { x: 0, z: 0 };
  const profile = { minimumY: 0, maximumY: 0.84, maximumStepHeight: 0.2 };
  assert.deepEqual(
    world.resolveCircle(point, 0.42, { verticalProfile: profile }),
    resolveCircleAgainstSimpleCollisions(point, 0.42, [step], profile),
  );
  assert.deepEqual(world.resolveCircle(point, 0.42, { verticalProfile: profile }), point);
  assert.notDeepEqual(world.resolveCircle(point, 0.42), point);
});

test('动态碰撞体按 id 原地更新，移走后不再挡路', () => {
  const world = new CollisionWorld();
  const raft = createBox(0, 0, 0, 1.6, 2.4);
  world.setDynamic('raft', raft);
  assert.notDeepEqual(world.resolveCircle({ x: 0, z: 0 }, 0.42), { x: 0, z: 0 });

  raft.transform.x = 60;
  world.setDynamic('raft', raft);
  assert.equal(world.dynamicCount, 1);
  assert.deepEqual(world.resolveCircle({ x: 0, z: 0 }, 0.42), { x: 0, z: 0 });

  world.removeDynamic('raft');
  assert.equal(world.colliderCount, 0);
});

test('accept 过滤让 Actor 不会被自己的碰撞盒推走', () => {
  const world = new CollisionWorld();
  const self = createBox(0, 0, 0, 2, 2);
  self.actor = 'vessel';
  world.setDynamic('vessel', self);

  const withoutFilter = world.resolveCircle({ x: 0, z: 0 }, 0.5);
  assert.notDeepEqual(withoutFilter, { x: 0, z: 0 });

  const filtered = world.resolveCircle(
    { x: 0, z: 0 },
    0.5,
    { accept: (candidate) => candidate.actor !== 'vessel' },
  );
  assert.deepEqual(filtered, { x: 0, z: 0 });
});

test('扫掠球返回最早的遮挡位置，只看 CAMERA 层', () => {
  const world = new CollisionWorld();
  // 树干挡走路也挡镜头，树冠只挡镜头，且比树干更早出现在这条线段上。
  world.setStaticGroup('tree', [
    createBox(6, 0, 0, 0.22, 0.22),
    { ...createBox(4, 0, 0, 1.2, 1.2), layers: COLLISION_LAYER.CAMERA },
  ]);

  const start = [0, 1, 0];
  const end = [10, 1, 0];
  const camera = world.sweepSphere(start, end, 0.3);
  // 树冠外沿 4 - 1.2 = 2.8，再减去探针半径 0.3。
  assert.ok(Math.abs(camera - 0.25) < 1e-9, `实际 ${camera}`);

  const movementOnly = world.sweepSphere(start, end, 0.3, { layers: COLLISION_LAYER.MOVEMENT });
  assert.ok(Math.abs(movementOnly - 0.548) < 1e-9, `实际 ${movementOnly}`);

  assert.equal(world.sweepSphere([0, 9, 0], [10, 9, 0], 0.3), 1);
});

test('圆柱的空间登记、移动推出与相机扫掠共用真实圆形截面', () => {
  const world = new CollisionWorld();
  const cylinder = createBox(4, 0, 0, 1, 1);
  cylinder.collision.shape = 'cylinder';
  world.setStaticGroup('cylinder', [cylinder]);

  assert.deepEqual(
    world.resolveCircle({ x: 5.2, z: 1.2 }, 0.5),
    { x: 5.2, z: 1.2 },
    '圆柱外接方盒的斜角不能挡住移动体',
  );
  assert.ok(
    Math.abs(world.sweepSphere([0, 1, 0], [10, 1, 0], 0.5) - 0.25) < 1e-9,
    '沿圆心扫掠应在圆柱半径与探针半径之和处命中',
  );
  assert.equal(
    world.sweepSphere([0, 1, 1.6], [10, 1, 1.6], 0.5),
    1,
    '掠过圆柱外接方盒角落时不应产生相机命中',
  );
});

test('清空场景会连同静态与动态碰撞体一起丢掉', () => {
  const world = new CollisionWorld();
  world.setStaticGroup('0:0', [createBox(1, 1, 0, 1, 1)]);
  world.setDynamic('raft', createBox(5, 5, 0, 1, 1));
  world.clear();
  assert.equal(world.colliderCount, 0);
  assert.equal(world.staticGroupCount, 0);
  assert.equal(world.dynamicCount, 0);
});

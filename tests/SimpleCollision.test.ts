import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  circleTouchesSimpleCollision,
  createSimpleCollisionDefinition,
  createSimpleCollisionFromRender,
  resolveCircleAgainstSimpleCollision,
  resolveCircleAgainstSimpleCollisions,
} from '../shared/actor/simpleCollision.mjs';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';
import type { ActorSimpleCollision } from '../src/models/actors/ActorVisualModel';

/**
 * 每一种 render 模型一份合成 authoring 定义。
 *
 * 刻意用圆整数字，而不是照抄 `config/actors/` 里的真实值：
 *
 * - 派生公式要能从期望值里直接读出来——蘑菇 `radius: 1` 对上 `halfWidth: 0.4`，
 *   那个 0.4 就是分支里写的 `radius * 0.4`，不需要再翻源码去对；
 * - 策划调一次篝火半径不该让这条用例变红。它锁的是**派生规则**，不是当前的
 *   authoring 数值。
 */
const RENDER_DEFINITIONS: Record<string, Record<string, unknown>> = {
  'line-art-player-slime': { model: 'line-art-player-slime', radius: 0.5 },
  'line-art-pbf-slime': {
    model: 'line-art-pbf-slime', radius: 1, collisionRadius: 0.5, collisionHeight: 0.75,
  },
  'line-art-legged-slime': { model: 'line-art-legged-slime', radius: 0.5, hipHeight: 1 },
  'line-art-raft': { model: 'line-art-raft', width: 4, length: 6 },
  'line-art-cargo-crate': { model: 'line-art-cargo-crate', width: 1, length: 2, height: 0.5 },
  'line-art-reef': { model: 'line-art-reef', radius: 2, height: 3 },
  'line-art-elastic-mushroom': { model: 'line-art-elastic-mushroom', radius: 1, height: 2 },
  'line-art-training-dummy': { model: 'line-art-training-dummy', radius: 0.5, height: 2 },
  'line-art-focus-obelisk': { model: 'line-art-focus-obelisk', radius: 0.5, height: 3 },
  'line-art-floor-plaque': { model: 'line-art-floor-plaque', width: 4, length: 2, height: 0.25 },
  'line-art-campfire': { model: 'line-art-campfire', radius: 1, height: 0.5 },
  'line-art-dry-hay': { model: 'line-art-dry-hay', radius: 1, height: 0.75 },
  'line-art-wood-pile': { model: 'line-art-wood-pile', radius: 1, height: 0.5 },
  'line-art-stone-pile': { model: 'line-art-stone-pile', radius: 1, height: 0.25 },
  'line-art-fruit-pile': { model: 'line-art-fruit-pile', radius: 1, height: 0.5 },
  'line-art-wood-log': { model: 'line-art-wood-log', radius: 0.25, length: 2 },
};

/**
 * 上面那些定义当前派生出来的碰撞盒，**逐字段**锁定。
 *
 * 这张表存在的唯一理由：`createSimpleCollisionFromRender` 里那条 16 个模型的
 * `if` 链要拆成逐模型的注册单元（见 `doc/model-dispatch-refactor.md`），而搬运
 * 的正确性没有别的证据。搬完之后这张表必须一个数都不改地继续绿。
 *
 * 期望值里看不到 `centerX/centerZ` 以外的默认派生：`support*` 缺省时等于主形状，
 * 这里仍然把它写全，因为默认派生本身也在锁定范围内。
 */
const EXPECTED_COLLISIONS: Record<string, ActorSimpleCollision> = {
  'line-art-player-slime': {
    shape: 'cylinder', centerX: 0, centerZ: 0,
    halfWidth: 0.5, halfLength: 0.5,
    minimumY: 0, maximumY: 1,
    supportShape: 'cylinder', supportHalfWidth: 0.5, supportHalfLength: 0.5,
  },
  // 外壳 radius 1 不参与碰撞：碰撞圆柱走 collisionRadius / collisionHeight。
  'line-art-pbf-slime': {
    shape: 'cylinder', centerX: 0, centerZ: 0,
    halfWidth: 0.5, halfLength: 0.5,
    minimumY: 0, maximumY: 0.75,
    supportShape: 'cylinder', supportHalfWidth: 0.5, supportHalfLength: 0.5,
  },
  // 顶面 = leggedSlimeTopY(1, 0.5) = 1 + 0.5 * 0.55 + 0.5。腿不参与碰撞。
  'line-art-legged-slime': {
    shape: 'cylinder', centerX: 0, centerZ: 0,
    halfWidth: 0.5, halfLength: 0.5,
    minimumY: 0, maximumY: 1.775,
    supportShape: 'cylinder', supportHalfWidth: 0.5, supportHalfLength: 0.5,
  },
  // 甲板顶面写死 0.47，不随 authoring 尺寸走——桅杆不参与碰撞。
  'line-art-raft': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 2, halfLength: 3,
    minimumY: -0.24, maximumY: 0.47,
    supportShape: 'box', supportHalfWidth: 2, supportHalfLength: 3,
  },
  // 箱盖各向外探出 4cm：(1 + 0.08) * 0.5 = 0.54。顶面 0.5 * 0.88。
  'line-art-cargo-crate': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 0.54, halfLength: 1.04,
    minimumY: 0, maximumY: 0.44,
    supportShape: 'box', supportHalfWidth: 0.54, supportHalfLength: 1.04,
  },
  // 礁石埋进地面 height * 0.48，露出 height * 1.08。
  'line-art-reef': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 2, halfLength: 2,
    minimumY: -1.44, maximumY: 3.24,
    supportShape: 'box', supportHalfWidth: 2, supportHalfLength: 2,
  },
  // 菌柄细（radius * 0.4），菌盖是独立的宽支撑面——全仓唯一 support 与主形状不同的模型。
  'line-art-elastic-mushroom': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 0.4, halfLength: 0.4,
    minimumY: 0, maximumY: 2,
    supportShape: 'cylinder', supportHalfWidth: 1, supportHalfLength: 1,
  },
  'line-art-training-dummy': {
    shape: 'cylinder', centerX: 0, centerZ: 0,
    halfWidth: 0.5, halfLength: 0.5,
    minimumY: 0, maximumY: 2,
    supportShape: 'cylinder', supportHalfWidth: 0.5, supportHalfLength: 0.5,
  },
  'line-art-focus-obelisk': {
    shape: 'cylinder', centerX: 0, centerZ: 0,
    halfWidth: 0.5, halfLength: 0.5,
    minimumY: 0, maximumY: 3,
    supportShape: 'cylinder', supportHalfWidth: 0.5, supportHalfLength: 0.5,
  },
  'line-art-floor-plaque': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 2, halfLength: 1,
    minimumY: 0, maximumY: 0.25,
    supportShape: 'box', supportHalfWidth: 2, supportHalfLength: 1,
  },
  // 篝火、干草、三种堆共用同一条分支：方盒，radius 直接当半宽半长。
  'line-art-campfire': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 1, halfLength: 1,
    minimumY: 0, maximumY: 0.5,
    supportShape: 'box', supportHalfWidth: 1, supportHalfLength: 1,
  },
  'line-art-dry-hay': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 1, halfLength: 1,
    minimumY: 0, maximumY: 0.75,
    supportShape: 'box', supportHalfWidth: 1, supportHalfLength: 1,
  },
  'line-art-wood-pile': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 1, halfLength: 1,
    minimumY: 0, maximumY: 0.5,
    supportShape: 'box', supportHalfWidth: 1, supportHalfLength: 1,
  },
  'line-art-stone-pile': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 1, halfLength: 1,
    minimumY: 0, maximumY: 0.25,
    supportShape: 'box', supportHalfWidth: 1, supportHalfLength: 1,
  },
  'line-art-fruit-pile': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 1, halfLength: 1,
    minimumY: 0, maximumY: 0.5,
    supportShape: 'box', supportHalfWidth: 1, supportHalfLength: 1,
  },
  // 圆木躺着：长轴在 X，半长是 radius，上下各埋 radius。
  'line-art-wood-log': {
    shape: 'box', centerX: 0, centerZ: 0,
    halfWidth: 1, halfLength: 0.25,
    minimumY: -0.25, maximumY: 0.25,
    supportShape: 'box', supportHalfWidth: 1, supportHalfLength: 0.25,
  },
};

/**
 * `ActorRenderDefinition` 联合里声明了哪些模型。
 *
 * 用源码文本读而不是类型：`tsconfig.json` 的 `include` 没有 `tests`，测试文件不过
 * `tsc`，写成映射类型也不会有人替我们检查。`RenderSceneBoundary.test.ts` 盯 import
 * 用的是同一个办法。
 */
function declaredRenderModels(): string[] {
  const source = readFileSync(
    new URL('../src/scenes/data/SceneDefinition.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('export type ActorRenderDefinition =');
  assert.notEqual(start, -1, '找不到 ActorRenderDefinition 联合');
  const end = source.indexOf('\nexport ', start + 1);
  const union = source.slice(start, end === -1 ? undefined : end);
  return [...union.matchAll(/model: '([a-z0-9-]+)'/g)].map((match) => match[1]);
}

test('每一种 render 模型都有一份碰撞快照，一个都不少', () => {
  const declared = declaredRenderModels().sort();
  assert.ok(declared.length > 0, '联合里一个模型都没读到，正则该跟着改');
  // 联合里加了成员而这里没跟上，就是「新模型漏了碰撞分支」——那种漏法在
  // .mjs 侧没有任何编译期检查，只会在 spawn 时两端一起抛。
  assert.deepEqual(Object.keys(RENDER_DEFINITIONS).sort(), declared);
  assert.deepEqual(Object.keys(EXPECTED_COLLISIONS).sort(), declared);
});

test('模型尺寸派生的碰撞盒逐字段锁定', () => {
  for (const [model, render] of Object.entries(RENDER_DEFINITIONS)) {
    assert.deepEqual(createSimpleCollisionFromRender(render), EXPECTED_COLLISIONS[model], model);
  }
});

test('掉落物的滚动半径优先于模型分支，且半径缺省时仍走模型分支', () => {
  // 球形掉落物：Transform 表示球心，所以竖直区间对称。
  for (const model of Object.keys(RENDER_DEFINITIONS)) {
    assert.deepEqual(
      createSimpleCollisionFromRender(RENDER_DEFINITIONS[model], { radius: 0.25 }),
      {
        shape: 'cylinder', centerX: 0, centerZ: 0,
        halfWidth: 0.25, halfLength: 0.25,
        minimumY: -0.25, maximumY: 0.25,
        supportShape: 'cylinder', supportHalfWidth: 0.25, supportHalfLength: 0.25,
      },
      model,
    );
  }

  // wood-pile / stone-pile 的 dropMotion 没有 radius——它们整堆下落不翻滚，
  // 碰撞仍然要用模型那一份，否则堆会缩成一颗看不见的球。
  const woodPile = RENDER_DEFINITIONS['line-art-wood-pile'];
  assert.deepEqual(
    createSimpleCollisionFromRender(woodPile, { gravity: 9.8, drag: 5 }),
    EXPECTED_COLLISIONS['line-art-wood-pile'],
  );
  assert.deepEqual(
    createSimpleCollisionFromRender(woodPile, undefined),
    EXPECTED_COLLISIONS['line-art-wood-pile'],
  );
});

test('没有登记的模型不会静默退化成某个默认盒', () => {
  assert.throws(
    () => createSimpleCollisionFromRender({ model: 'line-art-not-registered' }),
    /line-art-not-registered/,
  );
  assert.throws(() => createSimpleCollisionFromRender({}), /unknown/);
});


test('圆柱按圆形截面推出，不会在外接方盒的四角形成隐形墙', () => {
  const collision = createSimpleCollisionDefinition({
    shape: 'cylinder',
    halfWidth: 1,
    halfLength: 1,
    minimumY: 0,
    maximumY: 1,
  });
  const instance = { collision, transform: { x: 0, z: 0, yaw: 0 } };

  // 到圆心 1.697m，已经在圆柱半径 1m + 移动体半径 0.5m 之外；
  // 若误用 2x2 方盒，这个位置仍会被盒角挡住。
  assert.deepEqual(
    resolveCircleAgainstSimpleCollision({ x: 1.2, z: 1.2 }, 0.5, instance),
    { x: 1.2, z: 1.2 },
  );

  const resolved = resolveCircleAgainstSimpleCollision({ x: 1, z: 1 }, 0.5, instance);
  assert.ok(Math.abs(Math.hypot(resolved.x, resolved.z) - 1.5) < 1e-9);
  assert.ok(Math.abs(resolved.x - resolved.z) < 1e-9);
});

test('圆形移动体会从带 yaw 的 Actor 有向盒最近侧面推出', () => {
  const collision = createSimpleCollisionDefinition({
    halfWidth: 1,
    halfLength: 2,
    minimumY: 0,
    maximumY: 1,
  });
  const instance = {
    collision,
    transform: { x: 0, z: 0, yaw: Math.PI / 2 },
  };
  const resolved = resolveCircleAgainstSimpleCollision({ x: 2.2, z: 0 }, 0.5, instance);
  assert.ok(Math.abs(resolved.x - 2.5) < 1e-9);
  assert.ok(Math.abs(resolved.z) < 1e-9);
  assert.equal(circleTouchesSimpleCollision(resolved, 0.5, instance), true);
});

test('完全位于盒内时仍能稳定推出，多个碰撞体的迭代次数保持固定', () => {
  const collision = createSimpleCollisionDefinition({
    halfWidth: 1,
    halfLength: 1,
    minimumY: 0,
    maximumY: 1,
  });
  const resolved = resolveCircleAgainstSimpleCollisions({ x: 0, z: 0 }, 0.42, [{
    collision,
    transform: { x: 0, z: 0, yaw: 0 },
  }]);
  assert.ok(Math.abs(resolved.x + 1.42) < 1e-9);
  assert.equal(resolved.z, 0);
});

test('玩家只被高于可跨越高度且与身体垂直重叠的 Actor 挡住', () => {
  const lowStep = {
    collision: createSimpleCollisionDefinition({
      halfWidth: 1,
      halfLength: 1,
      minimumY: 0,
      maximumY: 0.12,
    }),
    transform: { x: 0, y: 0, z: 0, yaw: 0 },
  };
  const profile = { minimumY: 0, maximumY: 0.84, maximumStepHeight: 0.2 };
  assert.deepEqual(
    resolveCircleAgainstSimpleCollisions({ x: 0, z: 0 }, 0.42, [lowStep], profile),
    { x: 0, z: 0 },
  );

  const wall = {
    ...lowStep,
    collision: createSimpleCollisionDefinition({
      halfWidth: 1,
      halfLength: 1,
      minimumY: 0,
      maximumY: 1,
    }),
  };
  const blocked = resolveCircleAgainstSimpleCollisions(
    { x: 0, z: 0 },
    0.42,
    [wall],
    profile,
  );
  assert.ok(Math.abs(blocked.x + 1.42) < 1e-9);

  const floating = {
    ...wall,
    collision: createSimpleCollisionDefinition({
      halfWidth: 1,
      halfLength: 1,
      minimumY: 1.2,
      maximumY: 2,
    }),
  };
  assert.deepEqual(
    resolveCircleAgainstSimpleCollisions({ x: 0, z: 0 }, 0.42, [floating], profile),
    { x: 0, z: 0 },
  );
});

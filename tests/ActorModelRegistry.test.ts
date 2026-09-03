import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MODEL_TRAITS,
  actorModelIds,
  modelHasTrait,
  modelsWithTrait,
} from '../shared/actor/models/index.mjs';
import { PLAYER_SHELL_MODELS } from '../src/render/RenderScene';
import { createActorVisualModel, hasRenderModel, renderModelIds } from '../src/models/actors/registry';

/**
 * 模型注册表的 trait 这一面。
 *
 * 这些 trait 替掉的是原来散在四处、各自维护的模型清单：`ActorCatalog` 的
 * `PILE_RENDER_MODELS` 与 `PLAYER_RENDER_MODELS`、`HighCountActorBatchSystem` 里
 * 同名的另一份、`playerVisualShape.isPlayerRenderDefinition` 的三个 `||`，以及
 * `ClientActorSystem` 的 `singleModels`。详见 `doc/model-dispatch-refactor.md`。
 *
 * **TS 类型没法从运行时值推导**，所以类型这一侧仍然各留了一份字面量清单
 * （`PLAYER_SHELL_MODELS`、`HighCountActorBatchSystem` 的 `PILE_MODELS`）。
 * 下面两条用例的全部作用，就是不让那两份清单和注册表漂移——漂了会怎样：
 * `isPileRender` 里那个类型谓词会对一个不在 `PileRender` 联合里的 render 返回
 * true，`createPilePieces` 于是把它当成果实堆去摆。
 */

/** 从源码文本里读出一份 `as const` 字面量清单。测试文件不过 tsc，只能这么读。 */
function readConstModelList(path: string, name: string): string[] {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const start = source.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${path} 里找不到 ${name}`);
  const end = source.indexOf('] as const;', start);
  assert.notEqual(end, -1, `${name} 不是 as const 字面量数组了，这条用例要跟着改`);
  return [...source.slice(start, end).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

test('playerShell trait 与 PlayerRenderDefinition 的类型清单一致', () => {
  assert.deepEqual([...PLAYER_SHELL_MODELS].sort(), modelsWithTrait('playerShell').sort());
});

test('pile trait 与合批系统的类型清单一致', () => {
  const declared = readConstModelList(
    '../src/actors/systems/HighCountActorBatchSystem.ts',
    'PILE_MODELS',
  );
  assert.deepEqual(declared.sort(), modelsWithTrait('pile').sort());
});

test('pileSingle 是 pile 的子集，且每一种都确实是堆叠物', () => {
  const piles = new Set(modelsWithTrait('pile'));
  for (const model of modelsWithTrait('pileSingle')) {
    assert.ok(piles.has(model), `${model} 带了 pileSingle 却不是 pile`);
  }
});

test('trait 只认白名单里的名字，拼错当场抛而不是永远返回 false', () => {
  assert.throws(() => modelHasTrait('line-art-wood-log', 'piles' as never), /piles/);
  assert.throws(() => modelsWithTrait('playerShells' as never), /playerShells/);
  // 白名单本身要覆盖实际用到的三个。
  assert.deepEqual([...MODEL_TRAITS].sort(), ['pile', 'pileSingle', 'playerShell']);
});

test('未注册的模型对任何 trait 都是否，且不抛', () => {
  for (const trait of MODEL_TRAITS) {
    assert.equal(modelHasTrait('line-art-not-registered', trait as never), false);
    assert.equal(modelHasTrait(undefined, trait as never), false);
  }
});

test('带 trait 的模型都在注册表里', () => {
  const ids = new Set(actorModelIds());
  for (const trait of MODEL_TRAITS) {
    for (const model of modelsWithTrait(trait as never)) {
      assert.ok(ids.has(model), `${model} 带着 ${trait} 却不在注册表里`);
    }
  }
});

/**
 * 模型注册表的两半。
 *
 * `shared/actor/models/` 那半不能 import three（房间 DS 也要读它），
 * `src/models/actors/registry.ts` 这半全是几何构造。两边各自登记，所以要有一条
 * 用例确认它们说的是同一批模型——否则某个模型「有碰撞盒但建不出来」或者反过来，
 * 都要等到 spawn 才发现。
 */
test('渲染侧注册表与 shared 注册表的模型集合一致', () => {
  assert.deepEqual([...renderModelIds()].sort(), [...actorModelIds()].sort());
});

test('未登记的模型抛错，而不是静默退化成另一种模型', () => {
  // 以前这里是 `if` 链的最后一支落到礁石：拿着别的模型的字段去建礁石，
  // 画出来是什么样没人说得准，报错也只会说「礁石缺字段」。
  assert.equal(hasRenderModel('line-art-not-registered'), false);
  assert.throws(
    () => createActorVisualModel(
      { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
      { model: 'line-art-not-registered' } as never,
    ),
    /line-art-not-registered/,
  );
});

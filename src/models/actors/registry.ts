import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createBuoyancyRaftModel } from '../ocean/createBuoyancyRaftModel';
import { createPlayerSlimeModel } from '../playerSlime';
import type { ActorVisualModel } from './ActorVisualModel';
import { createCampfireModel } from './createCampfireModel';
import { createCargoCrateModel } from './createCargoCrateModel';
import { createDryHayModel } from './createDryHayModel';
import { createElasticMushroomModel } from './createElasticMushroomModel';
import { createFloorPlaqueModel } from './createFloorPlaqueModel';
import { createFocusObeliskModel } from './createFocusObeliskModel';
import { createFruitPileModel } from './createFruitPileModel';
import { createLeggedSlimeModel } from './createLeggedSlimeModel';
import { createPbfSlimeModel } from './createPbfSlimeModel';
import { createReefModel } from './createReefModel';
import { createStonePileModel } from './createStonePileModel';
import { createTrainingDummyModel } from './createTrainingDummyModel';
import { createWoodLogModel } from './createWoodLogModel';
import { createWoodPileModel } from './createWoodPileModel';

/**
 * 渲染模型注册表——模型这一维度的**渲染侧那一半**。
 *
 * 另一半是 `shared/actor/models/`，那边住着碰撞派生、trait 与字段规格，并且
 * 不能 import `three`（房间 DS 也要读）。这一半反过来，全是几何构造。
 * 两半的键必须一致，由 `tests/ActorModelRegistry.test.ts` 钉住。
 * 完整背景见 `doc/model-dispatch-refactor.md`。
 *
 * 这张表是 `Record`，键类型就是 `ActorRenderDefinition['model']` 联合，所以
 * **少登记一种模型是编译错误**——原来那条 `if` 链靠「最后一支落到礁石」来收尾，
 * 类型上勉强成立（联合里正好只剩礁石），但新增模型时得到的报错是「礁石缺字段」，
 * 而不是「你忘了登记」。
 *
 * 每个条目的 `definition` 参数按自己那一种模型收窄，所以工厂签名对不上号会在
 * 这里当场报错，而不是等到运行时建出一个字段全是 undefined 的模型。
 */
type ActorModelRenderers = {
  [M in ActorRenderDefinition['model']]: (
    environment: FillMaterialEnvironment,
    definition: Extract<ActorRenderDefinition, { model: M }>,
  ) => ActorVisualModel;
};

/** 新增一种模型：写好工厂，在这里加一项。少一项编译不过。 */
const RENDERERS: ActorModelRenderers = {
  // 三种史莱姆不吃 environment：线稿蒙皮自带配色，不参与雾与地面色的混合。
  'line-art-player-slime': (_environment, definition) => createPlayerSlimeModel(definition),
  'line-art-pbf-slime': (_environment, definition) => createPbfSlimeModel(definition),
  'line-art-legged-slime': (_environment, definition) => createLeggedSlimeModel(definition),
  'line-art-raft': createBuoyancyRaftModel,
  'line-art-cargo-crate': createCargoCrateModel,
  'line-art-reef': createReefModel,
  'line-art-elastic-mushroom': createElasticMushroomModel,
  'line-art-training-dummy': createTrainingDummyModel,
  'line-art-focus-obelisk': createFocusObeliskModel,
  'line-art-floor-plaque': createFloorPlaqueModel,
  'line-art-campfire': createCampfireModel,
  'line-art-dry-hay': createDryHayModel,
  'line-art-wood-pile': createWoodPileModel,
  'line-art-wood-log': createWoodLogModel,
  'line-art-fruit-pile': createFruitPileModel,
  'line-art-stone-pile': createStonePileModel,
};

/** 注册表里全部模型 id。测试拿它与 `shared/actor/models` 那半边比对。 */
export function renderModelIds(): ActorRenderDefinition['model'][] {
  return Object.keys(RENDERERS) as ActorRenderDefinition['model'][];
}

export function hasRenderModel(model: string): boolean {
  return Object.hasOwn(RENDERERS, model);
}

/**
 * 按 render 定义建出模型。
 *
 * @throws 模型没登记时抛。以前这里会静默落到礁石——一个拿着别的模型字段去建的
 *   礁石，画出来是什么样没人说得准。
 */
export function createActorVisualModel(
  environment: FillMaterialEnvironment,
  definition: ActorRenderDefinition,
): ActorVisualModel {
  const create = RENDERERS[definition.model];
  if (!create) throw new TypeError(`渲染模型未登记：${definition.model}`);
  // 上面的映射类型已经把「键 → 参数类型」逐一对齐了，但在这里 `definition` 还是
  // 整个联合，TS 没法把它和取出来的那一支函数关联起来。收窄只能靠这一处断言。
  return (create as (
    environment: FillMaterialEnvironment,
    definition: ActorRenderDefinition,
  ) => ActorVisualModel)(environment, definition);
}

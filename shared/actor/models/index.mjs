/**
 * 渲染模型注册表。
 *
 * **「有哪些渲染模型」这个问题，从这里开始只有一个答案。**
 *
 * 在此之前，同一份模型清单在仓库里有八份互不引用的拷贝——碰撞派生、客户端模型
 * 工厂、服务端 catalog 校验、JSON Schema、TS 联合、合批系统、玩家外壳判定、渲染
 * rig 接线——新增一个普通道具要在其中七处各登记一遍，没有任何机制保证七份一致。
 * 完整清点与分步计划见 `doc/model-dispatch-refactor.md`。
 *
 * 这一步只搬了**碰撞派生**这一面（该文档的 Step 1）。往后 `traits`、`fields`
 * 也长在同一个描述符上，其余几处按同一张表派生。
 *
 * 这里不能 import `three`：房间 DS 和 `shared/` 都要读这张表，而碰撞盒本来就只
 * 取决于 authoring 尺寸，不取决于几何是怎么建出来的。模型工厂那一半住在
 * `src/models/actors/`，两半由测试钉住键一致。
 *
 * @typedef {object} ActorModelDescriptor
 * @property {string} id `render.model` 的值
 * @property {(render: Record<string, unknown>) => object} collision
 *   从 authoring 尺寸派生简易碰撞。纯函数，返回值交给
 *   `createSimpleCollisionDefinition` 补默认值。
 * @property {Partial<Record<ModelTrait, boolean>>} [traits]
 *   这个模型「是哪一类」。缺省即全部为否。
 */

/**
 * 已登记的 trait。
 *
 * 写成白名单而不是随便什么字符串：`modelHasTrait(m, 'piles')` 这种手误会永远
 * 安静地返回 false，而那正是这次重构要消灭的那一类 bug。拼错的 trait 名在
 * 加载时或调用时就抛。
 *
 * - `playerShell` 能当玩家外壳（带 playerMovement 时）
 * - `pile` 走 HighCountActorBatchSystem 合批绘制的堆叠物
 * - `pileSingle` 该堆叠物有单件形态，不只是把整堆缩小
 *
 * @typedef {'playerShell' | 'pile' | 'pileSingle'} ModelTrait
 */
export const MODEL_TRAITS = Object.freeze(['playerShell', 'pile', 'pileSingle']);

import { campfireModel } from './campfire.model.mjs';
import { cargoCrateModel } from './cargoCrate.model.mjs';
import { dryHayModel } from './dryHay.model.mjs';
import { elasticMushroomModel } from './elasticMushroom.model.mjs';
import { floorPlaqueModel } from './floorPlaque.model.mjs';
import { focusObeliskModel } from './focusObelisk.model.mjs';
import { fruitPileModel } from './fruitPile.model.mjs';
import { leggedSlimeModel } from './leggedSlime.model.mjs';
import { pbfSlimeModel } from './pbfSlime.model.mjs';
import { playerSlimeModel } from './playerSlime.model.mjs';
import { raftModel } from './raft.model.mjs';
import { reefModel } from './reef.model.mjs';
import { stonePileModel } from './stonePile.model.mjs';
import { trainingDummyModel } from './trainingDummy.model.mjs';
import { woodLogModel } from './woodLog.model.mjs';
import { woodPileModel } from './woodPile.model.mjs';

/** 新增一种模型：写一个 `*.model.mjs`，加进这个数组。就这两步。 */
const DESCRIPTORS = [
  playerSlimeModel,
  pbfSlimeModel,
  leggedSlimeModel,
  raftModel,
  cargoCrateModel,
  reefModel,
  elasticMushroomModel,
  trainingDummyModel,
  focusObeliskModel,
  floorPlaqueModel,
  campfireModel,
  dryHayModel,
  woodPileModel,
  woodLogModel,
  fruitPileModel,
  stonePileModel,
];

/** @type {Map<string, ActorModelDescriptor>} */
const MODELS = new Map();
for (const descriptor of DESCRIPTORS) {
  // 两个描述符抢同一个 id，后一个会静默盖掉前一个——那种错误在运行时表现为
  // 「某个模型的碰撞盒莫名其妙变成了另一种」，值得在加载时就炸。
  if (MODELS.has(descriptor.id)) {
    throw new TypeError(`渲染模型 id 重复：${descriptor.id}`);
  }
  for (const trait of Object.keys(descriptor.traits ?? {})) {
    if (!MODEL_TRAITS.includes(trait)) {
      throw new TypeError(`模型 ${descriptor.id} 带了未登记的 trait：${trait}`);
    }
  }
  // 单件形态是堆叠物的一种形态，脱开 pile 单独存在没有意义——合批系统根本
  // 不会去问一个非堆叠模型有没有单件模板。
  if (descriptor.traits?.pileSingle && !descriptor.traits.pile) {
    throw new TypeError(`模型 ${descriptor.id} 的 pileSingle 需要同时带 pile`);
  }
  MODELS.set(descriptor.id, descriptor);
}

function requireTrait(trait) {
  if (!MODEL_TRAITS.includes(trait)) {
    throw new TypeError(`未登记的模型 trait：${trait}`);
  }
  return trait;
}

/**
 * @param {unknown} id
 * @returns {ActorModelDescriptor | undefined} 没登记就是 undefined，由调用方决定怎么报错
 */
export function actorModel(id) {
  return MODELS.get(String(id ?? ''));
}

/** 注册表里全部模型 id，按登记顺序。 */
export function actorModelIds() {
  return [...MODELS.keys()];
}

/**
 * 这个模型是不是某一类。未登记的模型一律为否——调用方问的是「它是不是堆叠物」，
 * 对一个不存在的模型，答案就是不是。
 *
 * @param {unknown} id
 * @param {ModelTrait} trait
 */
export function modelHasTrait(id, trait) {
  return actorModel(id)?.traits?.[requireTrait(trait)] === true;
}

/**
 * 带某个 trait 的全部模型 id，按登记顺序。
 *
 * @param {ModelTrait} trait
 * @returns {string[]}
 */
export function modelsWithTrait(trait) {
  requireTrait(trait);
  return DESCRIPTORS.filter((descriptor) => descriptor.traits?.[trait] === true)
    .map((descriptor) => descriptor.id);
}

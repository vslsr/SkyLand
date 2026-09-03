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
 */

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
  stonePileModel,
  fruitPileModel,
  woodLogModel,
];

/** @type {Map<string, ActorModelDescriptor>} */
const MODELS = new Map();
for (const descriptor of DESCRIPTORS) {
  // 两个描述符抢同一个 id，后一个会静默盖掉前一个——那种错误在运行时表现为
  // 「某个模型的碰撞盒莫名其妙变成了另一种」，值得在加载时就炸。
  if (MODELS.has(descriptor.id)) {
    throw new TypeError(`渲染模型 id 重复：${descriptor.id}`);
  }
  MODELS.set(descriptor.id, descriptor);
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

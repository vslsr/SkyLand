import { itemCatalog, resolveItemUse } from '../items/index.mjs';

/**
 * 交互动作表。
 *
 * 「看着某个东西时，这个键到底是什么动作」只有这一个答案来源。在此之前，客户端
 * 的提示文案和服务端的分派各写了一遍同样的状态判断（谁叼着、谁装着、够不够得
 * 着），两份判断没有任何机制保证一致——界面写着「叼住」而服务端拒绝，或者反过
 * 来提示不出但按下去有反应，都属于这类漂移。
 *
 * 现在两端都调 `resolveActorAction`：客户端拿 `verb` 出提示，服务端拿 `id` 选
 * handler，并且拿同一个 `blocked` 判定挡下不该发生的请求。表里没有的组合就是
 * 「这个键现在没有动作」，两端一致。
 *
 * 这里只做**状态分派**，不做距离判定：距离要拿权威位姿算，只能在服务端做，
 * 客户端算出来的是给玩家看的预期而不是许可。
 */

/** 表里出现过的动作 id。服务端 `switch` 与客户端提示都从这里取。 */
export const ACTOR_ACTION_IDS = Object.freeze([
  'pickup-stack',
  'harvest-prop',
  'mushroom-grab',
  'mushroom-release',
  'drop-held',
  'cargo-load',
  'cargo-unload',
  'container-open',
]);

/**
 * @typedef {object} ActorActionTarget 候选 Actor 的复制态，客户端与服务端都拿得到。
 * @property {string} actorId
 * @property {string} label 显示名
 * @property {string} action `interactable.action`
 * @property {boolean} [enabled]
 * @property {number} [quantity] 掉落堆的数量，用于提示
 * @property {string|null} [carrierActorId] 被哪台载具装着
 * @property {string|null} [holderPlayerId] 被哪名玩家拉着（弹性拴绳）
 * @property {string|null} [pickupHolderActorId] 被哪个 Actor 叼着
 */

/**
 * @typedef {object} ActorActionContext 发起方的状态。
 * @property {string} [playerId]
 * @property {string} [controlledActorId] 正接管着的载具
 */

/**
 * @typedef {object} ActorActionResolution
 * @property {string} id 服务端据此选 handler
 * @property {string} verb 界面动词，已经带上物品名
 * @property {boolean} blocked true 表示只提示不放行（别人正占着、前置条件没满足）
 * @property {string} [requires] 缺的前置条件名；界面据此补上按键提示
 */

const quantitySuffix = (quantity) => (
  typeof quantity === 'number' && quantity > 1 ? ` ×${quantity}` : ''
);

const allow = (id, verb) => ({ id, verb, blocked: false });
/**
 * @param verb 说明为什么按不动
 * @param requires 缺的是哪个前置条件。界面据此补上「按哪个键去满足它」——键位属于
 *   输入方案，这张表不认识键，所以只报条件名，不报按键。
 */
const block = (verb, requires) => ({ id: 'blocked', verb, blocked: true, requires });

/**
 * 解析「现在按下交互键会发生什么」。
 *
 * @param {ActorActionTarget | undefined} target
 * @param {ActorActionContext} context
 * @returns {ActorActionResolution | undefined} 没有动作时是 undefined
 */
export function resolveActorAction(target, context = {}) {
  if (!target) return undefined;
  const { playerId, controlledActorId } = context;
  const name = `「${target.label}」`;

  // 手上那一件排在最前，不管它本来是什么：叼着的蘑菇、快捷栏拿出来的手持物，
  // 按下去说的都是「放下」。它们的 interactable 是关着的（不参与就近搜索），
  // 所以这一支必须走在 enabled 检查之前——一个已经建立的持续状态必须有一个
  // 确定的退出入口，否则手上那件就再也放不下来了。
  if (playerId && target.pickupHolderActorId === playerId) {
    return allow('drop-held', `放下${name}`);
  }

  switch (target.action) {
    case 'mushroom-bite': {
      if (!playerId) return undefined;
      if (target.holderPlayerId === playerId) return allow('mushroom-release', `松开${name}`);
      if (target.holderPlayerId) return block(`${name}正被叼住`);
      if (target.enabled === false) return undefined;
      return allow('mushroom-grab', `叼住${name}`);
    }

    case 'pickup-stack':
      if (target.enabled === false) return undefined;
      return allow('pickup-stack', `拾取「${target.label}${quantitySuffix(target.quantity)}」`);

    case 'harvest-prop':
      if (target.enabled === false) return undefined;
      return allow('harvest-prop', `砍伐${name}`);

    case 'container-open':
      if (target.enabled === false) return undefined;
      // 开着的时候同一个键说的是「关上」——和手上那件一样，持续状态要有退出入口。
      return target.containerOpen
        ? allow('container-open', `关上${name}`)
        : allow('container-open', `打开${name}`);

    case 'cargo-toggle': {
      if (target.enabled === false) return undefined;
      // 装卸是载具的动作而不是人的动作，所以先要有一台自己接管着的载具。
      if (!controlledActorId) return block(`先接管木筏，再装载${name}`, 'vessel-control');
      if (!target.carrierActorId) return allow('cargo-load', `装载${name}`);
      if (target.carrierActorId === controlledActorId) return allow('cargo-unload', `卸载${name}`);
      return block(`${name}已被其他木筏装载`);
    }

    default:
      return undefined;
  }
}

/**
 * 手持物品按下使用键会发生什么。
 *
 * 保留在动作表里是为了让「看着某个东西按键会怎样」和「手上这件按键会怎样」
 * 有同一个入口；真正的定义在 `shared/items/ItemAbility.mjs`——能不能用、走哪个
 * 输入槽、点按还是长按、倒计时多长，全写在物品目录里，界面、输入绑定和服务端
 * 的能力授予读的是同一份。加一件新道具不改这里的代码。
 *
 * @param {string | undefined} itemType
 * @param {{ get(id: string): object | undefined }} [catalog]
 * @returns {ReturnType<typeof resolveItemUse>} 不可使用时是 undefined
 */
export function resolveHeldItemAction(itemType, catalog = itemCatalog) {
  return resolveItemUse(itemType, catalog);
}

export { holdRatio } from '../items/index.mjs';

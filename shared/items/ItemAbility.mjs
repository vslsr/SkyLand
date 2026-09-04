import { itemCatalog } from './index.mjs';

/**
 * 物品使用 = 一条临时授予玩家的 Ability。
 *
 * 这一层只做「物品定义 → AbilityDefinition」的翻译，不认识场景、Actor、网络，
 * 也不知道投掷和采集各自怎么兑现——那是执行器的事，由服务端注入。放在 shared/
 * 是因为两端读同一份物品目录：客户端要按同一个 `mode` / `holdSeconds` 画圈，
 * 服务端按同一份数字判定，圈满那一刻就是激活那一刻。
 *
 * 生命周期是**授予 → 激活 → 收回**，三步都由 `ItemAbilityRuntime` 驱动：
 *
 * - 手持物品栏里的东西时授予（切格就换一条）；
 * - 背包里点「使用」时授予（这条不需要先拿到手上）；
 * - 激活完成后立刻收回，玩家身上不留一条用不到的能力。
 */

/** 物品使用能力占的语义槽位。同时只有一件东西的用法挂在玩家身上。 */
export const ITEM_USE_ABILITY_SLOT = 'item-use';

/** 激活期间挂在玩家身上的状态标签，供其它能力用 `none` 互斥。 */
export const ITEM_USE_STATE_TAG = 'State.Item.Using';

const USE_VERBS = Object.freeze({
  tool: '敲击',
  throw: '投掷',
});

/** 能力 id 按物品种类展开，快照里一眼看得出正握着哪件东西的用法。 */
export function itemAbilityId(itemType) {
  return `Ability.Item.${itemType}`;
}

/**
 * 一件物品用起来是什么样：动作、走哪个输入槽、点按还是长按、倒计时多长。
 *
 * 目录里没登记 `use` 的物品返回 undefined——它没有用法，不该被授予能力，
 * 按键在它身上也不该有反应。
 *
 * @returns {{ id: string, action: string, itemType: string, displayName: string,
 *   verb: string, input: string, mode: 'tap' | 'hold', holdSeconds: number,
 *   value: number } | undefined}
 */
export function resolveItemUse(itemType, catalog = itemCatalog) {
  const definition = itemType ? catalog.get(itemType) : undefined;
  const use = definition?.use;
  const verb = use ? USE_VERBS[use.action] : undefined;
  if (!use || !verb) return undefined;
  return {
    id: itemAbilityId(definition.id),
    action: use.action,
    itemType: definition.id,
    displayName: definition.displayName,
    verb: `${verb}「${definition.displayName}」`,
    input: use.input,
    mode: use.mode,
    holdSeconds: use.holdSeconds,
    value: use.value,
  };
}

/**
 * 把一次长按的已按时长换算成圆形倒计时的比例。
 *
 * 服务端按自己记的按下时刻算，客户端按本地时刻算同一个公式，所以圈画满那一刻
 * 和服务端判定倒计时结束是同一个时刻；客户端上报的时长只用来对齐表现。
 *
 * @returns {number} [0, 1]。`tap` 恒为 1——点一下就激活，没有倒计时可画。
 */
export function holdRatio(heldSeconds, holdSeconds) {
  if (!(holdSeconds > 0)) return 1;
  const held = Number(heldSeconds);
  if (!Number.isFinite(held) || held <= 0) return 0;
  return Math.min(1, held / holdSeconds);
}

/**
 * 为一件物品造一条使用能力。
 *
 * `lifecycle: 'instant'` 是刻意的：使用是一次结算，不是一段持续状态。激活时跑
 * 一遍 `execute`，跑完能力自己就结束了，调用方随后把它从槽位上收回——「完成后
 * 关闭能力」在这里是两步：能力自己结束，槽位由 Runtime 释放。
 *
 * @param {ReturnType<typeof resolveItemUse>} use
 * @param {(context: { use: object, payload: unknown }) => boolean} execute
 *   真正的世界效果。返回 false 表示这次激活什么都没做（面前没有可采集的目标之类）。
 */
export function createItemUseAbility(use, execute) {
  if (!use) throw new TypeError('createItemUseAbility 需要一份已解析的物品用法');
  if (typeof execute !== 'function') throw new TypeError('物品能力必须给出执行器');
  return Object.freeze({
    id: use.id,
    tags: Object.freeze(['Ability.Item', `Ability.Item.${use.action}`]),
    lifecycle: 'instant',
    // 同一时刻只结算一次使用：上一条还没结束时，后到的那次直接被挡下，
    // 而不是两次投掷抢同一个手持物。
    concurrency: 'blocking',
    concurrencyGroup: ITEM_USE_ABILITY_SLOT,
    ownedTags: Object.freeze([ITEM_USE_STATE_TAG]),
    onActivate: (context) => {
      execute({ use, payload: context.payload });
    },
  });
}

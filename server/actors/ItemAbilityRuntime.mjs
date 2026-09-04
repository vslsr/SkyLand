import {
  ACTION_STATE_COMPONENT,
  INVENTORY_COMPONENT,
  ITEM_USE_ABILITY_SLOT,
  createItemUseAbility,
  holdRatio,
  itemCooldownGroup,
  resolveItemUse,
} from '../../shared/actor/index.mjs';
import { actionStateId, fireSeconds } from '../../shared/animation/actionStates.mjs';
import { GAME_ABILITY_COMPONENT } from '../../shared/abilities/index.mjs';
import { createItemUseContext, runItemUseAction } from './ItemUseActions.mjs';

/**
 * 物品使用的权威运行时。
 *
 * 使用一件物品不再是「拿着它，然后在使用键的分支里写一段效果」，而是一条完整的
 * 能力生命周期：
 *
 *   授予（arm）→ 按物品配置激活（tap 点一下 / hold 倒计时走完）→ 完成后收回
 *
 * 两个入口共用这一条路径，区别只在货从哪扣：
 *
 * - **物品栏**：切到某一格就授予那一格的用法，用掉的是那一格；
 * - **背包**：菜单里点「使用」授予一次，用掉的是背包里那一摞，全程不经过手。
 *
 * 判定时刻全部记在服务端：客户端画的那圈圆形倒计时和这里读的是同一个
 * `holdSeconds`，所以圈满那一刻就是这里激活那一刻，客户端上报的时长不作数。
 */

/** 使用来源。决定这次激活从哪本账上扣货。 */
const ITEM_USE_SOURCES = new Set(['hotbar', 'backpack']);

/**
 * 让玩家身上挂着的物品能力和「现在该用哪件东西」保持一致。
 *
 * 幂等：已经挂着对的那条就什么都不做。切格、用光、丢下、收包之后都调一次，
 * 玩家身上因此永远不会留着一条指向已经不在手上的东西的能力。
 *
 * 背包那条能力（`source: 'backpack'`）优先：它是玩家刚刚显式点出来的，不该被
 * 一次手持同步悄悄顶掉。它自己在激活或取消时收回。
 */
export function syncItemAbility(scene, player) {
  const armed = player?.itemAbility;
  if (armed?.source === 'backpack') return false;
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const itemType = inventory?.heldItemType;
  if (armed?.itemType === itemType && armed?.source === 'hotbar') return false;
  if (!itemType) return revokeItemAbility(player);
  return armItemAbility(scene, player, itemType, 'hotbar');
}

/**
 * 授予一条物品使用能力，替换掉原来那条。
 *
 * @param {'hotbar' | 'backpack'} source
 * @returns 是否真的授予了。物品没有用法（`use` 没登记）时不授予——那件东西按键
 *   就该没有反应，挂一条空能力只会让界面画出一个按下去什么都不发生的提示。
 */
export function armItemAbility(scene, player, itemType, source) {
  const abilities = player?.getComponent(GAME_ABILITY_COMPONENT);
  const use = resolveItemUse(itemType);
  if (!abilities || !use || !ITEM_USE_SOURCES.has(source)) return revokeItemAbility(player);
  revokeItemAbility(player);
  const inventory = player.getComponent(INVENTORY_COMPONENT);
  const slotIndex = source === 'hotbar' ? inventory?.activeHotbarIndex ?? -1 : -1;
  // 激活有没有做成事，由执行器写回这条记录：能力系统只说「激活请求通过了」，
  // 「面前没有可采集的目标」这类空转要由效果自己报。
  const armed = { itemType: use.itemType, source, slotIndex, use, succeeded: false };
  abilities.grant(
    ITEM_USE_ABILITY_SLOT,
    createItemUseAbility(use, ({ payload }) => {
      armed.succeeded = runItemUseAction(createItemUseContext(scene, player, {
        use,
        source,
        slotIndex,
        heldSeconds: payload?.heldSeconds ?? 0,
        chargeRatio: payload?.chargeRatio ?? 1,
      }));
    }),
    `item:${use.itemType}`,
  );
  player.itemAbility = armed;
  player.itemUseStartedAt = undefined;
  return true;
}

/** 收回物品使用能力。「完成后关闭能力」的那一半，另一半是能力自己结束。 */
export function revokeItemAbility(player) {
  if (!player) return false;
  const had = player.itemAbility !== undefined;
  player.itemAbility = undefined;
  player.itemUseStartedAt = undefined;
  // 按住到一半被换手 / 用光：那段动作不再成立，状态跟着回到没在做什么。
  // 结算那一下（`fire`）不走这里——它由 `activateItemAbility` 在收回之后重新写上。
  clearActionState(player);
  // 槽位一律释放，不看本地记录：记录和 GAS 万一漂移，下一次 grant 会因为
  // 「槽位已存在」直接抛，那时玩家身上的能力就永远换不掉了。
  player.getComponent(GAME_ABILITY_COMPONENT)?.revoke(ITEM_USE_ABILITY_SLOT);
  return had;
}

/**
 * 按下使用键。
 *
 * `tap` 在这里不激活：一次点击是「按下再松开」，激活留给 `releaseItemUse`，
 * 按住不放不会连发。`hold` 与 `charge` 记下起点，圈由 `updateItemUse` 每 tick 推进。
 *
 * **冷却中的那一下在这里就被挡住**，而不是等到激活时被能力系统拒绝：不挡的话，
 * 玩家会先看到一圈画满的蓄力，松手才发现这一下从来没算数。
 */
export function beginItemUse(player, now) {
  if (!player?.itemAbility || itemUseCooldownRemaining(player) > 0) return false;
  player.itemUseStartedAt = now;
  // 按住的那一段是所有人都看得见的动作：进状态，让别人也演得出来。点按没有这一段。
  const use = player.itemAbility.use;
  enterActionState(player, use.action, use.mode, {
    itemType: use.itemType,
    startedAt: now,
    duration: use.holdSeconds,
  });
  return true;
}

/**
 * 把这次使用写进**动作状态**那条复制通道。
 *
 * 使用能力那三个时刻（按下 / 激活 / 收回）就是状态机的三次转移，所以状态在这里
 * 写、也只在这里写——它是这台状态机的投影，不是第二份真相。
 *
 * @returns 状态是否真的变了
 */
function enterActionState(player, verb, phase, options) {
  const action = player?.getComponent(ACTION_STATE_COMPONENT);
  const state = actionStateId(verb, phase);
  // 点按没有按住那一段（`tap` 不是相位），拼不出 id 时就不进状态。
  return Boolean(action && state) && action.enter(state, options);
}

/** 回到「没在做什么」。打断、切走手持物、用完收回都走这一条。 */
function clearActionState(player) {
  return player?.getComponent(ACTION_STATE_COMPONENT)?.clear() === true;
}

/**
 * 让有确定长度的那些状态自己走完。
 *
 * 只管 `fire`：它是一段有头有尾的表现，演完就该回到「没在做什么」，否则快照会一直
 * 说这个人在咽同一口东西。按住那两段（`hold` / `charge`）不在这里收——它们的结束
 * 由玩家松手或激活决定，圈满了也可能还按着。
 *
 * @returns 这一 tick 有没有收掉一条
 */
export function updateActionState(player, now) {
  const action = player?.getComponent(ACTION_STATE_COMPONENT);
  if (!action?.isActive || !action.state.endsWith('.fire')) return false;
  if (action.duration <= 0) return false;
  if (now - action.startedAt < action.duration * 1000) return false;
  return action.clear();
}

/**
 * 手上这件东西还要等多久才能再用一次，秒；没有冷却时是 0。
 *
 * 冷却记在 GAS 上、按**物品种类**分组，所以它跨得过能力的授予与收回——用完就收回
 * 那条能力，冷却却不该跟着一起消失。快照把它发给客户端画冷却圆盘。
 */
export function itemUseCooldownRemaining(player) {
  const armed = player?.itemAbility;
  // 直接问 runtime 而不是 `abilitySystem`：后者在组件还没挂上 Actor 时会抛，
  // 而这里被每 tick 的快照调用，抛出去等于整个房间停摆。
  const runtime = player?.getComponent(GAME_ABILITY_COMPONENT)?.runtime;
  if (!armed || !runtime) return 0;
  return runtime.getCooldownRemaining(itemCooldownGroup(armed.itemType));
}

/**
 * 松开使用键。
 *
 * - `tap`：这就是那一下点击，激活。
 * - `hold`：倒计时还没走完就松手 = 取消。走完的那一刻已经由 `updateItemUse`
 *   激活并清掉了起点，所以这里再收到的松手是一次空操作。
 * - `charge`：**松手这一刻就是那一下**，蓄了几成由服务端记的按下时刻算出来，
 *   随激活一起交给执行器。圈画满之后不自己激活，停在满圈上等这一下。
 */
export function releaseItemUse(scene, player, now) {
  const armed = player?.itemAbility;
  const startedAt = player?.itemUseStartedAt;
  if (!armed || startedAt === undefined) return false;
  player.itemUseStartedAt = undefined;
  if (armed.use.mode === 'hold') return false;
  return activateItemAbility(scene, player, (now - startedAt) / 1000);
}

/** 打断这次按下：界面盖上来、切走手持物、能力被换掉。 */
export function cancelItemUse(player) {
  if (!player || player.itemUseStartedAt === undefined) return false;
  player.itemUseStartedAt = undefined;
  // 打断也是一次转移：状态回到没在做什么，下一帧快照自然收敛，不需要一条 stop 事件。
  clearActionState(player);
  return true;
}

/**
 * 每 tick 推进长按倒计时，走完就激活。
 *
 * 激活发生在**倒计时结束那一刻**，不是松手那一刻：玩家看到的圈满就是结算，
 * 松不松手不改变结果。这条也是「客户端只画圈、不判定」成立的原因。
 *
 * 只管 `hold`。`charge` 画的是同一个圈，但圈满不是结算——它停在满圈上等松手，
 * 由 `releaseItemUse` 收尾。
 *
 * @returns 这一 tick 有没有激活出效果。
 */
export function updateItemUse(scene, player, now) {
  const armed = player?.itemAbility;
  const startedAt = player?.itemUseStartedAt;
  if (!armed || startedAt === undefined || armed.use.mode !== 'hold') return false;
  const elapsed = (now - startedAt) / 1000;
  if (holdRatio(elapsed, armed.use.holdSeconds) < 1) return false;
  player.itemUseStartedAt = undefined;
  return activateItemAbility(scene, player, elapsed);
}

/**
 * 激活并随即收回。
 *
 * 收回之后立刻重新对齐一次：手上那件还在的话，玩家马上就能再用一次；用光了
 * 就什么都不挂。「完成后关闭能力」因此不等于「下次要重新装备」。
 */
function activateItemAbility(scene, player, heldSeconds) {
  const armed = player?.itemAbility;
  const abilities = player?.getComponent(GAME_ABILITY_COMPONENT);
  if (!armed || !abilities) return false;
  armed.succeeded = false;
  // 蓄力比例按**服务端记的按下时刻**算，和客户端画的那个圈读同一个 `holdSeconds`：
  // 圈画到哪，这一下就蓄到哪。非 charge 的用法恒为 1——它们没有「蓄了几成」这回事。
  const chargeRatio = armed.use.mode === 'charge'
    ? holdRatio(heldSeconds, armed.use.holdSeconds)
    : 1;
  const result = abilities.activate(ITEM_USE_ABILITY_SLOT, {
    payload: { heldSeconds, chargeRatio, source: armed.source },
  });
  const succeeded = result.ok === true && armed.succeeded;
  revokeItemAbility(player);
  syncItemAbility(scene, player);
  // 结算那一下自己是一段动作（咽下去、弹一下）。写在收回之后：收回会把按住那一段
  // 的状态清掉，顺序反了这一下就会被自己清没。做成了才演——空转的一次不该有动作。
  if (succeeded) {
    enterActionState(player, armed.use.action, 'fire', {
      itemType: armed.use.itemType,
      startedAt: scene?.now?.() ?? 0,
      duration: fireSeconds(armed.use.action),
    });
  }
  return succeeded;
}

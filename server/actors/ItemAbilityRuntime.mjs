import {
  INVENTORY_COMPONENT,
  ITEM_USE_ABILITY_SLOT,
  createItemUseAbility,
  holdRatio,
  resolveItemUse,
} from '../../shared/actor/index.mjs';
import { GAME_ABILITY_COMPONENT } from '../../shared/abilities/index.mjs';
import { findItemArchetypeId } from './ItemArchetypes.mjs';

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
    createItemUseAbility(use, () => {
      armed.succeeded = executeItemUse(scene, player, use, source, slotIndex);
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
  // 槽位一律释放，不看本地记录：记录和 GAS 万一漂移，下一次 grant 会因为
  // 「槽位已存在」直接抛，那时玩家身上的能力就永远换不掉了。
  player.getComponent(GAME_ABILITY_COMPONENT)?.revoke(ITEM_USE_ABILITY_SLOT);
  return had;
}

/**
 * 按下使用键。
 *
 * `tap` 在这里不激活：一次点击是「按下再松开」，激活留给 `releaseItemUse`，
 * 按住不放不会连发。`hold` 记下起点，倒计时由 `updateItemUse` 每 tick 推进。
 */
export function beginItemUse(player, now) {
  if (!player?.itemAbility) return false;
  player.itemUseStartedAt = now;
  return true;
}

/**
 * 松开使用键。
 *
 * - `tap`：这就是那一下点击，激活。
 * - `hold`：倒计时还没走完就松手 = 取消。走完的那一刻已经由 `updateItemUse`
 *   激活并清掉了起点，所以这里再收到的松手是一次空操作。
 */
export function releaseItemUse(scene, player, now) {
  const armed = player?.itemAbility;
  const startedAt = player?.itemUseStartedAt;
  if (!armed || startedAt === undefined) return false;
  player.itemUseStartedAt = undefined;
  if (armed.use.mode !== 'tap') return false;
  return activateItemAbility(scene, player, (now - startedAt) / 1000);
}

/** 打断这次按下：界面盖上来、切走手持物、能力被换掉。 */
export function cancelItemUse(player) {
  if (!player || player.itemUseStartedAt === undefined) return false;
  player.itemUseStartedAt = undefined;
  return true;
}

/**
 * 每 tick 推进长按倒计时，走完就激活。
 *
 * 激活发生在**倒计时结束那一刻**，不是松手那一刻：玩家看到的圈满就是结算，
 * 松不松手不改变结果。这条也是「客户端只画圈、不判定」成立的原因。
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
  const result = abilities.activate(ITEM_USE_ABILITY_SLOT, {
    payload: { heldSeconds, source: armed.source },
  });
  const succeeded = result.ok === true && armed.succeeded;
  revokeItemAbility(player);
  syncItemAbility(scene, player);
  return succeeded;
}

/**
 * 能力激活时真正发生的事。
 *
 * 放在这里而不是能力定义里，是因为它要碰场景：投掷要生成一个掉落 Actor，采集要
 * 找面前那个可采集物件。能力定义留在 shared/，两端都读得到；世界效果留在服务端，
 * 只有权威侧跑得动。
 */
function executeItemUse(scene, player, use, source, slotIndex) {
  if (use.action === 'eat') return eatItem(player, use, source, slotIndex);
  if (use.action === 'throw') return throwItem(scene, player, use, source, slotIndex);
  if (use.action === 'tool') {
    // 工具敲的是面前那个可采集物件，力度来自物品目录，不是写死在采集代码里。
    // 工具不消耗：它在独立池里，敲一下少一把说不通。
    const target = scene.findHarvestablePropNear?.(player, use);
    return Boolean(target) && scene.applyToolHarvest(player, target, use.value) === true;
  }
  return false;
}

/**
 * 吃掉一个。
 *
 * 「吃」在这里就是**从账上扣掉 `value` 个**，扣不出来就当这次使用没做成——
 * 手上那一摞可能在倒计时走完之前被丢掉或收进了背包。
 *
 * 吃东西那段抖动是纯表现，跑在客户端：能力从按下到倒计时走完的那一整段就是嘴里
 * 嚼的那一段，圈满 = 咽下去 = 这里扣账。表现不过网，因为它没有任何权威含义——
 * 抖得对不对不改变背包里少了几个。
 *
 * 回血还没有：角色身上还没有一条可回复的属性。有了之后，加的是这一处的一行，
 * 而不是再来一条动词。
 */
function eatItem(player, use, source, slotIndex) {
  const inventory = player.getComponent(INVENTORY_COMPONENT);
  if (!inventory) return false;
  const eaten = source === 'hotbar'
    ? inventory.consumeHotbarSlot(slotIndex, use.value)
    : inventory.remove(use.itemType, use.value);
  return eaten === use.value;
}

/**
 * 投出去一个。
 *
 * 扣的是**账上**那一个，抛出去的是一个新生成的掉落 Actor：手上挂的那个是纯表现
 * 体（没有碰撞、没有掉落物理），把它直接扔出去就得给它临时补上一整套物理，还要
 * 保证下一次手持同步不会把飞在半空的那个当成手上那件。生成一个真正的掉落物、
 * 让掉落物理从出手位姿接管，两条链路各自完整。
 */
function throwItem(scene, player, use, source, slotIndex) {
  const inventory = player.getComponent(INVENTORY_COMPONENT);
  const archetypeId = findItemArchetypeId(scene.actorWorld.context.archetypes, use.itemType);
  // 没有掉落原型就扔不出去，这时账不能先扣。
  if (!inventory || !archetypeId) return false;
  const consumed = source === 'hotbar'
    ? inventory.consumeHotbarSlot(slotIndex, 1)
    : inventory.remove(use.itemType, 1);
  if (consumed !== 1) return false;

  // 出手速度就是 `use.value`（十倍米每秒）。长按不再按比例缩放它：倒计时决定的是
  // 这次投掷成不成立，不是它有多用力。
  const speed = use.value / 10;
  // 出手点抬到身前 0.6 米、0.6 米高：就地生成会和角色碰撞体重叠，第一帧就被弹开。
  scene.spawnItemStack(archetypeId, {
    position: [
      player.x + Math.sin(player.yaw) * 0.6,
      player.y + 0.6,
      player.z + Math.cos(player.yaw) * 0.6,
    ],
    quantity: 1,
    yaw: player.yaw,
    velocity: [Math.sin(player.yaw) * speed, 1.6 + speed * 0.35, Math.cos(player.yaw) * speed],
  });
  return true;
}

import { INVENTORY_COMPONENT } from '../../shared/actor/index.mjs';
import { ITEM_USE_ACTIONS } from '../../shared/items/index.mjs';
import { findItemArchetypeId } from './ItemArchetypes.mjs';

/**
 * 物品「用起来到底发生什么」的注册表。
 *
 * 物品目录里的 `use.action` 是一个动词（吃下、敲击、投掷、发射），这里是那个动词
 * 兑现成世界里一件事的地方。做成注册表而不是一条 switch，是为了让**别的系统能自己
 * 接进来**：武器系统实现 `shoot` 时，它注册一条执行器就够了，不需要回过头改物品
 * 系统的代码，也不需要物品系统认识弹丸、伤害、命中判定。
 *
 * 物品系统这一侧负责的是执行器**跑之前和跑之后**的全部：授予能力、按 mode 判定
 * 激活时刻、算出这次蓄了几成、把「这次用的是哪一格」和扣货 / 扣弹药的手柄准备好。
 * 执行器拿到 `ItemUseContext` 就能直接做事，返回 true / false 说这次到底做没做成——
 * 「面前没有可采集的目标」「弹药空了」这类空转由它自己报，能力系统只说「激活请求
 * 通过了」。
 *
 * 内置三条（eat / tool / throw）在这里注册，因为它们只碰物品和场景本身；`shoot`
 * 故意空着，留给武器系统。
 */

/**
 * 一次使用的全部上下文。这就是给别的系统的那份接口，加字段要当成改接口。
 *
 * @typedef {object} ItemUseContext
 * @property {object} scene 房间场景（权威侧），生成 Actor、找目标都问它
 * @property {object} player 用这件东西的玩家 Actor
 * @property {object} use `resolveItemUse` 解析出来的用法：动作、蓄力时长、冷却、
 *   `value`、以及这件东西的弹药位规格 `ammo`
 * @property {'hotbar' | 'backpack'} source 这次用的是手上那一格还是包里那一摞
 * @property {{ kind: 'hotbar', slotIndex: number } | { kind: 'backpack', itemType: string }} slot
 *   这次用的是**哪一格**。扣货、读弹药说的都是它，界面上那一格用的是同一个形状。
 * @property {number} heldSeconds 这次按了多久，秒（服务端记的时刻算出来的）
 * @property {number} chargeRatio 蓄了几成，[0, 1]。`charge` 之外恒为 1
 * @property {object | undefined} inventory 玩家的背包 Component
 * @property {(quantity?: number) => number} consumeItem 从这一格扣掉几个，返回实际扣掉的
 * @property {{ itemType: string, quantity: number } | undefined} ammo 这一格现在装着的弹药
 * @property {(quantity?: number) => number} consumeAmmo 打掉几发，返回实际扣掉的
 */

/** @type {Map<string, (context: ItemUseContext) => boolean>} */
const executors = new Map();

/**
 * 登记一个使用动词的执行器。
 *
 * @param {string} action 必须是物品目录认得的动词——目录里写不出来的动作，
 *   没有任何一件物品能触发它，注册它只会让人以为它在跑。
 * @param {(context: ItemUseContext) => boolean} execute 返回这次到底做没做成
 */
export function registerItemUseAction(action, execute) {
  if (!ITEM_USE_ACTIONS.includes(action)) {
    throw new TypeError(`物品使用动词未登记在物品目录里：${action}`);
  }
  if (typeof execute !== 'function') {
    throw new TypeError(`物品使用动词 ${action} 的执行器必须是函数`);
  }
  // 两个系统同时认领同一个动词是配置事故，不是「后来的覆盖前面的」：
  // 悄悄覆盖之后，跑的是哪一条要靠加载顺序猜。
  if (executors.has(action)) throw new Error(`物品使用动词已经有执行器了：${action}`);
  executors.set(action, execute);
  return () => { if (executors.get(action) === execute) executors.delete(action); };
}

/** 这个动词现在有人兑现吗。界面据此决定要不要把「使用」画成点得动。 */
export function hasItemUseAction(action) {
  return executors.has(action);
}

/**
 * 跑一次使用。
 *
 * 没人注册的动词返回 false：那件东西按下去什么都不发生，而不是抛异常把整个房间
 * tick 带下去——武器系统还没接进来时，弹弓就是一把打不响的弹弓。
 */
export function runItemUseAction(context) {
  const execute = executors.get(context?.use?.action);
  if (!execute) return false;
  return execute(context) === true;
}

/**
 * 吃掉一个。
 *
 * 「吃」在这里就是**从这一格扣掉 `value` 个**，扣不出来就当这次使用没做成——
 * 手上那一摞可能在倒计时走完之前被丢掉或收进了背包。
 *
 * 吃东西那段抖动是纯表现，跑在客户端：能力从按下到倒计时走完的那一整段就是嘴里
 * 嚼的那一段，圈满 = 咽下去 = 这里扣账。表现不过网，因为它没有任何权威含义——
 * 抖得对不对不改变背包里少了几个。
 *
 * 回血还没有：角色身上还没有一条可回复的属性。有了之后，加的是这一处的一行，
 * 而不是再来一条动词。
 */
registerItemUseAction('eat', ({ use, consumeItem }) => consumeItem(use.value) === use.value);

/**
 * 敲面前那个可采集物件。
 *
 * 力度来自物品目录，不是写死在采集代码里。工具不消耗：它在独立池里，敲一下少一把
 * 说不通。
 */
registerItemUseAction('tool', ({ scene, player, use }) => {
  const target = scene.findHarvestablePropNear?.(player, use);
  return Boolean(target) && scene.applyToolHarvest(player, target, use.value) === true;
});

/**
 * 投出去一个。
 *
 * 扣的是**账上**那一个，抛出去的是一个新生成的掉落 Actor：手上挂的那个是纯表现
 * 体（没有碰撞、没有掉落物理），把它直接扔出去就得给它临时补上一整套物理，还要
 * 保证下一次手持同步不会把飞在半空的那个当成手上那件。生成一个真正的掉落物、
 * 让掉落物理从出手位姿接管，两条链路各自完整。
 */
registerItemUseAction('throw', ({ scene, player, use, consumeItem }) => {
  const archetypeId = findItemArchetypeId(scene.actorWorld.context.archetypes, use.itemType);
  // 没有掉落原型就扔不出去，这时账不能先扣。
  if (!archetypeId) return false;
  if (consumeItem(1) !== 1) return false;

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
});

/**
 * 造一次使用的上下文。
 *
 * 扣货和扣弹药都做成闭包交出去，而不是把 `InventoryComponent` 直接摊给执行器：
 * 「这次用的是哪一格」是物品系统算出来的（手上那一格 / 包里那一摞），执行器不该
 * 为了扣一个货再把这件事推导一遍——推错了就会扣到另一本账上。
 */
export function createItemUseContext(scene, player, { use, source, slotIndex, heldSeconds, chargeRatio }) {
  const inventory = player?.getComponent(INVENTORY_COMPONENT);
  const slot = source === 'hotbar'
    ? { kind: 'hotbar', slotIndex }
    : { kind: 'backpack', itemType: use.itemType };
  return {
    scene,
    player,
    use,
    source,
    slot,
    heldSeconds,
    chargeRatio,
    inventory,
    consumeItem: (quantity = 1) => (source === 'hotbar'
      ? inventory?.consumeHotbarSlot(slotIndex, quantity) ?? 0
      : inventory?.remove(use.itemType, quantity) ?? 0),
    get ammo() { return inventory?.ammoAt(slot); },
    consumeAmmo: (quantity = 1) => inventory?.consumeAmmo(slot, quantity) ?? 0,
  };
}

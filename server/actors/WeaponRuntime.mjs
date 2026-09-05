import {
  HEALTH_COMPONENT,
  TRANSFORM_COMPONENT,
  WEAPON_SHOT_COMPONENT,
  resolveActorTags,
} from '../../shared/actor/index.mjs';
import {
  resolveWeaponStrike,
  weaponDamage,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';
import { GAME_ABILITY_COMPONENT } from '../../shared/abilities/index.mjs';
import { registerItemUseAction } from './ItemUseActions.mjs';

/**
 * 武器的权威结算（设计稿 `@w` 的 `D`）。
 *
 * 一次攻击拆成三段，三段各有各的归属：
 *
 * 1. **换算**（蓄力比例 → 落点、伤害倍率）在 `shared/items/weaponStrike.mjs`，
 *    因为客户端要用同一份画那条抛物线的落点；
 * 2. **取目标**（`D.EQS`）在这里：落点半径内、带生命值的东西。抛物线不参与判定，
 *    它是表现——判定只认落点与半径；
 * 3. **扣血**走 `HealthMutations`，和调试指令、以后的陷阱走同一个入口。
 *
 * 冷却不在这里：它写在物品目录的 `use.cooldownSeconds` 上，由物品系统在授予能力时
 * 兑现，所以「CD 里按了没反应」和「没弹药」是同一类失败，不需要两套判断。
 *
 * 这里做的是物品系统留出来的那一个空位：`shoot` 这个动词的执行器。武器系统自己
 * 注册进去，物品系统不需要认识伤害、命中和落点。
 *
 * 目标遍历只走「带生命值的 Actor」这一条索引，不扫全世界：场景常驻 Actor 由
 * Schema 限制在 256 个以内，因此成本不随流式世界的面积增长。
 */

/**
 * 开一次火。**射手是谁不在这里问**。
 *
 * 只要求 `shooter` 是一个带 Transform 的 Actor：位姿从 Transform 读、伤害来源从
 * 它身上的 GAS 读（没有就是 undefined，扣血照样成立）、这一发记在它自己的
 * `WeaponShotComponent` 上。玩家、AI 单位、以后的炮塔走的因此是同一条路——
 * 「同一发箭」在系统里只有一种走法。
 *
 * @param scene 房间场景（权威侧）
 * @param shooter 开火的 Actor。要有 `TRANSFORM_COMPONENT`
 * @param weapon 物品目录里那份武器数据（`@w` 的 `D`）
 * @param chargeRatio 松手那一刻的蓄力比例 [0, 1]
 * @returns {boolean} 这一发到底打出去没有
 */
export function fireWeaponFrom(scene, shooter, weapon, chargeRatio) {
  // 没有 `@w` 条目就是一把打不响的武器：动词认得，兑现不了。
  if (!weapon) return false;
  const transform = shooter?.getComponent(TRANSFORM_COMPONENT);
  if (!transform) return false;
  const strike = resolveWeaponStrike(weapon, chargeRatio);
  // 空放：连箭都没出去，所以不进冷却、也不该被当成一次成功的使用。
  if (!strike) return false;

  const impact = weaponImpactPoint(transform.x, transform.z, transform.yaw, strike.distance);
  const source = shooter.getComponent(GAME_ABILITY_COMPONENT)?.abilitySystem;
  const nowSeconds = scene.now() / 1000;

  // 记下这一发，快照带出去：**别人也该看见那支箭**。挂在射手自己身上而不是记在
  // 玩家的一个裸属性上——AI 射的那一箭要和玩家射的走同一条复制路径。
  shooter.getComponent(WEAPON_SHOT_COMPONENT)?.record({
    x: transform.x,
    y: transform.y,
    z: transform.z,
    impactX: impact.x,
    impactZ: impact.z,
    ratio: strike.ratio,
  });

  // 打空了也算打出去了：一发射偏的箭同样该进冷却，所以命中数不参与返回值。
  for (const target of collectWeaponTargets(scene, shooter, impact, strike.radius)) {
    const damage = weaponDamage(weapon, strike, resolveActorTags(target));
    if (damage <= 0) continue;
    scene.applyHealthChange(target.id, -damage, { source, nowSeconds });
  }
  return true;
}

/**
 * `shoot` 这个使用动词的执行器：把一次「用物品」翻成一次开火。
 *
 * 薄到只剩一句话是有意的——物品系统那一侧知道的是「谁按了哪一格、蓄了几成」，
 * 武器系统知道的是「从哪儿往哪儿打」，这个函数就是那道缝。
 *
 * @param {import('./ItemUseActions.mjs').ItemUseContext} context
 */
export function fireWeapon({ scene, player, use, chargeRatio }) {
  return fireWeaponFrom(scene, player, use?.weapon, chargeRatio);
}

/**
 * 把 `shoot` 认领下来。
 *
 * 交出注销手柄，是为了让测试能把武器系统换成一个替身——不做成「后来的覆盖前面
 * 的」，是因为那样跑的是哪一条要靠加载顺序猜。
 */
export const unregisterShootAction = registerItemUseAction('shoot', fireWeapon);

/**
 * `D.EQS`：落点周围这一圈里所有能挨打的东西。
 *
 * 射手自己不在内——弓箭的落点可能落在脚边（蓄力不足时射程最短），把自己算进去
 * 会让一次空射变成自杀。射出去的东西打不到射出它的人，这条在别的武器上也成立。
 */
export function collectWeaponTargets(scene, shooter, impact, radius) {
  const targets = [];
  const squaredRadius = radius * radius;
  for (const actor of scene.actorWorld.query(HEALTH_COMPONENT, TRANSFORM_COMPONENT)) {
    if (actor.id === shooter.id) continue;
    if (actor.requireComponent(HEALTH_COMPONENT).dead) continue;
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const dx = transform.x - impact.x;
    const dz = transform.z - impact.z;
    if (dx * dx + dz * dz > squaredRadius) continue;
    targets.push(actor);
  }
  return targets;
}

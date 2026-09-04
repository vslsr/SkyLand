import {
  HEALTH_COMPONENT,
  TRANSFORM_COMPONENT,
  resolveActorTags,
} from '../../shared/actor/index.mjs';
import {
  resolveWeaponStrike,
  weaponDamage,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';
import { GAME_ABILITY_COMPONENT } from '../../shared/abilities/index.mjs';
import { applyDamage } from './HealthMutations.mjs';

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
 * 冷却不在这里：它是能力的属性（`AbilityDefinition.cooldown`），由 GAS 自己拦，
 * 所以「CD 里按了没反应」和「没弹药」是同一类失败，不需要两套判断。
 *
 * 目标遍历只走「带生命值的 Actor」这一条索引，不扫全世界：场景常驻 Actor 由
 * Schema 限制在 256 个以内，因此成本不随流式世界的面积增长。
 */

/**
 * 开一次火。
 *
 * @param {number} chargeRatio 松手那一刻的蓄力比例 [0, 1]。
 * @returns 命中了几个目标；`undefined` 表示这一次根本没打出去（空放）。
 */
export function fireWeapon(scene, player, use, chargeRatio) {
  const weapon = use?.weapon;
  const strike = resolveWeaponStrike(weapon, chargeRatio);
  // 空放：连箭都没出去，所以不进冷却、也不该被当成一次成功的使用。
  if (!strike) return undefined;
  const impact = weaponImpactPoint(player.x, player.z, player.yaw, strike.distance);
  const source = player.getComponent(GAME_ABILITY_COMPONENT)?.abilitySystem;
  const nowSeconds = scene.now() / 1000;

  let hits = 0;
  for (const target of collectWeaponTargets(scene, player, impact, strike.radius)) {
    const damage = weaponDamage(weapon, strike, resolveActorTags(target));
    if (damage <= 0) continue;
    const change = scene.applyHealthChange(target.id, -damage, { source, nowSeconds });
    if (change) hits += 1;
  }
  return hits;
}

/**
 * `D.EQS`：落点周围这一圈里所有能挨打的东西。
 *
 * 玩家自己不在内——弓箭的落点可能落在脚边（蓄力不足时射程最短），把自己算进去
 * 会让一次空射变成自杀。射出去的东西打不到射出它的人，这条在别的武器上也成立。
 */
export function collectWeaponTargets(scene, player, impact, radius) {
  const targets = [];
  const squaredRadius = radius * radius;
  for (const actor of scene.actorWorld.query(HEALTH_COMPONENT, TRANSFORM_COMPONENT)) {
    if (actor.id === player.id) continue;
    if (actor.requireComponent(HEALTH_COMPONENT).dead) continue;
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const dx = transform.x - impact.x;
    const dz = transform.z - impact.z;
    if (dx * dx + dz * dz > squaredRadius) continue;
    targets.push(actor);
  }
  return targets;
}

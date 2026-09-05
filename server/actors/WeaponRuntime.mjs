import {
  HEALTH_COMPONENT,
  TRANSFORM_COMPONENT,
  resolveActorTags,
} from '../../shared/actor/index.mjs';
import {
  itemCatalog,
  resolveWeaponStrike,
  weaponDamage,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';
import { MUZZLE_HEIGHT } from '../../shared/ballistics/index.mjs';
import { GAME_ABILITY_COMPONENT } from '../../shared/abilities/index.mjs';
import { registerItemUseAction } from './ItemUseActions.mjs';

/**
 * 武器的权威结算（设计稿 `@w` 的 `D`）。
 *
 * 一次攻击拆成三段，三段各有各的归属：
 *
 * 1. **换算**（蓄力比例 → 名义落点、伤害倍率）在 `shared/items/weaponStrike.mjs`，
 *    因为客户端要用同一份画那条抛物线；
 * 2. **飞过去**在 `ProjectileSystem`：松手生成一支真的会飞的箭，它沿弧推进、
 *    沿途扫掠碰撞；
 * 3. **取目标 + 扣血**在这里，发生在**箭停下来那一刻**：撞上的那一个先挨打，
 *    落点半径内的其余目标一并结算（`D.EQS`）。扣血走 `HealthMutations`，
 *    和调试指令、以后的陷阱走同一个入口。
 *
 * **为什么判定从「松手」挪到了「箭到了」**：松手即判定的模型下，墙、地形、站在
 * 半路上的人根本没有机会说话——判定在它们之前就做完了，箭因此穿墙、穿地形、
 * 穿实体。要让它们说得上话，这一箭必须真的在世界里飞一段，而「飞」就意味着
 * 判定发生在它真的到了的那一刻。
 *
 * 冷却不在这里，而且仍然记在松手上：它写在物品目录的 `use.cooldownSeconds` 上，
 * 由物品系统在授予能力时兑现，所以「CD 里按了没反应」和「没弹药」是同一类失败。
 * 射出去了就该进冷却，不管这一箭最后落在哪——等命中回来再算，会让一次射空的
 * 攻击永远不进 CD。
 *
 * 这里做的是物品系统留出来的那一个空位：`shoot` 这个动词的执行器。武器系统自己
 * 注册进去，物品系统不需要认识伤害、命中和落点。
 *
 * 目标遍历只走「带生命值的 Actor」这一条索引，不扫全世界：场景常驻 Actor 由
 * Schema 限制在 256 个以内，因此成本不随流式世界的面积增长。
 */

/**
 * 开一次火：把一支箭送上路。
 *
 * @param {import('./ItemUseActions.mjs').ItemUseContext} context
 * @returns {boolean} 这一发到底射出去没有。
 */
export function fireWeapon({ scene, player, use, chargeRatio }) {
  const weapon = use?.weapon;
  // 没有 `@w` 条目的 `shoot` 物品就是一把打不响的武器：动词认得，兑现不了。
  if (!weapon) return false;
  const strike = resolveWeaponStrike(weapon, chargeRatio);
  // 空放：连箭都没出去，所以不进冷却、也不该被当成一次成功的使用。
  if (!strike) return false;
  // 名义落点：没有任何东西挡路时这一箭会落在哪。真正的落点由飞行途中的扫掠决定，
  // 可能比这近得多——这正是「箭不再穿墙」的那一处差别。
  const impact = weaponImpactPoint(player.x, player.z, player.yaw, strike.distance);
  const projectile = scene.spawnProjectileActor?.(weapon.projectileArchetypeId, {
    originX: player.x,
    originY: player.y + MUZZLE_HEIGHT,
    originZ: player.z,
    impactX: impact.x,
    impactY: scene.projectileGroundHeightAt?.(impact.x, impact.z) ?? 0,
    impactZ: impact.z,
    ratio: strike.ratio,
    ownerActorId: player.id,
    weaponItemType: use.itemType,
  });
  // 射不出弹药的武器不算射出去了：悄悄退回「松手即判定」会把穿墙那条路重新接上。
  return Boolean(projectile);
}

/**
 * 一支箭停下来了：在**它真正停住的地方**结算这一发。
 *
 * 直接撞上的那个目标一定挨打，哪怕它的中心离落点比半径远（贴着扫掠球擦过去的
 * 那一下就是命中）；其余目标按 `D.EQS` 的落点半径收。两条合在一起去重，所以
 * 站在落点上又被正面射中的那一个只挨一次。
 *
 * @param {object} scene 房间场景（权威侧）
 * @param {import('../../shared/actor/index.mjs').ProjectileComponent} projectile 停下来的那一支
 * @param {{ x: number, y: number, z: number, targetActorId?: string }} impact
 * @returns {number} 这一发打到了几个目标
 */
export function resolveProjectileImpact(scene, projectile, impact) {
  const weapon = itemCatalog.get(projectile.weaponItemType)?.weapon;
  if (!weapon) return 0;
  // 伤害在这一刻才算，用的是射出时那一份蓄力：拉满的一箭飞到墙上仍然是拉满的一箭。
  const strike = resolveWeaponStrike(weapon, projectile.ratio);
  if (!strike) return 0;
  const shooter = scene.actorWorld.getActor(projectile.ownerActorId);
  const source = shooter?.getComponent(GAME_ABILITY_COMPONENT)?.abilitySystem;
  const nowSeconds = scene.now() / 1000;

  let hits = 0;
  const damaged = new Set();
  const apply = (target) => {
    if (!target || damaged.has(target.id)) return;
    damaged.add(target.id);
    const damage = weaponDamage(weapon, strike, resolveActorTags(target));
    if (damage <= 0) return;
    scene.applyHealthChange(target.id, -damage, { source, nowSeconds });
    hits += 1;
  };

  apply(impact.targetActorId ? scene.actorWorld.getActor(impact.targetActorId) : undefined);
  for (const target of collectWeaponTargets(scene, projectile.ownerActorId, impact, strike.radius)) {
    apply(target);
  }
  return hits;
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
 * 射手自己不在内——射出去的东西打不到射出它的人。这条在弓的最短射程（6 米）下
 * 尤其要紧：一箭被脚边的墙挡住时，落点就在自己身上。
 */
export function collectWeaponTargets(scene, ownerActorId, impact, radius) {
  const targets = [];
  const squaredRadius = radius * radius;
  for (const actor of scene.actorWorld.query(HEALTH_COMPONENT, TRANSFORM_COMPONENT)) {
    if (actor.id === ownerActorId) continue;
    if (actor.requireComponent(HEALTH_COMPONENT).dead) continue;
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const dx = transform.x - impact.x;
    const dz = transform.z - impact.z;
    if (dx * dx + dz * dz > squaredRadius) continue;
    targets.push(actor);
  }
  return targets;
}

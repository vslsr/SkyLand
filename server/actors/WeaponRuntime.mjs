import {
  HEALTH_COMPONENT,
  TRANSFORM_COMPONENT,
  WEAPON_SHOT_COMPONENT,
  resolveActorTags,
} from '../../shared/actor/index.mjs';
import {
  itemCatalog,
  resolveWeaponStrike,
  weaponDamage,
  weaponHitDirection,
  weaponHitImpulse,
  weaponImpactPoint,
} from '../../shared/items/index.mjs';
import { MUZZLE_HEIGHT, ballisticArcTangent } from '../../shared/ballistics/index.mjs';
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
 * @param itemType 这把武器在物品目录里的 id。**弹药要带着它飞**：伤害在箭停住
 *   那一刻才结算，那时得能再找回这份武器数据（标签倍率也在里面）。射手那时可能
 *   已经死了、走远了，所以不能等到命中再回头问他手上拿的是什么。
 * @returns {boolean} 这一发到底射出去没有
 */
export function fireWeaponFrom(scene, shooter, weapon, chargeRatio, itemType) {
  // 没有 `@w` 条目就是一把打不响的武器：动词认得，兑现不了。
  if (!weapon) return false;
  const transform = shooter?.getComponent(TRANSFORM_COMPONENT);
  if (!transform) return false;
  const strike = resolveWeaponStrike(weapon, chargeRatio);
  // 空放：连箭都没出去，所以不进冷却、也不该被当成一次成功的使用。
  if (!strike) return false;

  // 名义落点：没有任何东西挡路时这一箭会落在哪。真正的落点由飞行途中的扫掠决定，
  // 可能比这近得多——这正是「箭不再穿墙」的那一处差别。
  const impact = weaponImpactPoint(transform.x, transform.z, transform.yaw, strike.distance);
  const projectile = scene.spawnProjectileActor?.(weapon.projectileArchetypeId, {
    originX: transform.x,
    originY: transform.y + MUZZLE_HEIGHT,
    originZ: transform.z,
    impactX: impact.x,
    impactY: scene.projectileGroundHeightAt?.(impact.x, impact.z) ?? 0,
    impactZ: impact.z,
    ratio: strike.ratio,
    ownerActorId: shooter.id,
    weaponItemType: itemType,
  });
  // 射不出弹药的武器不算射出去了：悄悄退回「松手即判定」会把穿墙那条路重新接上。
  if (!projectile) return false;

  // 记下这一发，快照带出去：**别人那把弓也该抖一下弦**。挂在射手自己身上而不是
  // 记在玩家的一个裸属性上——AI 射的那一箭要和玩家射的走同一条复制路径。
  //
  // 只带一个自增计数：飞出去那支箭是复制过来的 Actor，落在哪儿由它自己说了算，
  // 接收方不需要（也不该）按落点再画一支——那样一发箭会变成两支，而本地画的那支
  // 不认识墙。
  shooter.getComponent(WEAPON_SHOT_COMPONENT)?.record();
  return true;
}

/**
 * 一支箭停下来了：在**它真正停住的地方**结算这一发。
 *
 * 直接撞上的那个目标一定挨打，哪怕它的中心离落点比半径远（贴着扫掠球擦过去的
 * 那一下就是命中）；其余目标按 `D.EQS` 的落点半径收。两条合在一起去重，所以
 * 站在落点上又被正面射中的那一个只挨一次。
 *
 * @param scene 房间场景（权威侧）
 * @param projectile 停下来的那一支（`ProjectileComponent`）
 * @param impact 它停在哪儿，以及正面撞上的那一个
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
  const impulse = weaponHitImpulse(strike);
  // 这一箭是顺着哪条线来的：出手点 → 这一个目标。取**出手点**而不是射手此刻站的
  // 地方，是因为伤害现在在箭飞到的那一刻才结算，射手早就走开了；出手点是这条弧
  // 的起点，也就是箭真正来的方向。落点半径里可能站着好几个东西，各自算各自的：
  // 打在侧面那一只身上的箭该从它的侧面进去。
  const arcYaw = Math.atan2(
    projectile.impactX - projectile.originX,
    projectile.impactZ - projectile.originZ,
  );
  // 竖直那一份取这一箭**停住那一点的切线**：拉满的一箭是以二十来度扎下来的，
  // 不是平着飞进去的。水平方向仍然按目标各自算（上面那段），两者合起来才是
  // 「从这一侧、以这个角度进来」。
  //
  // 用斜率而不是切线的 y 分量：下面交出去的水平分量是单位向量，两者要在同一个
  // 尺度上才配得起来；`recordHit` 会把合成的向量归一化。
  const tangent = ballisticArcTangent(projectile, projectile.travel, { x: 0, y: 0, z: 0 });
  const tangentHorizontal = Math.hypot(tangent.x, tangent.z);
  const slope = tangentHorizontal > 1e-6
    ? tangent.y / tangentHorizontal
    // 几乎垂直落下：水平方向没有意义了，直接按切线的竖直分量给一个陡到底的值。
    : Math.sign(tangent.y) * 1e3;

  let hits = 0;
  const damaged = new Set();
  const apply = (target) => {
    if (!target || damaged.has(target.id)) return;
    damaged.add(target.id);
    const damage = weaponDamage(weapon, strike, resolveActorTags(target));
    if (damage <= 0) return;
    // 方向随伤害一起过网，客户端拿它把蒙皮朝里砸一下（见 `src/render/RenderSlimeImpact.ts`）。
    // 形状不过网——每个客户端按同一个轴自己解，和咬住的那个尖同一个取向。
    const transform = target.requireComponent(TRANSFORM_COMPONENT);
    const direction = weaponHitDirection(
      projectile.originX,
      projectile.originZ,
      transform.x,
      transform.z,
      arcYaw,
    );
    scene.applyHealthChange(target.id, -damage, {
      source,
      nowSeconds,
      impact: { x: direction.x, y: slope, z: direction.z, impulse },
    });
    hits += 1;
  };

  apply(impact.targetActorId ? scene.actorWorld.getActor(impact.targetActorId) : undefined);
  for (const target of collectWeaponTargets(scene, projectile.ownerActorId, impact, strike.radius)) {
    apply(target);
  }
  return hits;
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
  return fireWeaponFrom(scene, player, use?.weapon, chargeRatio, use?.itemType);
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
 *
 * 认的是 **id** 而不是射手那个 Actor：结算发生在箭停住那一刻，那时射手可能已经
 * 死了、被收走了，但「不能打到自己」这条仍然成立。
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

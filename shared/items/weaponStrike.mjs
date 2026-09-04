import { tagMatches } from '../abilities/index.mjs';

/**
 * 一次武器攻击的全部换算，两端共用（设计稿 `@w` 的 `D`）。
 *
 * **为什么是共享的纯函数**：服务端按它判定，客户端按同一份画蓄力时那条白色抛物线
 * 的落点。两边各写一套的话，玩家瞄的地方和真正打中的地方会差一截——而那种偏差
 * 只有在有人抱怨「明明瞄准了」的时候才会被发现。
 *
 * 这里不认识 Actor、场景与网络：进来的是数字，出去的也是数字。
 */

/** 一次攻击的判定形状。落点 + 半径，抛物线不参与判定（它是 `A` 里的表现）。 */
export function resolveWeaponStrike(weapon, chargeRatio) {
  const ratio = clamp01(chargeRatio);
  if (!weapon) return undefined;
  // 空放：攒得太少就不发射，也不进冷却——按错一下不该让弓卡在那里。
  if (ratio < weapon.charge.minimumRatio) return undefined;
  return {
    ratio,
    distance: lerp(weapon.range.minimum, weapon.range.maximum, ratio),
    damageScale: lerp(weapon.charge.damageScale.minimum, weapon.charge.damageScale.maximum, ratio),
    radius: weapon.radius,
  };
}

/**
 * 落点：从出手位置沿朝向推出去 `distance` 米。
 *
 * 朝向用的是**权威 yaw**——它本来就在每一帧输入里，所以客户端不必再上报一个
 * 瞄准点，服务端也不必信任它。
 */
export function weaponImpactPoint(originX, originZ, yaw, distance) {
  return {
    x: originX + Math.sin(yaw) * distance,
    z: originZ + Math.cos(yaw) * distance,
  };
}

/**
 * 打在一个带这些标签的目标身上是多少伤害。
 *
 * 倍率表按声明顺序取**第一条命中的**，不是全部相乘：`Actor.Build` 与
 * `Actor.Build.Wall` 同时列出时，相乘会得到一个谁也没写下来的数。
 */
export function weaponDamage(weapon, strike, targetTags = []) {
  if (!weapon || !strike) return 0;
  return weapon.attack * strike.damageScale * tagMultiplier(weapon, targetTags);
}

/** 目标标签对应的倍率；没命中任何一条就是 1。 */
export function tagMultiplier(weapon, targetTags = []) {
  for (const entry of weapon?.tagMultipliers ?? []) {
    for (const tag of targetTags) {
      if (tagMatches(tag, entry.tag)) return entry.multiplier;
    }
  }
  return 1;
}

function clamp01(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

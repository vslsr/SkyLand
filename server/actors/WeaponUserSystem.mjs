import {
  HEALTH_COMPONENT,
  TRANSFORM_COMPONENT,
  WEAPON_USER_COMPONENT,
} from '../../shared/actor/index.mjs';
import {
  itemCatalog,
  resolveItemUse,
  weaponChargeRatioForDistance,
} from '../../shared/items/index.mjs';
import { fireWeaponFrom } from './WeaponRuntime.mjs';

/**
 * 会用弓的 AI 单位（`WeaponUserComponent`）。
 *
 * 它做的是玩家那一侧「输入 + 物品栏」做的事，只是没有输入也没有背包：**挑一个
 * 目标、转过去、拉够了就放**。放出去那一下走的是和玩家完全同一个
 * `fireWeaponFrom`——判定、伤害、标签倍率、复制都不再有第二条路径。
 *
 * 武器数值从物品目录读（`WeaponUserComponent.itemType`），所以 AI 拿的和玩家拿的
 * 是同一把弓：改平衡只改物品目录那一条。冷却也读同一个 `use.cooldownSeconds`。
 *
 * 目标只找**玩家**：这是这一版的边界，写在这里而不是散在判断里。AI 打 AI 要的是
 * 阵营，而阵营现在还不存在——先做出来会是一个没有人用的猜测。
 *
 * 成本正比于「带这个 Component 的 Actor 数 × 玩家数」，两者都由场景 Schema 与
 * 房间容量封顶，所以它不随流式世界的面积增长。
 */

/** 一次 tick 最多补的时长。卡顿之后不该让一个弓手瞬间攒出好几发。 */
const MAXIMUM_CATCH_UP_SECONDS = 0.25;
/** 朝向差在这个角度以内就算瞄准了。再严会让 AI 一直转、永远不放箭。 */
const AIM_TOLERANCE_RADIANS = 0.12;

export class WeaponUserSystem {
  constructor(scene) {
    this.scene = scene;
  }

  update(world, deltaSeconds) {
    const step = Math.max(0, Math.min(Number(deltaSeconds) || 0, MAXIMUM_CATCH_UP_SECONDS));
    if (step <= 0) return;
    for (const actor of world.query(WEAPON_USER_COMPONENT, TRANSFORM_COMPONENT)) {
      const user = actor.requireComponent(WEAPON_USER_COMPONENT);
      user.cooldownSeconds = Math.max(0, user.cooldownSeconds - step);
      // 死了就不放箭了。尸体停在倒下那一格，直到 `HealthSystem` 收走它。
      if (actor.getComponent(HEALTH_COMPONENT)?.dead) {
        user.chargedSeconds = 0;
        user.engaged = false;
        continue;
      }
      this.updateOne(actor, user, step);
    }
  }

  updateOne(actor, user, step) {
    const transform = actor.requireComponent(TRANSFORM_COMPONENT);
    const target = this.findTarget(transform, user.engageRadius);
    // 交战时站定，让巡逻放手（`PatrolPathSystem` 读的就是这个）：两个系统同时写
    // 朝向的话，一个把脸转向目标、另一个把脸转回路线，弓手会永远瞄不准。
    user.engaged = Boolean(target);
    // 目标走出射程就把弓放下：拉到一半的那一段不留着，下次要重新拉。
    if (!target) {
      user.chargedSeconds = 0;
      return;
    }

    const dx = target.x - transform.x;
    const dz = target.z - transform.z;
    const desiredYaw = Math.atan2(dx, dz);
    const aimed = this.turnToward(transform, desiredYaw, user.turnSpeed * step);
    // 冷却里照样瞄准：AI 该一直对着目标，只是那一下按不出去。
    if (user.cooldownSeconds > 0) {
      user.chargedSeconds = 0;
      return;
    }
    // 还没转过来就先不攒力：不然它会朝着侧面放出一箭，而玩家看到的是它正在转身。
    if (!aimed) return;

    user.chargedSeconds += step;
    if (user.chargedSeconds < user.chargeSeconds) return;

    const use = resolveItemUse(user.itemType);
    const weapon = itemCatalog.get(user.itemType)?.weapon;
    // **弓手瞄的是人，不是最大射程**：蓄到几成由目标有多远反解。总拉满的话，一个
    // 站在八米外的目标会被一发飞到二十二米的箭从头顶掠过去——那看上去不像强，像瞎。
    const chargeRatio = weaponChargeRatioForDistance(weapon, Math.hypot(dx, dz)) ?? 1;
    user.chargedSeconds = 0;
    // 冷却记在「放了一次」上，不记在「打没打中」上——和玩家那边同一条规矩，
    // 所以空放的那一箭同样要等。
    user.cooldownSeconds = use?.cooldownSeconds ?? 0;
    fireWeaponFrom(this.scene, actor, weapon, chargeRatio, user.itemType);
  }

  /** 射程内最近的那个玩家。活着的才算——尸体不该把一个弓手钉在原地。 */
  findTarget(transform, radius) {
    let best;
    let bestDistance = radius * radius;
    for (const player of this.scene.players.values()) {
      if (player.getComponent(HEALTH_COMPONENT)?.dead) continue;
      const dx = player.x - transform.x;
      const dz = player.z - transform.z;
      const distance = dx * dx + dz * dz;
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = player;
    }
    return best;
  }

  /** 朝目标转一步。返回这一刻算不算已经瞄上了。 */
  turnToward(transform, desiredYaw, maximumStep) {
    const delta = normalizeAngle(desiredYaw - transform.yaw);
    const step = Math.max(-maximumStep, Math.min(maximumStep, delta));
    transform.setWorldTransform(
      [transform.x, transform.y, transform.z],
      transform.yaw + step,
    );
    return Math.abs(delta) <= Math.max(AIM_TOLERANCE_RADIANS, maximumStep);
  }
}

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

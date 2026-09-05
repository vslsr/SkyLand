import { ActorComponent } from '../ActorComponent.mjs';

export const WEAPON_USER_COMPONENT = 'weapon-user';

/** 蓄力最长不超过这么久：再长就不是「拉弓」而是站着不动了。 */
const MAXIMUM_CHARGE_SECONDS = 10;

/**
 * 这个 AI 单位会用哪件武器、什么时候开火。
 *
 * **武器数据不在这里**，这里只写 `itemType`：一件东西只有一条账，弓的攻击力、
 * 射程、蓄力曲线都在物品目录那条 `@w` 上。AI 拿的和玩家拿的因此是同一把弓——
 * 在这里再抄一份数值，改平衡时就会漏掉一边。
 *
 * 交战距离与放箭前那段犹豫是**这个单位自己的性格**，不是弓的属性：同一把弓，
 * 沉稳的守卫会端很久再放，杂兵扫一下就射。所以它们写在这里。
 *
 * 冷却同样不在这里——它写在物品目录的 `use.cooldownSeconds` 上，AI 和玩家读的是
 * 同一个数。
 */
export class WeaponUserComponent extends ActorComponent {
  constructor(definition = {}) {
    super(WEAPON_USER_COMPONENT);
    const itemType = String(definition.itemType ?? '');
    if (!itemType) throw new TypeError('WeaponUser.itemType 必填');
    this.itemType = itemType;
    /** 目标进到这个距离以内就开始拉弓，米。 */
    this.engageRadius = positive(definition.engageRadius, 'engageRadius');
    /**
     * 放箭之前先拉多久，秒。
     *
     * 它是这个单位放手前的**那一段犹豫**，不是「蓄到几成」——蓄到几成由目标有多远
     * 反解（`weaponChargeRatioForDistance`），因为弓手瞄的是人，不是最大射程。
     * 所以这个数说的是玩家有多少时间躲开那一箭。
     */
    this.chargeSeconds = Math.min(
      MAXIMUM_CHARGE_SECONDS,
      positive(definition.chargeSeconds, 'chargeSeconds'),
    );
    /** 转身速度，弧度每秒。瞄不准的那一段是这个单位的破绽。 */
    this.turnSpeed = positive(definition.turnSpeed ?? 2.4, 'turnSpeed');

    /** 已经拉了多久。没有目标时归零——放下弓再举起来要重新拉。 */
    this.chargedSeconds = 0;
    /** 还要等多久才能再射一发，秒。 */
    this.cooldownSeconds = 0;
    /**
     * 这一刻有没有正在交战的目标。
     *
     * 交战时**站定**：巡逻系统据此跳过它。两个系统同时写朝向的话，一个把脸转向
     * 目标、另一个把脸转回路线，弓手会永远瞄不准——那不是「难打」，是打不出去。
     */
    this.engaged = false;
  }
}

function positive(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`WeaponUser.${field} 必须是正有限数字`);
  }
  return number;
}

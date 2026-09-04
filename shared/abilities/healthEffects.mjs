/**
 * 实体生命值的 GAS 定义（设计稿 `doc/designer-toolandweapon.md` 的「生命值系统」）。
 *
 * 权威数值住在 `AbilitySystem` 的 `Health` 属性里，不是某个 Component 上的裸字段：
 * 伤害与治疗因此天然走 Effect 通道，以后武器要加「按标签改判倍率」「中毒 DOT」
 * 这类东西时，接的是同一条路，而不是另开一套加减法。
 *
 * 这个文件和 `playerMovementEffects.mjs` 一样是**手写的共享定义**，
 * 不是 `runtime.mjs` 那份由 `npm run build:abilities` 生成的内核。
 */

/** 生命值属性 id。能力实验室里那条测试属性用的也是这个名字。 */
export const HEALTH_ATTRIBUTE = 'Health';

/** 死了之后挂上的状态标签。伤害与治疗都被它挡住：尸体不再掉血，也治不回来。 */
export const DEAD_STATE_TAG = 'State.Dead';

export const DAMAGE_EFFECT_ID = 'Effect.Health.Damage';
export const HEAL_EFFECT_ID = 'Effect.Health.Heal';

/** 伤害量与治疗量走 Effect 参数：一条定义配所有数值，不必每次现造一个 Effect。 */
export const HEALTH_AMOUNT_PARAMETER = 'amount';

function amountOf(context) {
  const amount = Number(context.parameters?.[HEALTH_AMOUNT_PARAMETER]);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

/** 一次性扣血。Instant Modifier 改的是基础值，所以效果结束后不会自己长回来。 */
export const DAMAGE_EFFECT = Object.freeze({
  id: DAMAGE_EFFECT_ID,
  lifetime: Object.freeze({ kind: 'instant' }),
  requirements: Object.freeze({ none: Object.freeze([DEAD_STATE_TAG]) }),
  modifiers: Object.freeze([Object.freeze({
    attributeId: HEALTH_ATTRIBUTE,
    operation: 'add',
    magnitude: (context) => -amountOf(context),
  })]),
});

export const HEAL_EFFECT = Object.freeze({
  id: HEAL_EFFECT_ID,
  lifetime: Object.freeze({ kind: 'instant' }),
  requirements: Object.freeze({ none: Object.freeze([DEAD_STATE_TAG]) }),
  modifiers: Object.freeze([Object.freeze({
    attributeId: HEALTH_ATTRIBUTE,
    operation: 'add',
    magnitude: (context) => amountOf(context),
  })]),
});

/**
 * 一条生命值属性定义。上限同时是属性的 `maximum`——治疗因此不必自己夹紧，
 * 溢出的那部分由 `AttributeSet` 吃掉。
 */
export function createHealthAttributes(maximumHealth) {
  const maximum = Number(maximumHealth);
  if (!Number.isFinite(maximum) || maximum <= 0) {
    throw new RangeError('实体生命值上限必须是正有限数字');
  }
  return [{
    id: HEALTH_ATTRIBUTE,
    initialValue: maximum,
    minimum: 0,
    maximum,
  }];
}

/** 当前生命值；没有这条属性的 AbilitySystem 返回 undefined。 */
export function readHealth(abilitySystem) {
  if (!abilitySystem?.attributes?.has(HEALTH_ATTRIBUTE)) return undefined;
  return abilitySystem.attributes.getCurrentValue(HEALTH_ATTRIBUTE);
}

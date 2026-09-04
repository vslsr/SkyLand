import {
  DAMAGE_EFFECT,
  DEAD_STATE_TAG,
  GAME_ABILITY_COMPONENT,
  HEAL_EFFECT,
  HEALTH_AMOUNT_PARAMETER,
  readHealth,
} from '../../shared/abilities/index.mjs';
import { HEALTH_COMPONENT } from '../../shared/actor/index.mjs';

/**
 * 权威扣血与回血。**唯一的入口**：伤害来源（今天是调试指令，以后是武器的
 * EffectDefinition）都从这里过，死亡判定与复制状态因此只有一份。
 *
 * 数值本身走 GAS Instant Effect，不在这里做加减法：`Effect.Health.Damage` 上的
 * `none: [State.Dead]` 让尸体自动免疫，以后要加「按目标标签改判倍率」时也只需要
 * 改 Effect，不必改调用方。
 */

function healthOf(actor) {
  const health = actor?.getComponent?.(HEALTH_COMPONENT);
  const gameAbility = actor?.getComponent?.(GAME_ABILITY_COMPONENT);
  if (!health || !gameAbility) return undefined;
  return { health, abilitySystem: gameAbility.abilitySystem };
}

function sanitizeAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * 把 GAS 的当前生命值同步到复制面，并按变化量记一次事件。
 *
 * 返回这次变化的描述；没有变化返回 undefined，因此调用方不必自己判断
 * 「打在尸体上」「治疗满血的人」这类空操作。
 */
function commitHealth(actor, health, abilitySystem, before, nowSeconds) {
  const after = readHealth(abilitySystem) ?? before;
  const delta = after - before;
  health.current = after;
  if (delta === 0) return undefined;
  health.lastDelta = delta;
  health.eventRevision += 1;
  health.revision += 1;
  const died = after <= 0 && !health.dead;
  if (died) {
    health.dead = true;
    health.deathRevision += 1;
    health.diedAt = Number.isFinite(nowSeconds) ? nowSeconds : 0;
    // 状态标签挂在 GAS 上而不是只有一个布尔：能力的 `activationRequirements`
    // 与效果的 `requirements` 读的都是标签，死亡因此天然挡住后续伤害与治疗。
    abilitySystem.addLooseTag(DEAD_STATE_TAG);
  }
  return {
    actorId: actor.id,
    before,
    after,
    delta,
    dead: health.dead,
    died,
  };
}

export function applyDamage(actor, amount, options = {}) {
  const target = healthOf(actor);
  const damage = sanitizeAmount(amount);
  if (!target || damage === 0) return undefined;
  const before = readHealth(target.abilitySystem);
  if (before === undefined) return undefined;
  target.abilitySystem.applyEffect(DAMAGE_EFFECT, {
    source: options.source,
    parameters: { [HEALTH_AMOUNT_PARAMETER]: damage },
  });
  return commitHealth(actor, target.health, target.abilitySystem, before, options.nowSeconds);
}

export function applyHeal(actor, amount, options = {}) {
  const target = healthOf(actor);
  const heal = sanitizeAmount(amount);
  if (!target || heal === 0) return undefined;
  const before = readHealth(target.abilitySystem);
  if (before === undefined) return undefined;
  target.abilitySystem.applyEffect(HEAL_EFFECT, {
    source: options.source,
    parameters: { [HEALTH_AMOUNT_PARAMETER]: heal },
  });
  return commitHealth(actor, target.health, target.abilitySystem, before, options.nowSeconds);
}

/** 这个 Actor 死了没有。没有生命值的东西（树、箱子）一律不算死。 */
export function isDead(actor) {
  return actor?.getComponent?.(HEALTH_COMPONENT)?.dead === true;
}

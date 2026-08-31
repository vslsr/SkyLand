import type { AbilitySystem } from './AbilitySystem';
import type {
  AbilityDefinition,
  AbilityHandle,
  AttributeDefinition,
  EffectDefinition,
  EffectHandle,
} from './definitions';

export interface AbilityLoadoutDefinition {
  readonly id: string;
  readonly attributes?: readonly AttributeDefinition[];
  readonly abilities?: readonly AbilityDefinition[];
  readonly startupEffects?: readonly EffectDefinition[];
}

/** 记录一次 Loadout 授予产生的运行时句柄，支持装备卸下时成组回收。 */
export class GrantedAbilityLoadout {
  public readonly id: string;
  public readonly abilityHandles: readonly AbilityHandle[];
  public readonly effectHandles: readonly EffectHandle[];
  private revoked = false;

  public constructor(
    private readonly system: AbilitySystem,
    id: string,
    abilityHandles: readonly AbilityHandle[],
    effectHandles: readonly EffectHandle[],
  ) {
    this.id = id;
    this.abilityHandles = [...abilityHandles];
    this.effectHandles = [...effectHandles];
  }

  public revoke(): boolean {
    if (this.revoked) return false;
    this.revoked = true;
    for (const handle of [...this.effectHandles].reverse()) this.system.removeEffect(handle);
    for (const handle of [...this.abilityHandles].reverse()) this.system.revokeAbility(handle);
    return true;
  }
}

/**
 * 将一组属性、能力和初始效果装配到 AbilitySystem。
 * 属性是实体 schema 的一部分，回收 Loadout 时不会删除；能力和持续效果会被回收。
 */
export function grantAbilityLoadout(
  system: AbilitySystem,
  definition: AbilityLoadoutDefinition,
): GrantedAbilityLoadout {
  if (!definition.id) throw new TypeError('AbilityLoadout id 不能为空');
  for (const attribute of definition.attributes ?? []) system.defineAttribute(attribute);
  const abilityHandles = (definition.abilities ?? []).map((ability) => (
    system.grantAbility(ability, definition.id)
  ));
  const effectHandles: EffectHandle[] = [];
  try {
    for (const effect of definition.startupEffects ?? []) {
      const result = system.applyEffect(effect, { source: system });
      if (!result.ok) throw new Error(`AbilityLoadout ${definition.id} 的初始效果被拒绝：${effect.id}`);
      if (result.handle) effectHandles.push(result.handle);
    }
  } catch (error) {
    for (const handle of [...effectHandles].reverse()) system.removeEffect(handle);
    for (const handle of [...abilityHandles].reverse()) system.revokeAbility(handle);
    throw error;
  }
  return new GrantedAbilityLoadout(system, definition.id, abilityHandles, effectHandles);
}

import type { TagLike } from '../tags/index';
import type { AbilitySystem } from './AbilitySystem';

export type AttributeId = string;
export type EffectId = string;
export type AbilityId = string;
export type AbilityHandle = string;
export type EffectHandle = string;

export interface AttributeDefinition {
  readonly id: AttributeId;
  readonly initialValue: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type ModifierOperation = 'add' | 'multiply' | 'override';

export interface ResolvedModifier {
  readonly attributeId: AttributeId;
  readonly operation: ModifierOperation;
  readonly magnitude: number;
  readonly priority: number;
  readonly order: number;
}

export interface AttributeCalculationInput {
  readonly attributeId: AttributeId;
  readonly baseValue: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly modifiers: readonly ResolvedModifier[];
}

/**
 * 属性数值计算的替换边界。默认实现使用 JavaScript；只有经过性能分析后，
 * 才需要在这里接入批量 TypedArray/WASM 后端。
 */
export interface AttributeCalculationBackend {
  calculate(inputs: readonly AttributeCalculationInput[]): ReadonlyMap<AttributeId, number>;
}

export interface EffectParameters {
  readonly [name: string]: number | string | boolean | undefined;
}

export interface EffectContext {
  readonly source?: AbilitySystem;
  readonly target: AbilitySystem;
  readonly parameters: EffectParameters;
}

export type EffectMagnitude = number | ((context: EffectContext) => number);

export interface EffectModifier {
  readonly attributeId: AttributeId;
  readonly operation: ModifierOperation;
  readonly magnitude: EffectMagnitude;
  readonly priority?: number;
}

export type EffectLifetime =
  | { readonly kind: 'instant' }
  | { readonly kind: 'timed'; readonly seconds: number }
  | { readonly kind: 'infinite' };

export interface TagRequirements {
  /** 必须全部满足。 */
  readonly all?: readonly TagLike[];
  /** 非空时至少满足一个。 */
  readonly any?: readonly TagLike[];
  /** 任意一个匹配都会拒绝。 */
  readonly none?: readonly TagLike[];
}

export interface EffectPeriod {
  readonly seconds: number;
  readonly executeOnApply?: boolean;
}

export interface EffectStacking {
  /** 默认使用 Effect id。 */
  readonly key?: string;
  readonly maxStacks: number;
  readonly scope?: 'target' | 'source';
  readonly refreshDurationOnApply?: boolean;
}

export interface EffectDefinition {
  readonly id: EffectId;
  readonly lifetime: EffectLifetime;
  readonly modifiers?: readonly EffectModifier[];
  readonly grantedTags?: readonly TagLike[];
  readonly requirements?: TagRequirements;
  /**
   * 设置后，Modifier 会按周期修改属性基础值；未设置时，非 Instant Modifier
   * 会在效果存续期间参与 CurrentValue 聚合。
   */
  readonly period?: EffectPeriod;
  readonly stacking?: EffectStacking;
}

export interface AbilityCost {
  readonly attributeId: AttributeId;
  /** 正数，激活时从属性基础值扣除。 */
  readonly amount: number;
}

export interface AbilityCooldown {
  readonly seconds: number;
  /** 多个能力可共享同一个冷却组；默认使用 Ability id。 */
  readonly group?: string;
}

export type AbilityConcurrency = 'parallel' | 'replaceable' | 'blocking';
export type AbilityLifecycle = 'instant' | 'active';

export interface AbilityEffectApplication {
  readonly effect: EffectDefinition;
  readonly target: 'owner' | 'target';
  readonly parameters?: EffectParameters;
}

export interface AbilityExecutionContext<TPayload = unknown> {
  readonly system: AbilitySystem;
  readonly handle: AbilityHandle;
  readonly target?: AbilitySystem;
  readonly payload: TPayload;
  applyEffect(
    effect: EffectDefinition,
    target?: AbilitySystem,
    parameters?: EffectParameters,
  ): EffectApplicationResult;
  end(): boolean;
}

export interface AbilityEndContext<TPayload = unknown> {
  readonly system: AbilitySystem;
  readonly handle: AbilityHandle;
  readonly target?: AbilitySystem;
  readonly payload: TPayload;
  readonly cancelled: boolean;
}

export interface AbilityDefinition<TPayload = unknown> {
  readonly id: AbilityId;
  readonly tags?: readonly TagLike[];
  readonly activationRequirements?: TagRequirements;
  readonly ownedTags?: readonly TagLike[];
  readonly cancelAbilitiesWithTags?: readonly TagLike[];
  readonly blockAbilitiesWithTags?: readonly TagLike[];
  readonly costs?: readonly AbilityCost[];
  readonly cooldown?: AbilityCooldown;
  readonly concurrency?: AbilityConcurrency;
  readonly concurrencyGroup?: string;
  readonly lifecycle?: AbilityLifecycle;
  readonly effects?: readonly AbilityEffectApplication[];
  readonly onActivate?: (context: AbilityExecutionContext<TPayload>) => void;
  readonly onEnd?: (context: AbilityEndContext<TPayload>) => void;
}

export type AbilityActivationFailure =
  | 'unknown-ability'
  | 'already-active'
  | 'tag-requirements'
  | 'blocked-by-ability'
  | 'concurrency-blocked'
  | 'cooldown'
  | 'insufficient-attribute'
  | 'missing-target'
  | 'effect-rejected';

export type AbilityActivationResult =
  | { readonly ok: true; readonly handle: AbilityHandle }
  | { readonly ok: false; readonly reason: AbilityActivationFailure };

export type EffectApplicationFailure = 'tag-requirements';

export type EffectApplicationResult =
  | { readonly ok: true; readonly handle?: EffectHandle }
  | { readonly ok: false; readonly reason: EffectApplicationFailure };

export interface AttributeSnapshot {
  readonly id: AttributeId;
  readonly baseValue: number;
  readonly currentValue: number;
}

export interface ActiveEffectSnapshot {
  readonly handle: EffectHandle;
  readonly effectId: EffectId;
  readonly sourceId?: string;
  readonly remainingSeconds?: number;
  readonly periodRemainingSeconds?: number;
  readonly stacks: number;
  readonly parameters: EffectParameters;
}

export interface GrantedAbilitySnapshot {
  readonly handle: AbilityHandle;
  readonly abilityId: AbilityId;
  readonly active: boolean;
  readonly sourceId?: string;
}

export interface AbilitySystemSnapshot {
  readonly ownerId: string;
  readonly elapsedSeconds: number;
  readonly attributes: readonly AttributeSnapshot[];
  readonly looseTags: readonly string[];
  readonly grantedTags: readonly string[];
  readonly abilities: readonly GrantedAbilitySnapshot[];
  readonly effects: readonly ActiveEffectSnapshot[];
  readonly cooldowns: Readonly<Record<string, number>>;
}

export type AbilitySystemEvent =
  | {
      readonly type: 'attribute-changed';
      readonly attributeId: AttributeId;
      readonly previousValue: number;
      readonly currentValue: number;
    }
  | { readonly type: 'effect-applied'; readonly effectId: EffectId; readonly handle?: EffectHandle }
  | { readonly type: 'effect-stacked'; readonly effectId: EffectId; readonly handle: EffectHandle; readonly stacks: number }
  | { readonly type: 'effect-removed'; readonly effectId: EffectId; readonly handle: EffectHandle; readonly reason: 'expired' | 'removed' }
  | { readonly type: 'ability-activated'; readonly abilityId: AbilityId; readonly handle: AbilityHandle }
  | { readonly type: 'ability-ended'; readonly abilityId: AbilityId; readonly handle: AbilityHandle; readonly cancelled: boolean };

export type AbilitySystemListener = (event: AbilitySystemEvent) => void;

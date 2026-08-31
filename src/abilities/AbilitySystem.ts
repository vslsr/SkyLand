import { TagContainer, defineTag, tagMatches, type Tag, type TagLike } from '../tags/index';
import { AttributeSet } from './AttributeSet';
import type {
  AbilityActivationResult,
  AbilityDefinition,
  AbilityExecutionContext,
  AbilityHandle,
  AbilitySystemEvent,
  AbilitySystemListener,
  AbilitySystemSnapshot,
  ActiveEffectSnapshot,
  AttributeCalculationBackend,
  AttributeDefinition,
  EffectApplicationResult,
  EffectContext,
  EffectDefinition,
  EffectHandle,
  EffectModifier,
  EffectParameters,
  GrantedAbilitySnapshot,
  ResolvedModifier,
  TagRequirements,
} from './definitions';

const DEFINITION_ID_PATTERN = /^[A-Za-z0-9_]+(?:[.:-][A-Za-z0-9_]+)*$/;
const EMPTY_PARAMETERS: EffectParameters = Object.freeze({});
const TIME_EPSILON = 1e-9;

interface GrantedAbility {
  readonly handle: AbilityHandle;
  readonly definition: AbilityDefinition<unknown>;
  readonly sourceId?: string;
}

interface ActiveAbility {
  readonly granted: GrantedAbility;
  readonly target?: AbilitySystem;
  readonly payload: unknown;
}

interface ActiveEffect {
  readonly handle: EffectHandle;
  readonly definition: EffectDefinition;
  readonly source?: AbilitySystem;
  readonly parameters: EffectParameters;
  readonly order: number;
  readonly stackKey?: string;
  readonly resolvedStacks: ResolvedModifier[][];
  remainingSeconds?: number;
  periodRemainingSeconds?: number;
}

export interface AbilitySystemOptions {
  readonly ownerId: string;
  readonly attributes?: readonly AttributeDefinition[];
  readonly attributeBackend?: AttributeCalculationBackend;
}

function assertDefinitionId(value: string, label: string): void {
  if (!DEFINITION_ID_PATTERN.test(value)) throw new TypeError(`${label} id 格式无效：${value}`);
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} 必须是正有限数字`);
}

function freezeParameters(parameters?: EffectParameters): EffectParameters {
  return parameters ? Object.freeze({ ...parameters }) : EMPTY_PARAMETERS;
}

/**
 * 每个可拥有属性、标签、效果和能力的实体持有一个 AbilitySystem。
 * 该类不依赖渲染、输入或网络；服务端可把 createSnapshot() 接入现有快照协议。
 */
export class AbilitySystem {
  public readonly ownerId: string;
  public readonly attributes: AttributeSet;

  private readonly looseTags = new TagContainer();
  private readonly grantedTagCounts = new Map<Tag, number>();
  private readonly abilities = new Map<AbilityHandle, GrantedAbility>();
  private readonly activeAbilities = new Map<AbilityHandle, ActiveAbility>();
  private readonly activeEffects = new Map<EffectHandle, ActiveEffect>();
  private readonly cooldowns = new Map<string, number>();
  private readonly listeners = new Set<AbilitySystemListener>();
  private elapsedSeconds = 0;
  private nextAbilityHandle = 1;
  private nextEffectHandle = 1;
  private nextEffectOrder = 1;

  public constructor(options: AbilitySystemOptions) {
    if (!options.ownerId) throw new TypeError('AbilitySystem ownerId 不能为空');
    this.ownerId = options.ownerId;
    this.attributes = new AttributeSet(options.attributes, {
      backend: options.attributeBackend,
      onChanged: (attributeId, previousValue, currentValue) => {
        this.emit({ type: 'attribute-changed', attributeId, previousValue, currentValue });
      },
    });
  }

  public subscribe(listener: AbilitySystemListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public defineAttribute(definition: AttributeDefinition): void {
    this.attributes.define(definition);
    this.recalculateAttributes();
  }

  public addLooseTag(tag: TagLike): void {
    this.looseTags.add(tag);
  }

  public removeLooseTag(tag: TagLike): boolean {
    return this.looseTags.delete(tag);
  }

  public hasTag(query: TagLike): boolean {
    if (this.looseTags.hasTag(query)) return true;
    for (const [tag, count] of this.grantedTagCounts) {
      if (count > 0 && tagMatches(tag, query)) return true;
    }
    return false;
  }

  public hasAllTags(tags: readonly TagLike[]): boolean {
    return tags.every((tag) => this.hasTag(tag));
  }

  public hasAnyTags(tags: readonly TagLike[]): boolean {
    return tags.some((tag) => this.hasTag(tag));
  }

  public grantAbility<TPayload = unknown>(
    definition: AbilityDefinition<TPayload>,
    sourceId?: string,
  ): AbilityHandle {
    this.validateAbilityDefinition(definition);
    const handle = `ability:${this.nextAbilityHandle++}`;
    this.abilities.set(handle, {
      handle,
      definition: definition as AbilityDefinition<unknown>,
      sourceId,
    });
    return handle;
  }

  public revokeAbility(handle: AbilityHandle): boolean {
    const granted = this.abilities.get(handle);
    if (!granted) return false;
    this.endAbility(handle, true);
    this.abilities.delete(handle);
    return true;
  }

  public findAbilityHandles(abilityId: string): readonly AbilityHandle[] {
    return [...this.abilities.values()]
      .filter((granted) => granted.definition.id === abilityId)
      .map((granted) => granted.handle);
  }

  public activateAbility<TPayload = unknown>(
    handle: AbilityHandle,
    options: { readonly target?: AbilitySystem; readonly payload?: TPayload } = {},
  ): AbilityActivationResult {
    const granted = this.abilities.get(handle);
    if (!granted) return { ok: false, reason: 'unknown-ability' };
    if (this.activeAbilities.has(handle)) return { ok: false, reason: 'already-active' };

    const definition = granted.definition;
    if (!this.matchesRequirements(definition.activationRequirements)) {
      return { ok: false, reason: 'tag-requirements' };
    }
    if (this.isBlockedByActiveAbility(definition)) {
      return { ok: false, reason: 'blocked-by-ability' };
    }
    if (this.isConcurrencyBlocked(definition)) {
      return { ok: false, reason: 'concurrency-blocked' };
    }
    const cooldownGroup = definition.cooldown?.group ?? definition.id;
    if ((this.cooldowns.get(cooldownGroup) ?? 0) > TIME_EPSILON) {
      return { ok: false, reason: 'cooldown' };
    }
    for (const cost of definition.costs ?? []) {
      if (this.attributes.getCurrentValue(cost.attributeId) + TIME_EPSILON < cost.amount) {
        return { ok: false, reason: 'insufficient-attribute' };
      }
    }
    for (const application of definition.effects ?? []) {
      const target = application.target === 'owner' ? this : options.target;
      if (!target) return { ok: false, reason: 'missing-target' };
      const additionalTags = target === this ? definition.ownedTags : undefined;
      target.validateEffectDefinition(application.effect);
      if (!target.matchesRequirements(application.effect.requirements, additionalTags)) {
        return { ok: false, reason: 'effect-rejected' };
      }
    }

    for (const cost of definition.costs ?? []) {
      this.attributes.modifyBaseValue(cost.attributeId, 'add', -cost.amount);
    }
    if (definition.costs?.length) this.recalculateAttributes();
    if (definition.cooldown) this.cooldowns.set(cooldownGroup, definition.cooldown.seconds);

    this.cancelAbilitiesFor(definition);
    this.cancelReplaceableAbilitiesFor(definition);
    const active: ActiveAbility = {
      granted,
      target: options.target,
      payload: options.payload,
    };
    this.activeAbilities.set(handle, active);
    this.addGrantedTags(definition.ownedTags);
    this.emit({ type: 'ability-activated', abilityId: definition.id, handle });

    const context: AbilityExecutionContext<unknown> = {
      system: this,
      handle,
      target: options.target,
      payload: options.payload,
      applyEffect: (effect, target = options.target ?? this, parameters) => (
        target.applyEffect(effect, { source: this, parameters })
      ),
      end: () => this.endAbility(handle),
    };

    try {
      for (const application of definition.effects ?? []) {
        const target = application.target === 'owner' ? this : options.target;
        if (!target) continue;
        const result = target.applyEffect(application.effect, {
          source: this,
          parameters: application.parameters,
        });
        if (!result.ok) {
          this.endAbility(handle, true);
          return { ok: false, reason: 'effect-rejected' };
        }
      }
      definition.onActivate?.(context);
    } catch (error) {
      this.endAbility(handle, true);
      throw error;
    }

    if ((definition.lifecycle ?? 'instant') === 'instant') this.endAbility(handle);
    return { ok: true, handle };
  }

  public endAbility(handle: AbilityHandle, cancelled = false): boolean {
    const active = this.activeAbilities.get(handle);
    if (!active) return false;
    this.activeAbilities.delete(handle);
    this.removeGrantedTags(active.granted.definition.ownedTags);
    active.granted.definition.onEnd?.({
      system: this,
      handle,
      target: active.target,
      payload: active.payload,
      cancelled,
    });
    this.emit({
      type: 'ability-ended',
      abilityId: active.granted.definition.id,
      handle,
      cancelled,
    });
    return true;
  }

  public canApplyEffect(definition: EffectDefinition): boolean {
    this.validateEffectDefinition(definition);
    return this.matchesRequirements(definition.requirements);
  }

  public applyEffect(
    definition: EffectDefinition,
    options: { readonly source?: AbilitySystem; readonly parameters?: EffectParameters } = {},
  ): EffectApplicationResult {
    this.validateEffectDefinition(definition);
    if (!this.matchesRequirements(definition.requirements)) {
      return { ok: false, reason: 'tag-requirements' };
    }
    const parameters = freezeParameters(options.parameters);
    const context: EffectContext = { source: options.source, target: this, parameters };

    if (definition.lifetime.kind === 'instant') {
      const modifiers = this.resolveModifiers(definition.modifiers, context, this.nextEffectOrder++);
      this.applyBaseModifiers(modifiers);
      this.emit({ type: 'effect-applied', effectId: definition.id });
      return { ok: true };
    }

    const stackTarget = this.findStackTarget(definition, options.source);
    if (stackTarget) {
      const stacking = definition.stacking;
      if (!stacking) throw new Error('内部错误：缺少 Effect stacking 定义');
      if (stackTarget.resolvedStacks.length < stacking.maxStacks) {
        const order = stackTarget.order + stackTarget.resolvedStacks.length / 1000;
        const resolved = this.resolveModifiers(definition.modifiers, context, order);
        stackTarget.resolvedStacks.push(resolved);
        if (definition.period?.executeOnApply) this.applyBaseModifiers(resolved);
        this.emit({
          type: 'effect-stacked',
          effectId: definition.id,
          handle: stackTarget.handle,
          stacks: stackTarget.resolvedStacks.length,
        });
      }
      if (stacking.refreshDurationOnApply && definition.lifetime.kind === 'timed') {
        stackTarget.remainingSeconds = definition.lifetime.seconds;
      }
      this.recalculateAttributes();
      return { ok: true, handle: stackTarget.handle };
    }

    const handle = `effect:${this.nextEffectHandle++}`;
    const order = this.nextEffectOrder++;
    const resolved = this.resolveModifiers(definition.modifiers, context, order);
    const active: ActiveEffect = {
      handle,
      definition,
      source: options.source,
      parameters,
      order,
      stackKey: definition.stacking?.key ?? (definition.stacking ? definition.id : undefined),
      resolvedStacks: [resolved],
      remainingSeconds: definition.lifetime.kind === 'timed'
        ? definition.lifetime.seconds
        : undefined,
      periodRemainingSeconds: definition.period?.seconds,
    };
    this.activeEffects.set(handle, active);
    this.addGrantedTags(definition.grantedTags);
    if (definition.period?.executeOnApply) this.applyBaseModifiers(resolved);
    this.recalculateAttributes();
    this.emit({ type: 'effect-applied', effectId: definition.id, handle });
    return { ok: true, handle };
  }

  public removeEffect(handle: EffectHandle): boolean {
    return this.removeEffectInternal(handle, 'removed');
  }

  public removeEffectsByTag(tag: TagLike): number {
    const handles = [...this.activeEffects.values()]
      .filter((effect) => (effect.definition.grantedTags ?? []).some((owned) => tagMatches(owned, tag)))
      .map((effect) => effect.handle);
    for (const handle of handles) this.removeEffectInternal(handle, 'removed');
    return handles.length;
  }

  public getCooldownRemaining(groupOrAbilityId: string): number {
    return this.cooldowns.get(groupOrAbilityId) ?? 0;
  }

  public update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('AbilitySystem.update deltaSeconds 必须是非负有限数字');
    }
    if (deltaSeconds === 0) return;
    this.elapsedSeconds += deltaSeconds;

    for (const [group, remaining] of this.cooldowns) {
      const next = Math.max(remaining - deltaSeconds, 0);
      if (next <= TIME_EPSILON) this.cooldowns.delete(group);
      else this.cooldowns.set(group, next);
    }

    for (const effect of [...this.activeEffects.values()]) {
      const availableTime = effect.remainingSeconds === undefined
        ? deltaSeconds
        : Math.min(deltaSeconds, effect.remainingSeconds);
      if (effect.periodRemainingSeconds !== undefined) {
        effect.periodRemainingSeconds -= availableTime;
        while (effect.periodRemainingSeconds <= TIME_EPSILON) {
          for (const stack of effect.resolvedStacks) this.applyBaseModifiers(stack);
          effect.periodRemainingSeconds += effect.definition.period?.seconds ?? Number.POSITIVE_INFINITY;
        }
      }
      if (effect.remainingSeconds !== undefined) {
        effect.remainingSeconds -= deltaSeconds;
        if (effect.remainingSeconds <= TIME_EPSILON) {
          this.removeEffectInternal(effect.handle, 'expired');
        }
      }
    }
  }

  public createSnapshot(): AbilitySystemSnapshot {
    const grantedTags = [...this.grantedTagCounts]
      .filter(([, count]) => count > 0)
      .map(([tag]) => tag);
    const abilities: GrantedAbilitySnapshot[] = [...this.abilities.values()].map((granted) => ({
      handle: granted.handle,
      abilityId: granted.definition.id,
      active: this.activeAbilities.has(granted.handle),
      sourceId: granted.sourceId,
    }));
    const effects: ActiveEffectSnapshot[] = [...this.activeEffects.values()].map((effect) => ({
      handle: effect.handle,
      effectId: effect.definition.id,
      sourceId: effect.source?.ownerId,
      remainingSeconds: effect.remainingSeconds,
      periodRemainingSeconds: effect.periodRemainingSeconds,
      stacks: effect.resolvedStacks.length,
      parameters: effect.parameters,
    }));
    return {
      ownerId: this.ownerId,
      elapsedSeconds: this.elapsedSeconds,
      attributes: this.attributes.createSnapshot(),
      looseTags: this.looseTags.toArray(),
      grantedTags,
      abilities,
      effects,
      cooldowns: Object.fromEntries(this.cooldowns),
    };
  }

  private matchesRequirements(
    requirements?: TagRequirements,
    additionalTags: readonly TagLike[] = [],
  ): boolean {
    if (!requirements) return true;
    const hasTag = (query: TagLike) => (
      this.hasTag(query) || additionalTags.some((tag) => tagMatches(tag, query))
    );
    if (requirements.all && !requirements.all.every(hasTag)) return false;
    if (requirements.any?.length && !requirements.any.some(hasTag)) return false;
    if (requirements.none && requirements.none.some(hasTag)) return false;
    return true;
  }

  private isBlockedByActiveAbility(candidate: AbilityDefinition<unknown>): boolean {
    const candidateTags = new TagContainer(candidate.tags ?? []);
    for (const active of this.activeAbilities.values()) {
      const blockedTags = active.granted.definition.blockAbilitiesWithTags ?? [];
      if (candidateTags.hasAny(blockedTags)) return true;
    }
    return false;
  }

  private isConcurrencyBlocked(candidate: AbilityDefinition<unknown>): boolean {
    if ((candidate.concurrency ?? 'parallel') === 'parallel') return false;
    const group = candidate.concurrencyGroup ?? 'default';
    return [...this.activeAbilities.values()].some((active) => (
      (active.granted.definition.concurrencyGroup ?? 'default') === group
      && (active.granted.definition.concurrency ?? 'parallel') === 'blocking'
    ));
  }

  private cancelAbilitiesFor(candidate: AbilityDefinition<unknown>): void {
    const queries = candidate.cancelAbilitiesWithTags ?? [];
    if (queries.length === 0) return;
    for (const active of [...this.activeAbilities.values()]) {
      const activeTags = new TagContainer(active.granted.definition.tags ?? []);
      if (activeTags.hasAny(queries)) this.endAbility(active.granted.handle, true);
    }
  }

  private cancelReplaceableAbilitiesFor(candidate: AbilityDefinition<unknown>): void {
    if ((candidate.concurrency ?? 'parallel') !== 'blocking') return;
    const group = candidate.concurrencyGroup ?? 'default';
    for (const active of [...this.activeAbilities.values()]) {
      if ((active.granted.definition.concurrencyGroup ?? 'default') !== group) continue;
      if ((active.granted.definition.concurrency ?? 'parallel') === 'replaceable') {
        this.endAbility(active.granted.handle, true);
      }
    }
  }

  private findStackTarget(
    definition: EffectDefinition,
    source?: AbilitySystem,
  ): ActiveEffect | undefined {
    if (!definition.stacking) return undefined;
    const key = definition.stacking.key ?? definition.id;
    return [...this.activeEffects.values()].find((effect) => (
      effect.stackKey === key
      && (definition.stacking?.scope !== 'source' || effect.source?.ownerId === source?.ownerId)
    ));
  }

  private resolveModifiers(
    modifiers: readonly EffectModifier[] | undefined,
    context: EffectContext,
    order: number,
  ): ResolvedModifier[] {
    return (modifiers ?? []).map((modifier, index) => {
      const magnitude = typeof modifier.magnitude === 'function'
        ? modifier.magnitude(context)
        : modifier.magnitude;
      if (!Number.isFinite(magnitude)) {
        throw new TypeError(`Effect ${context.target.ownerId} 的 Modifier magnitude 必须是有限数字`);
      }
      if (!this.attributes.has(modifier.attributeId)) {
        throw new Error(`Effect 引用了未知属性：${modifier.attributeId}`);
      }
      return {
        attributeId: modifier.attributeId,
        operation: modifier.operation,
        magnitude,
        priority: modifier.priority ?? 0,
        order: order * 1000 + index,
      };
    });
  }

  private applyBaseModifiers(modifiers: readonly ResolvedModifier[]): void {
    if (modifiers.length === 0) return;
    for (const modifier of modifiers) {
      this.attributes.modifyBaseValue(
        modifier.attributeId,
        modifier.operation,
        modifier.magnitude,
      );
    }
    this.recalculateAttributes();
  }

  private recalculateAttributes(): void {
    const persistentModifiers: ResolvedModifier[] = [];
    for (const effect of this.activeEffects.values()) {
      if (effect.definition.period) continue;
      for (const stack of effect.resolvedStacks) persistentModifiers.push(...stack);
    }
    this.attributes.recalculate(persistentModifiers);
  }

  private removeEffectInternal(
    handle: EffectHandle,
    reason: 'expired' | 'removed',
  ): boolean {
    const effect = this.activeEffects.get(handle);
    if (!effect) return false;
    this.activeEffects.delete(handle);
    this.removeGrantedTags(effect.definition.grantedTags);
    this.recalculateAttributes();
    this.emit({ type: 'effect-removed', effectId: effect.definition.id, handle, reason });
    return true;
  }

  private addGrantedTags(tags: readonly TagLike[] | undefined): void {
    for (const tagLike of tags ?? []) {
      const tag = defineTag(tagLike);
      this.grantedTagCounts.set(tag, (this.grantedTagCounts.get(tag) ?? 0) + 1);
    }
  }

  private removeGrantedTags(tags: readonly TagLike[] | undefined): void {
    for (const tagLike of tags ?? []) {
      const tag = defineTag(tagLike);
      const next = (this.grantedTagCounts.get(tag) ?? 0) - 1;
      if (next > 0) this.grantedTagCounts.set(tag, next);
      else this.grantedTagCounts.delete(tag);
    }
  }

  private validateAbilityDefinition<TPayload>(definition: AbilityDefinition<TPayload>): void {
    assertDefinitionId(definition.id, 'Ability');
    for (const cost of definition.costs ?? []) {
      assertPositiveFinite(cost.amount, `Ability ${definition.id} 的 cost amount`);
      if (!this.attributes.has(cost.attributeId)) {
        throw new Error(`Ability ${definition.id} 引用了未知消耗属性：${cost.attributeId}`);
      }
    }
    if (definition.cooldown) {
      assertPositiveFinite(definition.cooldown.seconds, `Ability ${definition.id} 的 cooldown`);
    }
    for (const tag of [
      ...(definition.tags ?? []),
      ...(definition.ownedTags ?? []),
      ...(definition.cancelAbilitiesWithTags ?? []),
      ...(definition.blockAbilitiesWithTags ?? []),
    ]) defineTag(tag);
  }

  private validateEffectDefinition(definition: EffectDefinition): void {
    assertDefinitionId(definition.id, 'Effect');
    if (definition.lifetime.kind === 'timed') {
      assertPositiveFinite(definition.lifetime.seconds, `Effect ${definition.id} 的 duration`);
    }
    if (definition.period) {
      if (definition.lifetime.kind === 'instant') {
        throw new Error(`Instant Effect ${definition.id} 不能设置 period`);
      }
      assertPositiveFinite(definition.period.seconds, `Effect ${definition.id} 的 period`);
    }
    if (definition.stacking) {
      if (definition.lifetime.kind === 'instant') {
        throw new Error(`Instant Effect ${definition.id} 不能设置 stacking`);
      }
      if (!Number.isInteger(definition.stacking.maxStacks) || definition.stacking.maxStacks < 1) {
        throw new RangeError(`Effect ${definition.id} 的 maxStacks 必须是正整数`);
      }
    }
    for (const modifier of definition.modifiers ?? []) {
      if (!this.attributes.has(modifier.attributeId)) {
        throw new Error(`Effect ${definition.id} 引用了未知属性：${modifier.attributeId}`);
      }
    }
    for (const tag of definition.grantedTags ?? []) defineTag(tag);
  }

  private emit(event: AbilitySystemEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

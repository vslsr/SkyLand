import { Actor } from '../../../shared/actor/Actor.mjs';
import {
  GAME_ABILITY_COMPONENT,
  GameAbilityComponent,
  type AbilityActivationFailure,
  type AbilitySystemEvent,
  type AbilitySystemSnapshot,
  type EffectDefinition,
} from '../index';

export type AbilityLabAction = 'arcane' | 'burn' | 'rage' | 'silence' | 'reset';
export type AbilityLabEventTone = 'success' | 'warning' | 'damage' | 'info';

export interface AbilityLabEvent {
  readonly message: string;
  readonly tone: AbilityLabEventTone;
}

export interface AbilityLabActionDefinition {
  readonly id: Exclude<AbilityLabAction, 'reset'>;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly manaCost: number;
  readonly cooldownGroup?: string;
}

export const ABILITY_LAB_ACTIONS: readonly AbilityLabActionDefinition[] = [
  {
    id: 'arcane',
    key: '1',
    name: '奥术弹',
    description: '造成攻击力 × 1.5 的即时伤害',
    manaCost: 15,
    cooldownGroup: 'Cooldown.AbilityLab.Bolt',
  },
  {
    id: 'burn',
    key: '2',
    name: '点燃',
    description: '4 秒周期伤害，可叠加 3 层并刷新持续时间',
    manaCost: 20,
    cooldownGroup: 'Cooldown.AbilityLab.Burn',
  },
  {
    id: 'rage',
    key: '3',
    name: '狂暴',
    description: '攻击力 +4，持续 6 秒，最多叠加 3 层',
    manaCost: 8,
    cooldownGroup: 'Cooldown.AbilityLab.Rage',
  },
  {
    id: 'silence',
    key: '4',
    name: '沉默开关',
    description: '添加或移除 State.Silenced，验证技能标签阻断',
    manaCost: 0,
  },
] as const;

export interface AbilityLabUnitView {
  readonly health: number;
  readonly maximumHealth: number;
  readonly mana?: number;
  readonly maximumMana?: number;
  readonly attack?: number;
  readonly tags: readonly string[];
  readonly effects: readonly {
    readonly id: string;
    readonly stacks: number;
    readonly remainingSeconds?: number;
  }[];
}

export interface AbilityLabViewState {
  readonly caster: AbilityLabUnitView;
  readonly target: AbilityLabUnitView;
  readonly cooldowns: Readonly<Record<Exclude<AbilityLabAction, 'reset'>, number>>;
  readonly logs: readonly string[];
}

const CASTER_MAXIMUM_HEALTH = 100;
const CASTER_MAXIMUM_MANA = 100;
const TARGET_MAXIMUM_HEALTH = 180;

const BOLT_DAMAGE: EffectDefinition = {
  id: 'Effect.AbilityLab.Damage.Bolt',
  lifetime: { kind: 'instant' },
  requirements: { none: ['State.Dead'] },
  modifiers: [{
    attributeId: 'Health',
    operation: 'add',
    magnitude: ({ source }) => -(source?.attributes.getCurrentValue('Attack') ?? 0) * 1.5,
  }],
};

const BURNING: EffectDefinition = {
  id: 'Effect.AbilityLab.Damage.Burning',
  lifetime: { kind: 'timed', seconds: 4 },
  requirements: { none: ['State.Dead'] },
  grantedTags: ['State.Burning'],
  period: { seconds: 1, executeOnApply: true },
  modifiers: [{ attributeId: 'Health', operation: 'add', magnitude: -4 }],
  stacking: { maxStacks: 3, refreshDurationOnApply: true },
};

const RAGE: EffectDefinition = {
  id: 'Effect.AbilityLab.Buff.Rage',
  lifetime: { kind: 'timed', seconds: 6 },
  grantedTags: ['State.Buffed.Rage'],
  modifiers: [{ attributeId: 'Attack', operation: 'add', magnitude: 4 }],
  stacking: { maxStacks: 3, refreshDurationOnApply: true },
};

const SILENCE: EffectDefinition = {
  id: 'Effect.AbilityLab.Debug.Silence',
  lifetime: { kind: 'timed', seconds: 5 },
  grantedTags: ['State.Silenced'],
};

const MANA_REGENERATION: EffectDefinition = {
  id: 'Effect.AbilityLab.Passive.ManaRegeneration',
  lifetime: { kind: 'infinite' },
  period: { seconds: 1 },
  grantedTags: ['State.Regenerating.Mana'],
  modifiers: [{ attributeId: 'Mana', operation: 'add', magnitude: 5 }],
};

const FAILURE_LABELS: Readonly<Record<AbilityActivationFailure, string>> = {
  'unknown-ability': '能力槽位不存在',
  'already-active': '能力已经激活',
  'tag-requirements': '标签条件不满足',
  'blocked-by-ability': '被其他能力阻断',
  'concurrency-blocked': '并发组被占用',
  cooldown: '冷却尚未结束',
  'insufficient-attribute': '法力不足',
  'missing-target': '缺少目标',
  'effect-rejected': '目标拒绝效果',
};

const ACTION_LABELS: Readonly<Record<Exclude<AbilityLabAction, 'reset'>, string>> = {
  arcane: '奥术弹',
  burn: '点燃',
  rage: '狂暴',
  silence: '沉默开关',
};

function attribute(snapshot: AbilitySystemSnapshot, id: string): number {
  return snapshot.attributes.find((item) => item.id === id)?.currentValue ?? 0;
}

/** 纯运行时测试夹具：不依赖 DOM 或 Three.js，可被场景、单测或调试命令共同驱动。 */
export class AbilityLabSimulation {
  private readonly casterActor: Actor;
  private readonly targetActor: Actor;
  private caster?: GameAbilityComponent;
  private target?: GameAbilityComponent;
  private readonly eventDisposers: Array<() => void> = [];
  private readonly listeners = new Set<(event: AbilityLabEvent) => void>();
  private readonly logEntries: string[] = [];
  private elapsedSeconds = 0;

  public constructor(casterActor: Actor, targetActor: Actor) {
    if (casterActor === targetActor) throw new Error('能力实验室的施法者与目标不能是同一个 Actor');
    this.casterActor = casterActor;
    this.targetActor = targetActor;
    this.rebuild();
    this.emit('实验室就绪：法力每秒恢复 5 点', 'info');
  }

  public get casterComponent(): GameAbilityComponent {
    if (!this.caster) throw new Error('AbilityLabSimulation 已释放');
    return this.caster;
  }

  public get targetComponent(): GameAbilityComponent {
    if (!this.target) throw new Error('AbilityLabSimulation 已释放');
    return this.target;
  }

  public activate(action: Exclude<AbilityLabAction, 'reset'>): boolean {
    const target = action === 'arcane' || action === 'burn' ? this.targetComponent : undefined;
    const result = this.casterComponent.activate(action, { target });
    if (!result.ok) {
      this.emit(`${ACTION_LABELS[action]}失败：${FAILURE_LABELS[result.reason]}`, 'warning');
      return false;
    }
    this.emit(`${ACTION_LABELS[action]}激活成功`, 'success');
    this.syncDeathTag();
    return true;
  }

  public reset(): void {
    this.rebuild();
    this.emit('实验室已重置：法力每秒恢复 5 点', 'info');
  }

  public update(deltaSeconds: number): void {
    this.elapsedSeconds += deltaSeconds;
    this.casterComponent.update(deltaSeconds);
    this.targetComponent.update(deltaSeconds);
    this.syncDeathTag();
  }

  public createViewState(): AbilityLabViewState {
    const caster = this.casterComponent.createSnapshot();
    const target = this.targetComponent.createSnapshot();
    return {
      caster: {
        health: attribute(caster, 'Health'),
        maximumHealth: CASTER_MAXIMUM_HEALTH,
        mana: attribute(caster, 'Mana'),
        maximumMana: CASTER_MAXIMUM_MANA,
        attack: attribute(caster, 'Attack'),
        tags: [...caster.looseTags, ...caster.grantedTags],
        effects: caster.effects.map((effect) => ({
          id: effect.effectId,
          stacks: effect.stacks,
          remainingSeconds: effect.remainingSeconds,
        })),
      },
      target: {
        health: attribute(target, 'Health'),
        maximumHealth: TARGET_MAXIMUM_HEALTH,
        tags: [...target.looseTags, ...target.grantedTags],
        effects: target.effects.map((effect) => ({
          id: effect.effectId,
          stacks: effect.stacks,
          remainingSeconds: effect.remainingSeconds,
        })),
      },
      cooldowns: {
        arcane: this.casterComponent.abilitySystem.getCooldownRemaining('Cooldown.AbilityLab.Bolt'),
        burn: this.casterComponent.abilitySystem.getCooldownRemaining('Cooldown.AbilityLab.Burn'),
        rage: this.casterComponent.abilitySystem.getCooldownRemaining('Cooldown.AbilityLab.Rage'),
        silence: 0,
      },
      logs: [...this.logEntries],
    };
  }

  public onEvent(listener: (event: AbilityLabEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    this.clearRuntime();
    this.listeners.clear();
  }

  private rebuild(): void {
    this.clearRuntime();
    this.elapsedSeconds = 0;
    this.logEntries.length = 0;

    const caster = new GameAbilityComponent({
      attributes: [
        { id: 'Health', initialValue: CASTER_MAXIMUM_HEALTH, minimum: 0, maximum: CASTER_MAXIMUM_HEALTH },
        { id: 'Mana', initialValue: CASTER_MAXIMUM_MANA, minimum: 0, maximum: CASTER_MAXIMUM_MANA },
        { id: 'Attack', initialValue: 12, minimum: 0 },
      ],
      abilities: [
        {
          slot: 'arcane',
          ability: {
            id: 'Ability.AbilityLab.Bolt',
            tags: ['Ability.Magic.Projectile'],
            activationRequirements: { none: ['State.Silenced', 'State.Dead'] },
            costs: [{ attributeId: 'Mana', amount: 15 }],
            cooldown: { seconds: 1.5, group: 'Cooldown.AbilityLab.Bolt' },
            effects: [{ effect: BOLT_DAMAGE, target: 'target' }],
          },
        },
        {
          slot: 'burn',
          ability: {
            id: 'Ability.AbilityLab.Burn',
            tags: ['Ability.Magic.Fire'],
            activationRequirements: { none: ['State.Silenced', 'State.Dead'] },
            costs: [{ attributeId: 'Mana', amount: 20 }],
            cooldown: { seconds: 3, group: 'Cooldown.AbilityLab.Burn' },
            effects: [{ effect: BURNING, target: 'target' }],
          },
        },
        {
          slot: 'rage',
          ability: {
            id: 'Ability.AbilityLab.Rage',
            tags: ['Ability.Buff'],
            activationRequirements: { none: ['State.Silenced', 'State.Dead'] },
            costs: [{ attributeId: 'Mana', amount: 8 }],
            cooldown: { seconds: 0.75, group: 'Cooldown.AbilityLab.Rage' },
            effects: [{ effect: RAGE, target: 'owner' }],
          },
        },
        {
          slot: 'silence',
          ability: {
            id: 'Ability.AbilityLab.Debug.Silence',
            tags: ['Ability.Debug'],
            onActivate: ({ system }) => {
              if (system.hasTag('State.Silenced')) system.removeEffectsByTag('State.Silenced');
              else system.applyEffect(SILENCE, { source: system });
            },
          },
        },
      ],
    });
    const target = new GameAbilityComponent({
      attributes: [{
        id: 'Health',
        initialValue: TARGET_MAXIMUM_HEALTH,
        minimum: 0,
        maximum: TARGET_MAXIMUM_HEALTH,
      }],
    });

    this.casterActor.addComponent(caster);
    this.targetActor.addComponent(target);
    caster.abilitySystem.addLooseTag('State.CanCast');
    caster.abilitySystem.applyEffect(MANA_REGENERATION, { source: caster.abilitySystem });
    this.caster = caster;
    this.target = target;
    this.eventDisposers.push(
      caster.subscribe((event) => this.handleEvent('施法者', event)),
      target.subscribe((event) => this.handleEvent('训练假人', event)),
    );
  }

  private clearRuntime(): void {
    for (const dispose of this.eventDisposers.splice(0)) dispose();
    if (this.casterActor.getComponent(GAME_ABILITY_COMPONENT) === this.caster) {
      this.casterActor.removeComponent(GAME_ABILITY_COMPONENT);
    }
    if (this.targetActor.getComponent(GAME_ABILITY_COMPONENT) === this.target) {
      this.targetActor.removeComponent(GAME_ABILITY_COMPONENT);
    }
    this.caster = undefined;
    this.target = undefined;
  }

  private syncDeathTag(): void {
    const target = this.targetComponent.abilitySystem;
    if (target.attributes.getCurrentValue('Health') <= 0) target.addLooseTag('State.Dead');
    else target.removeLooseTag('State.Dead');
  }

  private handleEvent(owner: string, event: AbilitySystemEvent): void {
    if (event.type === 'effect-stacked') {
      this.emit(`${owner}效果叠加：${event.effectId} ×${event.stacks}`, 'success');
    } else if (event.type === 'effect-removed' && event.reason === 'expired') {
      this.emit(`${owner}效果到期：${event.effectId}`, 'info');
    } else if (
      owner === '训练假人'
      && event.type === 'attribute-changed'
      && event.attributeId === 'Health'
      && event.currentValue < event.previousValue
    ) {
      this.emit(`训练假人受到 ${(event.previousValue - event.currentValue).toFixed(0)} 点伤害`, 'damage');
    }
  }

  private emit(message: string, tone: AbilityLabEventTone): void {
    const timestamp = this.elapsedSeconds.toFixed(1).padStart(5, '0');
    const event = { message: `${timestamp}s  ${message}`, tone } as const;
    this.logEntries.unshift(event.message);
    this.logEntries.length = Math.min(this.logEntries.length, 7);
    for (const listener of this.listeners) listener(event);
  }
}

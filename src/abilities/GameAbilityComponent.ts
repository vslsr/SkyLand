import { Actor } from '../../shared/actor/Actor.mjs';
import { ActorComponent } from '../../shared/actor/ActorComponent.mjs';
import { AbilitySystem } from './AbilitySystem';
import type {
  AbilityActivationResult,
  AbilityDefinition,
  AbilityHandle,
  AbilitySystemListener,
  AbilitySystemSnapshot,
  AttributeCalculationBackend,
  AttributeDefinition,
} from './definitions';

export const GAME_ABILITY_COMPONENT = 'game-ability';

export interface GameAbilityGrantDefinition<TPayload = unknown> {
  /** 面向输入、AI 或 UI 的稳定语义槽位，不暴露内部 AbilityHandle。 */
  readonly slot: string;
  readonly ability: AbilityDefinition<TPayload>;
  readonly sourceId?: string;
}

export interface GameAbilityComponentOptions {
  readonly attributes?: readonly AttributeDefinition[];
  readonly abilities?: readonly GameAbilityGrantDefinition[];
  readonly attributeBackend?: AttributeCalculationBackend;
}

export interface GameAbilityActivationOptions<TPayload = unknown> {
  readonly target?: GameAbilityComponent | AbilitySystem;
  readonly payload?: TPayload;
}

/**
 * Actor 与纯 AbilitySystem 之间的薄适配层。
 *
 * Component 只负责 Actor 生命周期、语义槽位和每帧推进；输入、网络、HUD 与表现
 * 都应由外部 Controller/System 消费它的公开 API 或快照。
 */
export class GameAbilityComponent extends ActorComponent {
  private readonly definitions: readonly GameAbilityGrantDefinition[];
  private readonly attributeDefinitions: readonly AttributeDefinition[];
  private readonly attributeBackend?: AttributeCalculationBackend;
  private readonly handlesBySlot = new Map<string, AbilityHandle>();
  private runtime?: AbilitySystem;

  public constructor(options: GameAbilityComponentOptions = {}) {
    super(GAME_ABILITY_COMPONENT);
    this.attributeDefinitions = [...(options.attributes ?? [])];
    this.definitions = [...(options.abilities ?? [])];
    this.attributeBackend = options.attributeBackend;

    const slots = new Set<string>();
    for (const definition of this.definitions) {
      this.assertSlot(definition.slot);
      if (slots.has(definition.slot)) {
        throw new Error(`GameAbilityComponent 能力槽位重复：${definition.slot}`);
      }
      slots.add(definition.slot);
    }
  }

  public get abilitySystem(): AbilitySystem {
    if (!this.runtime) throw new Error('GameAbilityComponent 尚未挂载到 Actor');
    return this.runtime;
  }

  public override onAttach(actor: Actor): void {
    this.runtime = new AbilitySystem({
      ownerId: actor.id,
      attributes: this.attributeDefinitions,
      attributeBackend: this.attributeBackend,
    });
    for (const definition of this.definitions) {
      this.grant(definition.slot, definition.ability, definition.sourceId);
    }
  }

  public override onEndPlay(): void {
    this.endActiveAbilities(true);
  }

  public override onDetach(): void {
    this.endActiveAbilities(true);
    this.handlesBySlot.clear();
    this.runtime = undefined;
  }

  public grant<TPayload = unknown>(
    slot: string,
    ability: AbilityDefinition<TPayload>,
    sourceId?: string,
  ): AbilityHandle {
    this.assertSlot(slot);
    if (this.handlesBySlot.has(slot)) {
      throw new Error(`GameAbilityComponent 能力槽位已存在：${slot}`);
    }
    const handle = this.abilitySystem.grantAbility(ability, sourceId);
    this.handlesBySlot.set(slot, handle);
    return handle;
  }

  public revoke(slot: string): boolean {
    const handle = this.handlesBySlot.get(slot);
    if (!handle) return false;
    this.handlesBySlot.delete(slot);
    return this.abilitySystem.revokeAbility(handle);
  }

  public hasAbility(slot: string): boolean {
    return this.handlesBySlot.has(slot);
  }

  public getAbilityHandle(slot: string): AbilityHandle | undefined {
    return this.handlesBySlot.get(slot);
  }

  public activate<TPayload = unknown>(
    slot: string,
    options: GameAbilityActivationOptions<TPayload> = {},
  ): AbilityActivationResult {
    const handle = this.handlesBySlot.get(slot);
    if (!handle) return { ok: false, reason: 'unknown-ability' };
    const target = options.target instanceof GameAbilityComponent
      ? options.target.abilitySystem
      : options.target;
    return this.abilitySystem.activateAbility(handle, { target, payload: options.payload });
  }

  public update(deltaSeconds: number): void {
    this.abilitySystem.update(deltaSeconds);
  }

  public subscribe(listener: AbilitySystemListener): () => void {
    return this.abilitySystem.subscribe(listener);
  }

  public createSnapshot(): AbilitySystemSnapshot {
    return this.abilitySystem.createSnapshot();
  }

  private endActiveAbilities(cancelled: boolean): void {
    if (!this.runtime) return;
    for (const ability of this.runtime.createSnapshot().abilities) {
      if (ability.active) this.runtime.endAbility(ability.handle, cancelled);
    }
  }

  private assertSlot(slot: string): void {
    if (!slot.trim()) throw new TypeError('GameAbilityComponent 能力槽位不能为空');
  }
}

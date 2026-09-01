import { ActorComponent } from '../actor/ActorComponent.mjs';
import { AbilitySystem } from './runtime.mjs';

export const GAME_ABILITY_COMPONENT = 'game-ability';

/** Node 房间进程使用的 GAS Actor 适配层；核心数值逻辑来自共享编译运行时。 */
export class GameAbilityComponent extends ActorComponent {
  constructor(options = {}) {
    super(GAME_ABILITY_COMPONENT);
    this.attributeDefinitions = [...(options.attributes ?? [])];
    this.definitions = [...(options.abilities ?? [])];
    this.handlesBySlot = new Map();
    this.runtime = undefined;

    const slots = new Set();
    for (const definition of this.definitions) {
      this.assertSlot(definition.slot);
      if (slots.has(definition.slot)) {
        throw new Error(`GameAbilityComponent 能力槽位重复：${definition.slot}`);
      }
      slots.add(definition.slot);
    }
  }

  get abilitySystem() {
    if (!this.runtime) throw new Error('GameAbilityComponent 尚未挂载到 Actor');
    return this.runtime;
  }

  onAttach(actor) {
    this.runtime = new AbilitySystem({
      ownerId: actor.id,
      attributes: this.attributeDefinitions,
    });
    for (const definition of this.definitions) {
      this.grant(definition.slot, definition.ability, definition.sourceId);
    }
  }

  onEndPlay() {
    this.endActiveAbilities(true);
  }

  onDetach() {
    this.endActiveAbilities(true);
    this.handlesBySlot.clear();
    this.runtime = undefined;
  }

  grant(slot, ability, sourceId) {
    this.assertSlot(slot);
    if (this.handlesBySlot.has(slot)) {
      throw new Error(`GameAbilityComponent 能力槽位已存在：${slot}`);
    }
    const handle = this.abilitySystem.grantAbility(ability, sourceId);
    this.handlesBySlot.set(slot, handle);
    return handle;
  }

  revoke(slot) {
    const handle = this.handlesBySlot.get(slot);
    if (!handle) return false;
    this.handlesBySlot.delete(slot);
    return this.abilitySystem.revokeAbility(handle);
  }

  hasAbility(slot) {
    return this.handlesBySlot.has(slot);
  }

  getAbilityHandle(slot) {
    return this.handlesBySlot.get(slot);
  }

  activate(slot, options = {}) {
    const handle = this.handlesBySlot.get(slot);
    if (!handle) return { ok: false, reason: 'unknown-ability' };
    const target = options.target instanceof GameAbilityComponent
      ? options.target.abilitySystem
      : options.target;
    return this.abilitySystem.activateAbility(handle, { target, payload: options.payload });
  }

  update(deltaSeconds) {
    this.abilitySystem.update(deltaSeconds);
  }

  subscribe(listener) {
    return this.abilitySystem.subscribe(listener);
  }

  createSnapshot() {
    return this.abilitySystem.createSnapshot();
  }

  endActiveAbilities(cancelled) {
    if (!this.runtime) return;
    for (const ability of this.runtime.createSnapshot().abilities) {
      if (ability.active) this.runtime.endAbility(ability.handle, cancelled);
    }
  }

  assertSlot(slot) {
    if (typeof slot !== 'string' || !slot.trim()) {
      throw new TypeError('GameAbilityComponent 能力槽位不能为空');
    }
  }
}

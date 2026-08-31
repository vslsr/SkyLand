import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from '../shared/actor/Actor.mjs';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import {
  GAME_ABILITY_COMPONENT,
  GameAbilityComponent,
  GameAbilitySystem,
  type AbilitySystemEvent,
} from '../src/abilities/index.ts';

test('GameAbilityComponent 使用 Actor id 建立运行时并通过稳定槽位激活能力', () => {
  const caster = new Actor('caster-01', 'mage');
  const target = new Actor('dummy-01', 'dummy');
  const casterAbilities = new GameAbilityComponent({
    attributes: [{ id: 'Mana', initialValue: 30, minimum: 0, maximum: 30 }],
    abilities: [{
      slot: 'primary',
      ability: {
        id: 'Ability.Test.Primary',
        costs: [{ attributeId: 'Mana', amount: 10 }],
        effects: [{
          target: 'target',
          effect: {
            id: 'Effect.Test.Damage',
            lifetime: { kind: 'instant' },
            modifiers: [{ attributeId: 'Health', operation: 'add', magnitude: -12 }],
          },
        }],
      },
    }],
  });
  const targetAbilities = new GameAbilityComponent({
    attributes: [{ id: 'Health', initialValue: 50, minimum: 0, maximum: 50 }],
  });

  caster.addComponent(casterAbilities);
  target.addComponent(targetAbilities);
  assert.equal(casterAbilities.abilitySystem.ownerId, caster.id);
  assert.equal(casterAbilities.hasAbility('primary'), true);
  assert.equal(casterAbilities.activate('primary', { target: targetAbilities }).ok, true);
  assert.equal(casterAbilities.abilitySystem.attributes.getCurrentValue('Mana'), 20);
  assert.equal(targetAbilities.abilitySystem.attributes.getCurrentValue('Health'), 38);

  assert.throws(() => new GameAbilityComponent({
    abilities: [
      { slot: 'same', ability: { id: 'Ability.One' } },
      { slot: 'same', ability: { id: 'Ability.Two' } },
    ],
  }), /槽位重复/);
  caster.dispose();
  target.dispose();
});

test('GameAbilitySystem 用 ActorWorld tick 推进冷却，卸载 Component 会取消活跃能力', () => {
  const world = new ActorWorld();
  world.addSystem(new GameAbilitySystem());
  const actor = new Actor('caster-02', 'mage');
  const component = new GameAbilityComponent({
    abilities: [
      {
        slot: 'cooldown',
        ability: { id: 'Ability.Test.Cooldown', cooldown: { seconds: 2 } },
      },
      {
        slot: 'channel',
        ability: {
          id: 'Ability.Test.Channel',
          lifecycle: 'active',
          ownedTags: ['State.Channeling'],
        },
      },
    ],
  });
  actor.addComponent(component);
  world.addActor(actor);

  assert.equal(component.activate('cooldown').ok, true);
  assert.deepEqual(component.activate('cooldown'), { ok: false, reason: 'cooldown' });
  world.update(2, 2);
  assert.equal(component.activate('cooldown').ok, true);

  const events: AbilitySystemEvent[] = [];
  component.subscribe((event) => events.push(event));
  assert.equal(component.activate('channel').ok, true);
  assert.equal(component.abilitySystem.hasTag('State.Channeling'), true);
  assert.equal(actor.removeComponent(GAME_ABILITY_COMPONENT), true);
  assert.ok(events.some((event) => (
    event.type === 'ability-ended'
    && event.abilityId === 'Ability.Test.Channel'
    && event.cancelled
  )));
  world.dispose();
});

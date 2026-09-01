import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from '../shared/actor/Actor.mjs';
import { ActorComponent } from '../shared/actor/ActorComponent.mjs';
import {
  GAME_ABILITY_COMPONENT,
  GameAbilityComponent,
} from '../src/abilities/index.ts';
import { AbilityLabSimulation } from '../src/abilities/lab/AbilityLabSimulation.ts';

test('能力实验室覆盖消耗、冷却、标签阻断、周期效果与重置', () => {
  const caster = new Actor('ability-lab-caster', 'player-slime');
  const target = new Actor('training-dummy-01', 'training-dummy');
  const targetSentinel = target.addComponent(new ActorComponent('test-sentinel'));
  const lab = new AbilityLabSimulation(caster, target);
  assert.deepEqual(
    {
      mana: lab.createViewState().caster.mana,
      attack: lab.createViewState().caster.attack,
      health: lab.createViewState().target.health,
    },
    { mana: 100, attack: 12, health: 180 },
  );

  assert.equal(lab.activate('rage'), true);
  assert.equal(lab.activate('arcane'), true);
  let view = lab.createViewState();
  assert.equal(view.caster.mana, 77);
  assert.equal(view.caster.attack, 16);
  assert.equal(view.target.health, 156);
  assert.ok(view.cooldowns.arcane > 0);

  assert.equal(lab.activate('silence'), true);
  assert.equal(lab.activate('burn'), false);
  view = lab.createViewState();
  assert.ok(view.caster.tags.includes('State.Silenced'));
  assert.equal(view.target.effects.some((effect) => effect.id.endsWith('.Burning')), false);
  assert.equal(view.caster.mana, 77);

  assert.equal(lab.activate('silence'), true);
  assert.equal(lab.activate('burn'), true);
  view = lab.createViewState();
  assert.equal(view.target.effects.find((effect) => effect.id.endsWith('.Burning'))?.stacks, 1);
  assert.equal(view.target.health, 152);
  assert.equal(view.caster.mana, 57);

  lab.update(1);
  view = lab.createViewState();
  assert.equal(view.target.health, 148);
  assert.equal(view.caster.mana, 62);

  lab.reset();
  view = lab.createViewState();
  assert.deepEqual(
    {
      mana: view.caster.mana,
      attack: view.caster.attack,
      health: view.target.health,
      tags: view.caster.tags.filter((tag) => tag === 'State.Silenced'),
      targetEffects: view.target.effects,
    },
    {
      mana: 100,
      attack: 12,
      health: 180,
      tags: [],
      targetEffects: [],
    },
  );
  lab.dispose();
  assert.equal(target.getComponent('game-ability'), undefined);
  assert.equal(target.getComponent('test-sentinel'), targetSentinel);
  caster.dispose();
  target.dispose();
});

test('能力实验室不会重复挂载或清理玩家已有的能力 Component', () => {
  const caster = new Actor('player-with-abilities', 'player-slime');
  const existing = caster.addComponent(new GameAbilityComponent({
    attributes: [{ id: 'MoveSpeed', initialValue: 5, minimum: 0 }],
    abilities: [{ slot: 'movement', ability: { id: 'Ability.Player.Movement' } }],
  })) as GameAbilityComponent;
  const target = new Actor('training-dummy-existing-caster', 'training-dummy');

  const lab = new AbilityLabSimulation(caster, target);
  assert.equal(caster.getComponent(GAME_ABILITY_COMPONENT), existing);
  assert.equal(existing.hasAbility('movement'), true);
  assert.equal(existing.abilitySystem.attributes.getCurrentValue('MoveSpeed'), 5);

  lab.reset();
  lab.dispose();

  assert.equal(caster.getComponent(GAME_ABILITY_COMPONENT), existing);
  assert.equal(existing.hasAbility('movement'), true);
  assert.equal(target.getComponent(GAME_ABILITY_COMPONENT), undefined);
  caster.dispose();
  target.dispose();
});

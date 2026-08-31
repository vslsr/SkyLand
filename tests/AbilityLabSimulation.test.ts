import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from '../shared/actor/Actor.mjs';
import { AbilityLabSimulation } from '../src/abilities/lab/AbilityLabSimulation.ts';

test('能力实验室覆盖消耗、冷却、标签阻断、周期效果与重置', () => {
  const caster = new Actor('ability-lab-caster', 'player-slime');
  const lab = new AbilityLabSimulation(caster);
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
  caster.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AbilitySystem,
  grantAbilityLoadout,
  type AbilitySystemEvent,
  type EffectDefinition,
} from '../src/abilities/index.ts';

function createCombatant(ownerId: string): AbilitySystem {
  return new AbilitySystem({
    ownerId,
    attributes: [
      { id: 'Health', initialValue: 100, minimum: 0, maximum: 100 },
      { id: 'Mana', initialValue: 50, minimum: 0, maximum: 50 },
      { id: 'Attack', initialValue: 10, minimum: 0 },
    ],
  });
}

test('Instant Effect 修改 BaseValue，并按属性边界 Clamp', () => {
  const target = createCombatant('target');
  const events: AbilitySystemEvent[] = [];
  target.subscribe((event) => events.push(event));

  assert.deepEqual(target.applyEffect({
    id: 'Effect.Damage.Basic',
    lifetime: { kind: 'instant' },
    modifiers: [{ attributeId: 'Health', operation: 'add', magnitude: -25 }],
  }), { ok: true });
  assert.equal(target.attributes.getBaseValue('Health'), 75);
  assert.equal(target.attributes.getCurrentValue('Health'), 75);

  target.applyEffect({
    id: 'Effect.Damage.Fatal',
    lifetime: { kind: 'instant' },
    modifiers: [{ attributeId: 'Health', operation: 'add', magnitude: -500 }],
  });
  assert.equal(target.attributes.getBaseValue('Health'), 0);
  assert.ok(events.some((event) => (
    event.type === 'attribute-changed'
    && event.attributeId === 'Health'
    && event.currentValue === 0
  )));
});

test('Duration Effect 临时修改 CurrentValue，过期后自动还原', () => {
  const system = createCombatant('hero');
  const result = system.applyEffect({
    id: 'Effect.Buff.Attack',
    lifetime: { kind: 'timed', seconds: 3 },
    grantedTags: ['State.Buffed.Attack'],
    modifiers: [{ attributeId: 'Attack', operation: 'multiply', magnitude: 1.5 }],
  });

  assert.equal(result.ok, true);
  assert.equal(system.attributes.getBaseValue('Attack'), 10);
  assert.equal(system.attributes.getCurrentValue('Attack'), 15);
  assert.equal(system.hasTag('State.Buffed'), true);

  system.update(2.999);
  assert.equal(system.attributes.getCurrentValue('Attack'), 15);
  system.update(0.001);
  assert.equal(system.attributes.getCurrentValue('Attack'), 10);
  assert.equal(system.hasTag('State.Buffed.Attack'), false);
});

test('多个来源授予同一标签时使用引用计数', () => {
  const system = createCombatant('hero');
  const shield: EffectDefinition = {
    id: 'Effect.Shield',
    lifetime: { kind: 'infinite' },
    grantedTags: ['State.Protected'],
  };
  const first = system.applyEffect(shield);
  const second = system.applyEffect(shield);
  assert.equal(system.hasTag('State.Protected'), true);

  assert.ok(first.ok && first.handle);
  assert.ok(second.ok && second.handle);
  system.removeEffect(first.handle);
  assert.equal(system.hasTag('State.Protected'), true);
  system.removeEffect(second.handle);
  assert.equal(system.hasTag('State.Protected'), false);
});

test('Periodic Effect 按时间结算，并限制在生命周期内', () => {
  const system = createCombatant('hero');
  system.applyEffect({
    id: 'Effect.Damage.Burning',
    lifetime: { kind: 'timed', seconds: 3 },
    period: { seconds: 1, executeOnApply: true },
    grantedTags: ['State.Burning'],
    modifiers: [{ attributeId: 'Health', operation: 'add', magnitude: -10 }],
  });

  assert.equal(system.attributes.getCurrentValue('Health'), 90);
  system.update(0.9);
  assert.equal(system.attributes.getCurrentValue('Health'), 90);
  system.update(0.1);
  assert.equal(system.attributes.getCurrentValue('Health'), 80);
  system.update(2);
  assert.equal(system.attributes.getCurrentValue('Health'), 60);
  assert.equal(system.hasTag('State.Burning'), false);
});

test('Effect Stacking 聚合各层 Modifier，并支持持续时间刷新', () => {
  const system = createCombatant('hero');
  const rage: EffectDefinition = {
    id: 'Effect.Buff.Rage',
    lifetime: { kind: 'timed', seconds: 2 },
    modifiers: [{ attributeId: 'Attack', operation: 'add', magnitude: 5 }],
    stacking: { maxStacks: 3, refreshDurationOnApply: true },
  };

  const first = system.applyEffect(rage);
  system.applyEffect(rage);
  system.applyEffect(rage);
  system.applyEffect(rage);
  assert.equal(system.attributes.getCurrentValue('Attack'), 25);
  assert.equal(system.createSnapshot().effects[0]?.stacks, 3);

  system.update(1.9);
  assert.equal(system.attributes.getCurrentValue('Attack'), 25);
  system.applyEffect(rage);
  system.update(1.9);
  assert.equal(system.attributes.getCurrentValue('Attack'), 25);
  assert.ok(first.ok && first.handle);
  system.removeEffect(first.handle);
  assert.equal(system.attributes.getCurrentValue('Attack'), 10);
});

test('Ability 原子检查标签、目标、消耗和共享冷却', () => {
  const caster = createCombatant('caster');
  const target = createCombatant('target');
  const damage: EffectDefinition = {
    id: 'Effect.Damage.Fireball',
    lifetime: { kind: 'instant' },
    modifiers: [{
      attributeId: 'Health',
      operation: 'add',
      magnitude: ({ source }) => -(source?.attributes.getCurrentValue('Attack') ?? 0) * 2,
    }],
  };
  const handle = caster.grantAbility({
    id: 'Ability.Magic.Fireball',
    tags: ['Ability.Magic.Fire'],
    activationRequirements: { all: ['State.CanCast'], none: ['State.Silenced'] },
    costs: [{ attributeId: 'Mana', amount: 10 }],
    cooldown: { seconds: 2, group: 'Cooldown.Magic.Primary' },
    effects: [{ effect: damage, target: 'target' }],
  });

  assert.deepEqual(caster.activateAbility(handle, { target }), {
    ok: false,
    reason: 'tag-requirements',
  });
  caster.addLooseTag('State.CanCast');
  assert.deepEqual(caster.activateAbility(handle, { target }), { ok: true, handle });
  assert.equal(caster.attributes.getCurrentValue('Mana'), 40);
  assert.equal(target.attributes.getCurrentValue('Health'), 80);
  assert.deepEqual(caster.activateAbility(handle, { target }), { ok: false, reason: 'cooldown' });

  caster.update(2);
  assert.deepEqual(caster.activateAbility(handle, { target }), { ok: true, handle });
  assert.equal(caster.attributes.getCurrentValue('Mana'), 30);
  assert.equal(target.attributes.getCurrentValue('Health'), 60);
});

test('Ability 预检查会预测 OwnedTags，失败时不扣消耗也不启动冷却', () => {
  const system = createCombatant('hero');
  const rejected = system.grantAbility({
    id: 'Ability.Channel.Rejected',
    ownedTags: ['State.Channeling'],
    costs: [{ attributeId: 'Mana', amount: 10 }],
    cooldown: { seconds: 5 },
    effects: [{
      target: 'owner',
      effect: {
        id: 'Effect.Channel.Rejected',
        lifetime: { kind: 'timed', seconds: 1 },
        requirements: { none: ['State.Channeling'] },
      },
    }],
  });
  assert.deepEqual(system.activateAbility(rejected), { ok: false, reason: 'effect-rejected' });
  assert.equal(system.attributes.getCurrentValue('Mana'), 50);
  assert.equal(system.getCooldownRemaining('Ability.Channel.Rejected'), 0);
  assert.equal(system.hasTag('State.Channeling'), false);

  const accepted = system.grantAbility({
    id: 'Ability.Channel.Accepted',
    ownedTags: ['State.Channeling'],
    effects: [{
      target: 'owner',
      effect: {
        id: 'Effect.Channel.Accepted',
        lifetime: { kind: 'timed', seconds: 1 },
        requirements: { all: ['State.Channeling'] },
        grantedTags: ['State.ChannelConfirmed'],
      },
    }],
  });
  assert.equal(system.activateAbility(accepted).ok, true);
  assert.equal(system.hasTag('State.ChannelConfirmed'), true);
});

test('Ability 标签关系和并发组可以阻塞或取消活跃能力', () => {
  const system = createCombatant('hero');
  const channel = system.grantAbility({
    id: 'Ability.Magic.Channel',
    tags: ['Ability.Magic.Channel'],
    ownedTags: ['State.Casting'],
    lifecycle: 'active',
    concurrency: 'replaceable',
    concurrencyGroup: 'Action',
  });
  const stun = system.grantAbility({
    id: 'Ability.Control.Stun',
    tags: ['Ability.Control.Stun'],
    lifecycle: 'active',
    concurrency: 'blocking',
    concurrencyGroup: 'Action',
    blockAbilitiesWithTags: ['Ability.Magic'],
  });
  const fire = system.grantAbility({
    id: 'Ability.Magic.Fire',
    tags: ['Ability.Magic.Fire'],
  });

  assert.equal(system.activateAbility(channel).ok, true);
  assert.equal(system.hasTag('State.Casting'), true);
  assert.equal(system.activateAbility(stun).ok, true);
  assert.equal(system.hasTag('State.Casting'), false);
  assert.deepEqual(system.activateAbility(channel), { ok: false, reason: 'blocked-by-ability' });
  assert.deepEqual(system.activateAbility(fire), { ok: false, reason: 'blocked-by-ability' });
  system.endAbility(stun);
  assert.equal(system.activateAbility(fire).ok, true);
});

test('AbilityLoadout 成组授予和回收能力与持续效果', () => {
  const system = createCombatant('hero');
  const loadout = grantAbilityLoadout(system, {
    id: 'Loadout.Sword',
    abilities: [{ id: 'Ability.Weapon.Slash' }],
    startupEffects: [{
      id: 'Effect.Weapon.Sword',
      lifetime: { kind: 'infinite' },
      modifiers: [{ attributeId: 'Attack', operation: 'add', magnitude: 7 }],
      grantedTags: ['Equipment.Weapon.Sword'],
    }],
  });

  assert.equal(system.findAbilityHandles('Ability.Weapon.Slash').length, 1);
  assert.equal(system.attributes.getCurrentValue('Attack'), 17);
  assert.equal(system.hasTag('Equipment.Weapon'), true);
  assert.equal(loadout.revoke(), true);
  assert.equal(loadout.revoke(), false);
  assert.equal(system.findAbilityHandles('Ability.Weapon.Slash').length, 0);
  assert.equal(system.attributes.getCurrentValue('Attack'), 10);
  assert.equal(system.hasTag('Equipment.Weapon.Sword'), false);
});

test('Snapshot 只包含可序列化运行时状态', () => {
  const system = createCombatant('hero');
  system.addLooseTag('Team.Player');
  const handle = system.grantAbility({
    id: 'Ability.Dash',
    cooldown: { seconds: 1 },
  }, 'Loadout.Default');
  system.activateAbility(handle);
  const effect = system.applyEffect({
    id: 'Effect.Speed',
    lifetime: { kind: 'timed', seconds: 5 },
    grantedTags: ['State.Fast'],
  });
  assert.equal(effect.ok, true);

  const snapshot = system.createSnapshot();
  assert.equal(snapshot.ownerId, 'hero');
  assert.deepEqual(snapshot.looseTags, ['Team.Player']);
  assert.deepEqual(snapshot.grantedTags, ['State.Fast']);
  assert.equal(snapshot.abilities[0]?.abilityId, 'Ability.Dash');
  assert.equal(snapshot.effects[0]?.remainingSeconds, 5);
  assert.equal(snapshot.cooldowns['Ability.Dash'], 1);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

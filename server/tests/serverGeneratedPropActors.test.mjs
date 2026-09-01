import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorWorld, GENERATED_PROP_COMPONENT } from '../../shared/actor/index.mjs';
import { ServerGeneratedPropActors } from '../actors/ServerGeneratedPropActors.mjs';
import { parseGeneratedPropId } from '../../shared/world/generatedProp.mjs';
import { CHUNK_SIZE, PROP_KIND } from '../../shared/world/worldConfig.mjs';

const SEED = 0x5c1a2d0b;

/** 只带生成物件所需的那几个 Component，不引入渲染与碰撞。 */
function archetypeFor(id, kind, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    components: {
      interactable: { action: 'harvest-prop', label: id, maximumDistance: 2.6 },
      generatedProp: {
        kind,
        maximumHealth: 3,
        harvestDamage: 1,
        drop: { archetypeId: 'wood-pile', quantity: 5 },
      },
      replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
      ...overrides,
    },
  };
}

function createManager(archetypes, options = {}) {
  const world = new ActorWorld();
  const props = new ServerGeneratedPropActors({
    world,
    archetypes,
    worldSeed: SEED,
    ...options,
  });
  return { world, props };
}

function kindsOf(world) {
  const counts = new Map();
  for (const actor of world.query(GENERATED_PROP_COMPONENT)) {
    const kind = actor.requireComponent(GENERATED_PROP_COMPONENT).kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

test('注册表按 kind 建立，没有登记的种类不产生 Actor', () => {
  const { world, props } = createManager([archetypeFor('generated-tree', 'tree')]);
  props.ensureAround(0, 0);

  const counts = kindsOf(world);
  assert.ok((counts.get(PROP_KIND.TREE) ?? 0) > 0, '树应该有 Actor');
  assert.equal(counts.get(PROP_KIND.ROCK), undefined, '石头没有原型，不应该产生 Actor');
  assert.equal(counts.get(PROP_KIND.GRASS), undefined, '草没有原型，不应该产生 Actor');
  assert.equal(props.archetypeForKind(PROP_KIND.TREE).id, 'generated-tree');
  assert.equal(props.archetypeForKind(PROP_KIND.ROCK), undefined);
});

test('登记第二种物件后，同一批 chunk 里两种都变成 Actor', () => {
  const single = createManager([archetypeFor('generated-tree', 'tree')]);
  single.props.ensureAround(0, 0);
  const treeOnly = kindsOf(single.world);

  const both = createManager([
    archetypeFor('generated-tree', 'tree'),
    archetypeFor('generated-rock', 'rock'),
  ]);
  both.props.ensureAround(0, 0);
  const withRock = kindsOf(both.world);

  // 树的数量一个不多一个不少：加一种物件不会改变别的种类的派生结果。
  assert.equal(withRock.get(PROP_KIND.TREE), treeOnly.get(PROP_KIND.TREE));
  assert.ok((withRock.get(PROP_KIND.ROCK) ?? 0) > 0, '石头现在应该有 Actor');
  assert.equal(
    both.props.residentActorCount,
    withRock.get(PROP_KIND.TREE) + withRock.get(PROP_KIND.ROCK),
  );

  // 每个 Actor 的 id、原型与 Component 里的种类三者一致。
  for (const actor of both.world.query(GENERATED_PROP_COMPONENT)) {
    const prop = actor.requireComponent(GENERATED_PROP_COMPONENT);
    assert.equal(parseGeneratedPropId(actor.id).kind, prop.kind);
    assert.equal(actor.archetypeId, both.props.archetypeForKind(prop.kind).id);
  }
});

test('没有任何生成物件原型时整个机制关闭', () => {
  const { world, props } = createManager([]);
  props.ensureAround(0, 0);
  props.sync([{ x: 0, z: 0 }]);
  assert.equal(props.enabled, false);
  assert.equal(props.residentChunkCount, 0);
  assert.equal(world.size, 0);
});

test('常驻半径取所有已登记原型里最大的复制半径', () => {
  const wide = archetypeFor('generated-rock', 'rock');
  wide.components.replicationPolicy = { mode: 'aoi', radiusChunks: 5 };
  const { props } = createManager([archetypeFor('generated-tree', 'tree'), wide]);
  assert.equal(props.residentRadius, 5);
  assert.equal(props.keepRadius, 6);
});

test('偏离态按 id 保存，跨种类互不干扰', () => {
  const { world, props } = createManager([
    archetypeFor('generated-tree', 'tree'),
    archetypeFor('generated-rock', 'rock'),
  ]);
  props.ensureAround(0, 0);

  const tree = world.query(GENERATED_PROP_COMPONENT).find((actor) => (
    actor.requireComponent(GENERATED_PROP_COMPONENT).kind === PROP_KIND.TREE
  ));
  const rock = world.query(GENERATED_PROP_COMPONENT).find((actor) => (
    actor.requireComponent(GENERATED_PROP_COMPONENT).kind === PROP_KIND.ROCK
  ));
  assert.ok(tree && rock);

  tree.requireComponent(GENERATED_PROP_COMPONENT).applyDamage();
  props.recordDeviation(tree);
  assert.equal(props.deviationCount, 1);

  // 走远：两种物件一起卸载，只有被动过的那一个留下记录。
  props.sync([{ x: CHUNK_SIZE * 12, z: CHUNK_SIZE * 12 }]);
  assert.equal(world.getActor(tree.id), undefined);
  assert.equal(world.getActor(rock.id), undefined);
  assert.equal(props.deviationCount, 1);

  props.sync([{ x: 0, z: 0 }]);
  assert.equal(
    world.getActor(tree.id).requireComponent(GENERATED_PROP_COMPONENT).health,
    2,
    '树带着伤回来',
  );
  assert.equal(
    world.getActor(rock.id).requireComponent(GENERATED_PROP_COMPONENT).health,
    3,
    '没被动过的石头是满血',
  );
});

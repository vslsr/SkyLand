import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActorWorld,
  DROP_MOTION_COMPONENT,
  ELASTIC_DETACH_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  GENERATED_PROP_COMPONENT,
  REPLICATED_COMPONENT,
} from '../../shared/actor/index.mjs';
import { ServerGeneratedPropActors } from '../actors/ServerGeneratedPropActors.mjs';
import { parseGeneratedPropId } from '../../shared/world/generatedProp.mjs';
import { CHUNK_SIZE, PROP_KIND } from '../../shared/world/worldConfig.mjs';

const SEED = 0x5c1a2d0b;

/** 只带生成物件所需的那几个 Component，不引入渲染与碰撞。 */
function archetypeFor(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    components: {
      interactable: { action: 'harvest-prop', label: id, maximumDistance: 2.6 },
      generatedProp: {
        maximumHealth: 3,
        harvestDamage: 1,
        drop: { archetypeId: 'wood-pile', quantity: 5 },
      },
      replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
      ...overrides,
    },
  };
}

function elasticArchetypeFor(id) {
  return {
    schemaVersion: 1,
    id,
    components: {
      interactable: { action: 'mushroom-bite', label: id, maximumDistance: 1.35 },
      elasticTether: {
        restLength: 0.72,
        breakLength: 2.65,
        mouthHeight: 0.3,
        mouthForwardOffset: 0.36,
      },
      elasticDetach: {},
      dropMotion: {
        gravity: 9.8,
        drag: 1.8,
        groundDrag: 7,
        restitution: 0.28,
        radius: 0.28,
        settleSpeed: 0.1,
      },
      replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
    },
  };
}

const variants = (...entries) => entries.map(([archetypeId, weight = 1]) => ({ archetypeId, weight }));

/** @param {Record<string, Array<{ archetypeId: string, weight: number }>>} worldProps */
function createManager(archetypes, worldProps, options = {}) {
  const world = new ActorWorld();
  const props = new ServerGeneratedPropActors({
    world,
    archetypes,
    worldProps,
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
  const { world, props } = createManager(
    [archetypeFor('generated-tree')],
    { tree: variants(['generated-tree']) },
  );
  props.ensureAround(0, 0);

  const counts = kindsOf(world);
  assert.ok((counts.get(PROP_KIND.TREE) ?? 0) > 0, '树应该有 Actor');
  assert.equal(counts.get(PROP_KIND.ROCK), undefined, '石头没有原型，不应该产生 Actor');
  assert.equal(counts.get(PROP_KIND.GRASS), undefined, '草没有原型，不应该产生 Actor');
  assert.equal(props.archetypeForKind(PROP_KIND.TREE).id, 'generated-tree');
  assert.equal(props.archetypeForKind(PROP_KIND.ROCK), undefined);
});

test('登记第二种物件后，同一批 chunk 里两种都变成 Actor', () => {
  const single = createManager(
    [archetypeFor('generated-tree')],
    { tree: variants(['generated-tree']) },
  );
  single.props.ensureAround(0, 0);
  const treeOnly = kindsOf(single.world);

  const both = createManager(
    [archetypeFor('generated-tree'), archetypeFor('generated-rock')],
    { tree: variants(['generated-tree']), rock: variants(['generated-rock']) },
  );
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
    const identity = parseGeneratedPropId(actor.id);
    assert.equal(identity.kind, prop.kind);
    assert.equal(
      actor.archetypeId,
      both.props.archetypeForProp(
        identity.kind,
        identity.chunkX,
        identity.chunkZ,
        identity.propIndex,
      ).id,
    );
  }
});

test('蘑菇放置记录生成完整复制的弹性 Actor，而不是本地派生采集物', () => {
  const { world, props } = createManager(
    [elasticArchetypeFor('elastic-mushroom')],
    { mushroom: variants(['elastic-mushroom']) },
  );
  props.ensureAround(0, 0);

  const mushrooms = world.query(ELASTIC_TETHER_COMPONENT);
  assert.ok(mushrooms.length > 0);
  assert.equal(props.residentActorCount, mushrooms.length);
  for (const actor of mushrooms) {
    assert.equal(parseGeneratedPropId(actor.id).kind, PROP_KIND.MUSHROOM);
    assert.equal(actor.archetypeId, 'elastic-mushroom');
    assert.equal(actor.hasComponents(GENERATED_PROP_COMPONENT), false);
    assert.equal(actor.hasComponents(REPLICATED_COMPONENT), true);
  }
});

test('脱离的流式蘑菇跨 chunk 卸载重载后保持落点与脱离状态', () => {
  const { world, props } = createManager(
    [elasticArchetypeFor('elastic-mushroom')],
    { mushroom: variants(['elastic-mushroom']) },
  );
  props.ensureAround(0, 0);
  const mushroom = world.query(ELASTIC_TETHER_COMPONENT)[0];
  assert.ok(mushroom);
  const id = mushroom.id;
  const identity = parseGeneratedPropId(id);
  const transform = mushroom.requireComponent('transform');
  transform.setWorldTransform([transform.x + 1.25, transform.y + 0.2, transform.z - 0.75]);
  mushroom.requireComponent(ELASTIC_DETACH_COMPONENT).markDetached();
  const motion = mushroom.requireComponent(DROP_MOTION_COMPONENT);
  motion.velocityX = 0.4;
  motion.velocityY = -0.2;

  props.sync([{ x: CHUNK_SIZE * 20, z: CHUNK_SIZE * 20 }]);
  assert.equal(world.getActor(id), undefined);
  props.ensureAround(identity.chunkX * CHUNK_SIZE, identity.chunkZ * CHUNK_SIZE);
  const restored = world.getActor(id);
  assert.ok(restored);
  assert.equal(restored.requireComponent(ELASTIC_DETACH_COMPONENT).detached, true);
  assert.equal(restored.requireComponent('interactable').enabled, false);
  assert.equal(restored.requireComponent('transform').x, transform.x);
  assert.equal(restored.requireComponent(DROP_MOTION_COMPONENT).velocityX, 0.4);
});

test('同一种树按世界种子和权重稳定混合多个原型', () => {
  const ordinary = archetypeFor('ordinary-tree');
  const fruit = archetypeFor('fruit-tree');
  fruit.components.generatedProp = {
    regrow: { seconds: 120 },
    drop: { archetypeId: 'fruit-pile', quantity: 3 },
  };
  const worldProps = {
    tree: variants(['ordinary-tree', 5], ['fruit-tree', 1]),
  };
  const first = createManager([ordinary, fruit], worldProps);
  const second = createManager([ordinary, fruit], worldProps);
  first.props.ensureAround(0, 0);
  second.props.ensureAround(0, 0);

  const signature = (world) => world.query(GENERATED_PROP_COMPONENT)
    .map((actor) => `${actor.id}:${actor.archetypeId}`)
    .sort();
  assert.deepEqual(signature(first.world), signature(second.world));
  const ids = first.world.query(GENERATED_PROP_COMPONENT).map((actor) => actor.archetypeId);
  assert.ok(ids.includes('ordinary-tree'));
  assert.ok(ids.includes('fruit-tree'));
  assert.ok(
    ids.filter((id) => id === 'ordinary-tree').length
      > ids.filter((id) => id === 'fruit-tree').length,
    '5:1 的普通树应明显多于果树',
  );
});

test('没有任何生成物件原型时整个机制关闭', () => {
  const { world, props } = createManager([], {});
  props.ensureAround(0, 0);
  props.sync([{ x: 0, z: 0 }]);
  assert.equal(props.enabled, false);
  assert.equal(props.residentChunkCount, 0);
  assert.equal(world.size, 0);
});

test('常驻半径取所有已登记原型里最大的复制半径', () => {
  const wide = archetypeFor('generated-rock');
  wide.components.replicationPolicy = { mode: 'aoi', radiusChunks: 5 };
  const { props } = createManager(
    [archetypeFor('generated-tree'), wide],
    { tree: variants(['generated-tree']), rock: variants(['generated-rock']) },
  );
  assert.equal(props.residentRadius, 5);
  assert.equal(props.keepRadius, 6);
});

test('偏离态按 id 保存，跨种类互不干扰', () => {
  const { world, props } = createManager(
    [archetypeFor('generated-tree'), archetypeFor('generated-rock')],
    { tree: variants(['generated-tree']), rock: variants(['generated-rock']) },
  );
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


test('同一种物件绑到不同原型，就得到不同的玩法与掉落', () => {
  const summer = archetypeFor('summer-tree');
  const winter = archetypeFor('winter-tree');
  winter.components.generatedProp = {
    maximumHealth: 6,
    harvestDamage: 2,
    drop: { archetypeId: 'frozen-log-pile', quantity: 2 },
  };

  const a = createManager([summer, winter], { tree: variants(['summer-tree']) });
  const b = createManager([summer, winter], { tree: variants(['winter-tree']) });
  a.props.ensureAround(0, 0);
  b.props.ensureAround(0, 0);

  // 同一批 chunk、同一个种子：位置与数量完全一致，只有玩法换了。
  const idsOf = (world) => world.query(GENERATED_PROP_COMPONENT).map((actor) => actor.id).sort();
  assert.deepEqual(idsOf(a.world), idsOf(b.world));
  assert.ok(idsOf(a.world).length > 0);

  const [first] = idsOf(a.world);
  const summerProp = a.world.getActor(first).requireComponent(GENERATED_PROP_COMPONENT);
  const winterProp = b.world.getActor(first).requireComponent(GENERATED_PROP_COMPONENT);
  assert.equal(a.world.getActor(first).archetypeId, 'summer-tree');
  assert.equal(b.world.getActor(first).archetypeId, 'winter-tree');
  assert.equal(summerProp.dropArchetypeId, 'wood-pile');
  assert.equal(winterProp.dropArchetypeId, 'frozen-log-pile');
  assert.equal(summerProp.maximumHealth, 3);
  assert.equal(winterProp.maximumHealth, 6);
  // 缩放来自世界种子，两边一致；掉落数量按各自的基数换算。
  assert.equal(summerProp.scale, winterProp.scale);
  assert.notEqual(summerProp.dropQuantity, winterProp.dropQuantity);
});

test('绑定指向不存在或既非采集物也非弹性 Actor 的原型时，那一种物件被跳过', () => {
  const { world, props } = createManager(
    [archetypeFor('generated-tree'), { schemaVersion: 1, id: 'wood-pile', components: {} }],
    {
      tree: variants(['generated-tree']),
      rock: variants(['wood-pile']),
      grass: variants(['nonexistent']),
    },
  );
  props.ensureAround(0, 0);
  assert.equal(props.archetypeForKind(PROP_KIND.TREE).id, 'generated-tree');
  assert.equal(props.archetypeForKind(PROP_KIND.ROCK), undefined);
  assert.equal(props.archetypeForKind(PROP_KIND.GRASS), undefined);
  assert.ok(world.query(GENERATED_PROP_COMPONENT).length > 0);
});

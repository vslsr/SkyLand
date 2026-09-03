import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLISION_LAYER } from '../../shared/collision/collisionLayers.mjs';
import {
  PROP_BUFFER_LENGTH,
  PROP_FIELD,
  PROP_STRIDE,
  generateChunkContent,
  generateChunkProps,
} from '../../shared/world/chunkContent.mjs';
import {
  MAXIMUM_COLLIDERS_PER_PROP,
  PROP_COLLIDER_TEMPLATES,
  buildChunkColliders,
} from '../../shared/world/chunkColliders.mjs';
import { CHUNK_SIZE, PROP_KIND } from '../../shared/world/worldConfig.mjs';
import { formatGeneratedPropId, setPropSkipped } from '../../shared/world/generatedProp.mjs';

const SEED = 0x5c1a2d0b;

test('同一个种子与 chunk 坐标永远派生出同一批碰撞体', () => {
  for (const [chunkX, chunkZ] of [[0, 0], [-3, 5], [7, -8]]) {
    const first = buildChunkColliders(SEED, chunkX, chunkZ);
    const second = buildChunkColliders(SEED, chunkX, chunkZ);
    assert.deepEqual(first, second);
  }
});

test('换一个种子就是另一个世界', () => {
  const a = buildChunkColliders(SEED, 0, 0);
  const b = buildChunkColliders(SEED ^ 0x1234, 0, 0);
  assert.notDeepEqual(a, b);
});

test('草无碰撞，蘑菇由 Actor 碰撞接管，树与岩石产生固定数量的静态盒子', () => {
  assert.deepEqual(PROP_COLLIDER_TEMPLATES[PROP_KIND.GRASS], []);
  assert.deepEqual(PROP_COLLIDER_TEMPLATES[PROP_KIND.MUSHROOM], []);
  const props = generateChunkContent(SEED, 0, 0);
  const expected = props.reduce(
    (total, prop) => total + PROP_COLLIDER_TEMPLATES[prop.kind].length,
    0,
  );
  assert.equal(buildChunkColliders(SEED, 0, 0).length, expected);
  assert.ok(props.some((prop) => prop.kind === PROP_KIND.GRASS));
});

test('树干挡走路也挡镜头，树冠只挡镜头', () => {
  const [trunk, ...crown] = PROP_COLLIDER_TEMPLATES[PROP_KIND.TREE];
  assert.equal(trunk.layers & COLLISION_LAYER.MOVEMENT, COLLISION_LAYER.MOVEMENT);
  assert.equal(trunk.layers & COLLISION_LAYER.CAMERA, COLLISION_LAYER.CAMERA);
  assert.ok(crown.length > 0);
  for (const layer of crown) {
    assert.equal(layer.layers & COLLISION_LAYER.MOVEMENT, 0);
    assert.equal(layer.layers & COLLISION_LAYER.CAMERA, COLLISION_LAYER.CAMERA);
    // 树冠必须比树干宽，否则挡不住斜着看过来的镜头。
    assert.ok(layer.halfWidth > trunk.halfWidth);
  }
  // 挡走路的那个盒子要小得多，否则每棵树周围都会多出一圈隐形墙。
  assert.ok(trunk.halfWidth < 0.5);
});

test('碰撞体落在自己的 chunk 里，尺寸随放置缩放变化', () => {
  const chunkX = 2;
  const chunkZ = -1;
  const colliders = buildChunkColliders(SEED, chunkX, chunkZ);
  assert.ok(colliders.length > 0);
  for (const { collision, transform } of colliders) {
    assert.ok(transform.x >= chunkX * CHUNK_SIZE && transform.x < (chunkX + 1) * CHUNK_SIZE);
    assert.ok(transform.z >= chunkZ * CHUNK_SIZE && transform.z < (chunkZ + 1) * CHUNK_SIZE);
    assert.ok(collision.halfWidth > 0 && collision.halfLength > 0);
    assert.ok(collision.maximumY > collision.minimumY);
  }

  const props = generateChunkContent(SEED, chunkX, chunkZ);
  const rock = props.find((prop) => prop.kind === PROP_KIND.ROCK);
  assert.ok(rock);
  const rockCollider = colliders.find((collider) => (
    Math.abs(collider.transform.x - rock.x) < 1e-12
    && Math.abs(collider.transform.z - rock.z) < 1e-12
  ));
  const template = PROP_COLLIDER_TEMPLATES[PROP_KIND.ROCK][0];
  assert.ok(Math.abs(rockCollider.collision.halfWidth - template.halfWidth * rock.scale) < 1e-12);
});

test('单个物件派生出的碰撞体数量有固定上界', () => {
  assert.equal(MAXIMUM_COLLIDERS_PER_PROP, PROP_COLLIDER_TEMPLATES[PROP_KIND.TREE].length);
  for (const templates of Object.values(PROP_COLLIDER_TEMPLATES)) {
    assert.ok(templates.length <= MAXIMUM_COLLIDERS_PER_PROP);
  }
});

/**
 * 找一个同时长着树和石头的 chunk。
 *
 * 不写死坐标：物件跟着地皮走，哪一块 chunk 上有什么会随生成参数变化，
 * 写死一个坐标只会让这条用例在下次调整地皮产出时莫名其妙地红掉。
 */
function findChunkWithTreeAndRock(props) {
  for (let chunkZ = -3; chunkZ <= 3; chunkZ += 1) {
    for (let chunkX = -3; chunkX <= 3; chunkX += 1) {
      const count = generateChunkProps(SEED, chunkX, chunkZ, props);
      let treeIndex = -1;
      let rockIndex = -1;
      for (let index = 0; index < count; index += 1) {
        const kind = props[index * PROP_STRIDE + PROP_FIELD.KIND];
        if (treeIndex < 0 && kind === PROP_KIND.TREE) treeIndex = index;
        if (rockIndex < 0 && kind === PROP_KIND.ROCK) rockIndex = index;
      }
      if (treeIndex >= 0 && rockIndex >= 0) return { chunkX, chunkZ, treeIndex, rockIndex };
    }
  }
  throw new Error('扫描范围里没有同时长着树和石头的 chunk');
}

test('树碰撞携带派生 Actor id，跳过掩码会整棵移除', () => {
  const props = new Int32Array(PROP_BUFFER_LENGTH);
  const { chunkX, chunkZ, treeIndex: propIndex, rockIndex } = findChunkWithTreeAndRock(props);
  const actorId = formatGeneratedPropId(PROP_KIND.TREE, chunkX, chunkZ, propIndex);
  const baseline = buildChunkColliders(SEED, chunkX, chunkZ);
  assert.equal(baseline.filter((collider) => collider.actorId === actorId).length, 3);

  const masked = buildChunkColliders(
    SEED,
    chunkX,
    chunkZ,
    undefined,
    setPropSkipped(undefined, propIndex, true),
  );
  assert.equal(masked.some((collider) => collider.actorId === actorId), false);
  assert.equal(masked.length, baseline.length - 3);

  // 岩石同样带 id：交互查询从碰撞世界反查 Actor 的这条路对所有种类一视同仁，
  // 哪些种类真的有 Actor 由原型注册表决定，碰撞体这一层不需要知道。
  const rockId = formatGeneratedPropId(PROP_KIND.ROCK, chunkX, chunkZ, rockIndex);
  assert.equal(baseline.filter((collider) => collider.actorId === rockId).length, 1);
});

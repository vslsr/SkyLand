import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCircleAgainstSimpleCollision } from '../../shared/actor/simpleCollision.mjs';
import { COLLISION_LAYER } from '../../shared/collision/collisionLayers.mjs';
import { PLAYER_COLLISION_RADIUS } from '../../shared/playerMovement.mjs';
import { buildChunkColliders } from '../../shared/world/chunkColliders.mjs';
import { toChunkCoordinate } from '../../shared/world/chunkKey.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';

const WORLD_SEED = 0x5c1a2d0b;

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; },
  };
}

/** 玩家周围那几个 chunk 里、会挡住走路的碰撞体。 */
function nearbyMovementColliders(x, z) {
  const centerX = toChunkCoordinate(x);
  const centerZ = toChunkCoordinate(z);
  const colliders = [];
  for (let chunkZ = centerZ - 1; chunkZ <= centerZ + 1; chunkZ += 1) {
    for (let chunkX = centerX - 1; chunkX <= centerX + 1; chunkX += 1) {
      for (const collider of buildChunkColliders(WORLD_SEED, chunkX, chunkZ)) {
        if (collider.layers & COLLISION_LAYER.MOVEMENT) colliders.push(collider);
      }
    }
  }
  return colliders;
}

/** 位置是否陷进了某个碰撞盒。留 2% 余量，避免刚好停在表面上被判为穿透。 */
function findPenetratedCollider(position, colliders) {
  const radius = PLAYER_COLLISION_RADIUS * 0.98;
  return colliders.find((collider) => {
    const pushed = resolveCircleAgainstSimpleCollision(position, radius, collider);
    return Math.hypot(pushed.x - position.x, pushed.z - position.z) > 1e-6;
  });
}

test('流式世界里的树和石头会挡住玩家，跨 chunk 行走全程不穿模', async () => {
  const clock = createClock();
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('open-world'), {
    now: clock.now,
    worldSeed: WORLD_SEED,
  });
  scene.addPlayer({ id: 'walker', name: '巡林员', slot: 0 });

  let inputTick = 0;
  let blockedAtLeastOnce = false;
  // 斜着走出两个 chunk，途中必然会撞上若干棵树。
  for (let step = 0; step < 400; step += 1) {
    clock.advance(0.05);
    scene.update();
    const before = { ...scene.players.get('walker') };
    const inputs = Array.from({ length: 3 }, () => ({
      tick: ++inputTick,
      move: { x: 0.8, z: 0.6 },
      yaw: 0,
    }));
    scene.applyInput('walker', {
      inputs,
    });
    const player = scene.players.get('walker');
    const position = { x: player.x, z: player.z };
    const penetrated = findPenetratedCollider(position, nearbyMovementColliders(player.x, player.z));
    assert.equal(
      penetrated,
      undefined,
      `第 ${step} 步走进了碰撞体：玩家 ${JSON.stringify(position)}`,
    );
    // 被挡住时实际位移会明显小于满速位移。
    const moved = Math.hypot(player.x - before.x, player.z - before.z);
    if (moved < 0.05 * 3.2 * 0.5) blockedAtLeastOnce = true;
  }
  assert.equal(blockedAtLeastOnce, true, '一路上没有被任何静态物件挡过，用例失去意义');
});

test('固定摆放的场景不会凭空多出静态碰撞体', async () => {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'));
  scene.addPlayer({ id: 'walker', name: '草地测试员', slot: 0 });
  scene.update();
  assert.equal(scene.chunkColliders.residentCount, 0);
});

test('出生点会被推到碰撞体之外', async () => {
  const catalog = await SceneCatalog.load();
  const definition = catalog.require('open-world');
  for (let slot = 0; slot < 16; slot += 1) {
    const scene = new ServerScene(definition, { worldSeed: WORLD_SEED });
    scene.addPlayer({ id: `player-${slot}`, name: `玩家${slot}`, slot });
    const player = scene.players.get(`player-${slot}`);
    const position = { x: player.x, z: player.z };
    assert.equal(
      findPenetratedCollider(position, nearbyMovementColliders(player.x, player.z)),
      undefined,
      `槽位 ${slot} 出生在碰撞体里：${JSON.stringify(position)}`,
    );
  }
});
import './initRapier.mjs';

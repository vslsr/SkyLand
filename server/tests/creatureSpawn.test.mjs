import assert from 'node:assert/strict';
import test from 'node:test';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import { COLLISION_LAYER_SOLID } from '../../shared/collision/collisionLayers.mjs';
import {
  DESPAWN_VERDICT,
  canSpawnCreatureAt,
  creatureCap,
  despawnVerdict,
  isCreatureChunk,
  isNightWindow,
  packSize,
  sampleSpawnPoint,
} from '../../shared/world/creatureSpawn.mjs';
import { CHUNK_SIZE, DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';
import { TERRAIN_SHAPE, TERRAIN_SURFACE } from '../../shared/world/terrainConfig.mjs';
import { encodeTerrainCell } from '../../shared/world/terrainContent.mjs';

/**
 * 刷新规则本身。全部是纯函数，所以这里一条一条钉，不需要造出一个房间来。
 */

/** 一个什么都允许的世界；每条用例只推翻它关心的那一条。 */
function permissiveWorld(overrides = {}) {
  return {
    cellCodeAt: () => encodeTerrainCell(0, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT),
    hasBuildPieceAt: () => false,
    fits: () => true,
    groundHeightAt: () => 0,
    withinBounds: () => true,
    ...overrides,
  };
}

test('刷新区块是种子的纯函数：同一片地永远出，另一片永远不出', () => {
  // 同样的输入必须给同样的答案——这是「那片沼泽一直出史莱姆」成立的全部前提。
  for (let index = 0; index < 50; index += 1) {
    const first = isCreatureChunk(DEFAULT_WORLD_SEED, index, -index, 4);
    const second = isCreatureChunk(DEFAULT_WORLD_SEED, index, -index, 4);
    assert.equal(first, second);
  }
  // 换个种子就是另一张出怪地图。
  const sameSeed = [];
  const otherSeed = [];
  for (let index = 0; index < 200; index += 1) {
    sameSeed.push(isCreatureChunk(DEFAULT_WORLD_SEED, index, 0, 4));
    otherSeed.push(isCreatureChunk(DEFAULT_WORLD_SEED ^ 0x1234, index, 0, 4));
  }
  assert.notDeepEqual(sameSeed, otherSeed);

  // oneIn 为 1 时到处都出：不需要这一层的生物走的是同一条代码路径。
  for (let index = 0; index < 20; index += 1) {
    assert.equal(isCreatureChunk(DEFAULT_WORLD_SEED, index, index, 1), true);
  }
});

test('刷新区块的密度接近 1/N', () => {
  let hits = 0;
  const total = 64 * 64;
  for (let chunkZ = 0; chunkZ < 64; chunkZ += 1) {
    for (let chunkX = 0; chunkX < 64; chunkX += 1) {
      if (isCreatureChunk(DEFAULT_WORLD_SEED, chunkX, chunkZ, 4)) hits += 1;
    }
  }
  const ratio = hits / total;
  assert.ok(ratio > 0.2 && ratio < 0.3, `1/4 的区块应当接近 0.25，实际 ${ratio.toFixed(3)}`);
});

test('配额跟着人头走：没有人的房间配额是 0', () => {
  assert.equal(creatureCap(0, 6, 24), 0, '没有人看的房间不刷怪');
  assert.equal(creatureCap(1, 6, 24), 6);
  assert.equal(creatureCap(3, 6, 24), 18);
  assert.equal(creatureCap(9, 6, 24), 24, '全房间硬上限压过按人头算的配额');
});

test('夜间窗口跨得过午夜', () => {
  assert.equal(isNightWindow(20, 19, 5), true);
  assert.equal(isNightWindow(23.9, 19, 5), true);
  assert.equal(isNightWindow(0, 19, 5), true, '午夜那一刻不能把夜里刷怪停掉');
  assert.equal(isNightWindow(4.9, 19, 5), true);
  assert.equal(isNightWindow(5, 19, 5), false);
  assert.equal(isNightWindow(12, 19, 5), false);
  assert.equal(isNightWindow(18.9, 19, 5), false);
});

test('成群刷新的数量落在闭区间里', () => {
  const seen = new Set();
  for (let index = 0; index < 100; index += 1) {
    const size = packSize(index / 100, 1, 3);
    assert.ok(size >= 1 && size <= 3, `实际 ${size}`);
    seen.add(size);
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3], '三个值都要取得到');
  assert.equal(packSize(0.5, 2, 2), 2, '上下限相等时就是那个数');
});

test('候选点落在圆环里：不在人脸上，也不在够不着的地方', () => {
  const center = { x: 12, z: -30 };
  for (let index = 0; index < 200; index += 1) {
    const point = sampleSpawnPoint(center, 16, 40, index / 200, ((index * 37) % 200) / 200);
    const distance = Math.hypot(point.x - center.x, point.z - center.z);
    assert.ok(distance >= 16 - 1e-9, `不该刷在 16 米以内，实际 ${distance.toFixed(2)}`);
    assert.ok(distance <= 40 + 1e-9, `不该刷在 40 米以外，实际 ${distance.toFixed(2)}`);
  }
});

test('平坦陆地才刷：水面、斜坡、界外一律不刷', () => {
  const flat = permissiveWorld();
  assert.equal(canSpawnCreatureAt(flat, 3, 3), true);

  const water = permissiveWorld({
    cellCodeAt: () => encodeTerrainCell(-1, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT),
  });
  assert.equal(canSpawnCreatureAt(water, 3, 3), false, '水面上不刷');

  const slope = permissiveWorld({
    cellCodeAt: () => encodeTerrainCell(0, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.RAMP_EAST),
  });
  assert.equal(canSpawnCreatureAt(slope, 3, 3), false, '斜坡上刷出来第一帧就在往下滑');

  const outside = permissiveWorld({ withinBounds: () => false });
  assert.equal(canSpawnCreatureAt(outside, 3, 3), false);
});

test('玩家铺过的地不刷怪：建筑块是这一版的「把屋子点亮」', () => {
  const built = permissiveWorld({
    hasBuildPieceAt: (cellX, cellZ) => cellX === 1 && cellZ === 1,
  });
  // 格 (1,1) 覆盖世界坐标 [2,4)×[2,4)。
  assert.equal(canSpawnCreatureAt(built, 3, 3), false, '地基上不刷');
  assert.equal(canSpawnCreatureAt(built, 5, 3), true, '旁边那一格照刷');
});

test('塞不下就不刷，判据是玩家控制器那一份圆形推出', () => {
  const collision = new CollisionWorld();
  collision.setDynamic('tree', {
    collision: {
      shape: 'box',
      centerX: 0,
      centerZ: 0,
      halfWidth: 0.6,
      halfLength: 0.6,
      minimumY: 0,
      maximumY: 2,
    },
    transform: { x: 3, y: 0, z: 3, yaw: 0 },
    layers: COLLISION_LAYER_SOLID,
  });
  const world = permissiveWorld({
    fits: (x, z, y) => {
      const resolved = collision.resolveCircle({ x, z }, 0.4, {
        verticalProfile: { minimumY: y, maximumY: y + 1, maximumStepHeight: 0 },
      });
      return Math.abs(resolved.x - x) < 1e-3 && Math.abs(resolved.z - z) < 1e-3;
    },
  });
  assert.equal(canSpawnCreatureAt(world, 3, 3), false, '树里不刷');
  assert.equal(canSpawnCreatureAt(world, 9, 9), true);
});

test('消失分两档：范围内留着，范围外掷骰子，一倍半外立刻收走', () => {
  assert.equal(despawnVerdict(20, 40, 0, 0.25), DESPAWN_VERDICT.KEEP, '刷新范围内一律留着');
  assert.equal(despawnVerdict(40, 40, 0, 0.25), DESPAWN_VERDICT.KEEP, '边界上还算范围内');
  assert.equal(despawnVerdict(50, 40, 0.9, 0.25), DESPAWN_VERDICT.KEEP, '随机档没掷中就留着');
  assert.equal(despawnVerdict(50, 40, 0.1, 0.25), DESPAWN_VERDICT.RANDOM, '随机档掷中了就走');
  assert.equal(despawnVerdict(61, 40, 0.99, 0.25), DESPAWN_VERDICT.IMMEDIATE, '一倍半之外立刻走');
  // 房间空了：世界里不该留着一群等在那儿的怪。
  assert.equal(
    despawnVerdict(Number.POSITIVE_INFINITY, 40, 0.99, 0.25),
    DESPAWN_VERDICT.IMMEDIATE,
  );
});

test('刷新区块的粒度就是 chunk：同一个 chunk 里的点答案一致', () => {
  const chunkX = 3;
  const chunkZ = -2;
  const expected = isCreatureChunk(DEFAULT_WORLD_SEED, chunkX, chunkZ, 4);
  for (let offset = 1; offset < CHUNK_SIZE; offset += 7) {
    const insideX = Math.floor((chunkX * CHUNK_SIZE + offset) / CHUNK_SIZE);
    const insideZ = Math.floor((chunkZ * CHUNK_SIZE + offset) / CHUNK_SIZE);
    assert.equal(isCreatureChunk(DEFAULT_WORLD_SEED, insideX, insideZ, 4), expected);
  }
});

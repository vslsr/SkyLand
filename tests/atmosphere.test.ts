import test from 'node:test';
import assert from 'node:assert/strict';
import { FOG_FAR, FOG_NEAR } from '../src/materials/atmosphere.ts';
import { CHUNK_LOAD_RADIUS, CHUNK_SIZE } from '../shared/world/worldConfig.mjs';

test('雾效在最近的未加载 chunk 之前就已经完全遮住视野', () => {
  // 玩家站在自己 chunk 的边缘时，加载区域至少还向外延伸这么远。
  const nearestUnloadedDistance = CHUNK_LOAD_RADIUS * CHUNK_SIZE;
  assert.ok(
    FOG_FAR <= nearestUnloadedDistance,
    `雾效远端 ${FOG_FAR} 超过了最近的未加载距离 ${nearestUnloadedDistance}，chunk 的出现会被玩家看见`,
  );
});

test('雾效近端小于远端', () => {
  assert.ok(FOG_NEAR < FOG_FAR);
});

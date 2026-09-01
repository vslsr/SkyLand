import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerBuoyancyHeightController } from '../src/player/PlayerBuoyancyHeightController';

test('本地玩家平滑权威浮力高度，并保留配置的大峰谷振幅', () => {
  const root = new THREE.Group();
  const baseHeight = -0.58;
  const controller = new PlayerBuoyancyHeightController(root, () => baseHeight, 0.3);

  controller.setAuthoritativeHeight(0, 0, baseHeight + 0.3);
  controller.update(0, true);
  const crest = root.position.y;
  controller.setAuthoritativeHeight(0, 0, baseHeight - 0.3);
  controller.update(0, true);
  const trough = root.position.y;
  assert.ok(Math.abs(crest - trough - 0.6) < 1e-9);

  controller.setAuthoritativeHeight(0, 0, baseHeight + 10);
  controller.update(0, true);
  assert.equal(root.position.y, baseHeight + 0.3, '异常快照偏移不能超过原型振幅');
  controller.update(0, false);
  assert.equal(root.position.y, baseHeight, '离开水域后立即回归地面支撑高度');
});

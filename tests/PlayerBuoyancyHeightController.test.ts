import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerBuoyancyHeightController } from '../src/player/PlayerBuoyancyHeightController';

test('本地玩家平滑权威浮力高度，并保留配置的大峰谷振幅', () => {
  const baseHeight = -0.58;
  const controller = new PlayerBuoyancyHeightController(() => baseHeight, 0.3);

  controller.setAuthoritativeHeight(0, 0, baseHeight + 0.3);
  controller.update(0, true);
  const crest = controller.sampleHeight(0, 0);
  controller.setAuthoritativeHeight(0, 0, baseHeight - 0.3);
  controller.update(0, true);
  const trough = controller.sampleHeight(0, 0);
  assert.ok(Math.abs(crest - trough - 0.6) < 1e-9);

  controller.setAuthoritativeHeight(0, 0, baseHeight + 10);
  controller.update(0, true);
  assert.equal(controller.sampleHeight(0, 0), baseHeight + 0.3, '异常快照偏移不能超过原型振幅');
  controller.update(0, false);
  assert.equal(controller.sampleHeight(0, 0), baseHeight, '离开水域后立即回归地面支撑高度');
});

test('浮力平滑器不直接改写角色渲染 Transform，台阶边缘高度只由物理解算', () => {
  const root = new THREE.Group();
  root.position.set(2.01, 1, 0);
  const sampledGroundHeight = (x: number): number => (x < 2 ? 1 : 0);
  const controller = new PlayerBuoyancyHeightController(sampledGroundHeight, 0.3);

  controller.update(1 / 60, false, true);

  assert.equal(root.position.y, 1, '中心点跨到低格时不能把仍受圆柱边缘支撑的角色吸到地面');
  assert.equal(controller.sampleHeight(root.position.x, root.position.z), 0);
});

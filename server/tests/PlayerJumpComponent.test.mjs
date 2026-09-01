import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Actor,
  PLAYER_JUMP_COMPONENT,
  PlayerJumpComponent,
} from '../../shared/actor/index.mjs';
import { TERRAIN_HEIGHT_STEP } from '../../shared/world/terrainConfig.mjs';

test('PlayerJumpComponent 只响应按下沿，并以冲量和重力完成起跳落地', () => {
  const actor = new Actor('jump-player', 'pbf-slime');
  const jump = actor.addComponent(new PlayerJumpComponent({
    impulse: 7,
    gravity: 22,
    maximumFallSpeed: 20,
    airControl: 0.85,
  }));
  assert.equal(actor.requireComponent(PLAYER_JUMP_COMPONENT), jump);
  assert.equal(jump.setPressed(true), true);
  assert.equal(jump.setPressed(true), false, '按住 Space 不能重复叠加冲量');
  assert.equal(jump.horizontalControlScale, 0.85);

  let y = 0;
  let maximumY = 0;
  for (let frame = 0; frame < 80 && jump.isAirborne; frame += 1) {
    y = jump.integrate(y, 1 / 120);
    maximumY = Math.max(maximumY, y);
    y = jump.resolveGround(y, 0);
  }
  assert.ok(maximumY > TERRAIN_HEIGHT_STEP, `最高点 ${maximumY} 应高于一格地形`);
  assert.equal(jump.grounded, true);
  assert.equal(y, 0);
  assert.equal(jump.verticalVelocity, 0);
  assert.equal(jump.setPressed(true), false, '未松开按键时落地不能自动连跳');
  jump.setPressed(false);
  assert.equal(jump.setPressed(true), true, '松开后的下一次按下可以再次跳跃');
});

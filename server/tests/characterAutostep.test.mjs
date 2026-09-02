import './initRapier.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import { AUTOSTEP_MAX_HEIGHT } from '../../shared/physics/characterParams.mjs';
import { createCharacterState } from '../../shared/physics/characterState.mjs';
import {
  createCharacterSimulationParams,
  stepCharacter,
} from '../../shared/physics/stepCharacter.mjs';
import { buildTerrainCollisionMesh } from '../../shared/world/terrainCollisionMesh.mjs';
import { encodeTerrainCell } from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_HEIGHT_STEP,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';

const DT = 1 / 60;
const MOVEMENT = { walkSpeed: 4, sprintMultiplier: 1.5, acceleration: 30, deceleration: 30 };
const JUMP = { impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85 };

const cell = (height, shape = TERRAIN_SHAPE.FLAT) => (
  encodeTerrainCell(height, TERRAIN_SURFACE.GROUND, shape)
);

/** 台阶前沿所在的 X；角色半径 0.42，被挡住时会停在这之前。 */
const LEDGE_EDGE_X = 2;

function walkOverLedge(ledgeHeight) {
  const physics = new PhysicsWorld(getRapier(), { timestep: DT });
  physics.setStaticColliderGroup('test', [
    { shape: 'box', x: 0, y: 0, z: 0, yaw: 0, halfWidth: 20, halfLength: 6, minimumY: -0.2, maximumY: 0 },
    {
      shape: 'box',
      x: LEDGE_EDGE_X + 10,
      y: 0,
      z: 0,
      yaw: 0,
      halfWidth: 10,
      halfLength: 6,
      minimumY: 0,
      maximumY: ledgeHeight,
    },
  ]);
  physics.createCharacter('player', { x: 0, y: 0, z: 0, radius: 0.42, halfHeight: 0.42 });
  const state = createCharacterState({ x: 0, y: 0, z: 0, grounded: true });
  const params = createCharacterSimulationParams('player', MOVEMENT, JUMP);
  for (let tick = 0; tick < 180; tick += 1) {
    stepCharacter(state, { move: { x: 1, z: 0 } }, DT, physics, params);
  }
  physics.dispose();
  return state;
}

function terrainWorld(codeAt) {
  const physics = new PhysicsWorld(getRapier(), { timestep: DT });
  for (let chunkX = -1; chunkX <= 1; chunkX += 1) {
    for (let chunkZ = -1; chunkZ <= 1; chunkZ += 1) {
      physics.setChunkCollider(
        `${chunkX}:${chunkZ}`,
        buildTerrainCollisionMesh(chunkX, chunkZ, codeAt),
      );
    }
  }
  return physics;
}

test('自动上台阶的高度必须低于地形步高，否则崖壁退化成免费台阶', () => {
  assert.ok(
    AUTOSTEP_MAX_HEIGHT < TERRAIN_HEIGHT_STEP,
    `autostep ${AUTOSTEP_MAX_HEIGHT} 不能达到地形步高 ${TERRAIN_HEIGHT_STEP}`,
  );
  // 角色总高 0.84m：能自动迈过的台阶不该超过自己的一半。
  assert.ok(AUTOSTEP_MAX_HEIGHT <= 0.42, `autostep ${AUTOSTEP_MAX_HEIGHT} 高过角色半身`);
});

test('矮台阶自动迈过，接近步高的台阶必须挡住玩家', () => {
  const low = walkOverLedge(AUTOSTEP_MAX_HEIGHT - 0.05);
  assert.ok(low.x > LEDGE_EDGE_X + 4, `矮台阶没走上去：x=${low.x}`);
  assert.ok(Math.abs(low.y - (AUTOSTEP_MAX_HEIGHT - 0.05)) < 0.01, `站位不在台阶顶面：y=${low.y}`);

  const high = walkOverLedge(AUTOSTEP_MAX_HEIGHT + 0.05);
  assert.ok(high.y < 0.05, `刚过上限的台阶被走上去了：y=${high.y}`);
  assert.ok(high.x < LEDGE_EDGE_X, `刚过上限的台阶没挡住玩家：x=${high.x}`);

  const cliff = walkOverLedge(TERRAIN_HEIGHT_STEP);
  assert.ok(cliff.y < 0.05, `1m 崖壁被直接走上去：y=${cliff.y}`);
});

test('落在 1m 台地上之后沿顶面走过 cell 与 chunk 接缝不卡住', () => {
  // cellX >= 0 是一整片 1m 台地；从台地上出发一路向东，途中跨过 chunk 0 与 1 的接缝。
  const physics = terrainWorld((cellX) => (cellX >= 0 ? cell(1) : cell(0)));
  physics.createCharacter('player', { x: 2, y: 1, z: 4, radius: 0.42, halfHeight: 0.42 });
  const state = createCharacterState({ x: 2, y: 1, z: 4, grounded: true });
  const params = createCharacterSimulationParams('player', MOVEMENT, JUMP);
  const samples = [];
  for (let tick = 0; tick < 60 * 12; tick += 1) {
    stepCharacter(state, { move: { x: 1, z: 0 } }, DT, physics, params);
    samples.push(state.x);
  }
  assert.ok(state.x > 34, `没能跨过 chunk 接缝：x=${state.x}`);
  assert.ok(Math.abs(state.y - 1) < 0.01, `离开了台地顶面：y=${state.y}`);
  // 任何一个 0.5 秒窗口都必须有明显位移，否则就是卡在某条接缝上。
  for (let index = 30; index + 30 < samples.length; index += 30) {
    assert.ok(
      samples[index + 30] > samples[index] + 0.3,
      `第 ${index} 步附近停住了：${samples[index]} -> ${samples[index + 30]}`,
    );
  }
  physics.dispose();
});

test('直坡仍然可以走上 1m 台地', () => {
  const physics = terrainWorld((cellX) => {
    if (cellX < 0) return cell(0);
    if (cellX === 0) return cell(0, TERRAIN_SHAPE.RAMP_EAST);
    return cell(1);
  });
  physics.createCharacter('player', { x: -4, y: 0, z: 4, radius: 0.42, halfHeight: 0.42 });
  const state = createCharacterState({ x: -4, y: 0, z: 4, grounded: true });
  const params = createCharacterSimulationParams('player', MOVEMENT, JUMP);
  for (let tick = 0; tick < 60 * 4; tick += 1) {
    stepCharacter(state, { move: { x: 1, z: 0 } }, DT, physics, params);
  }
  assert.ok(Math.abs(state.y - 1) < 0.01, `坡道没走上去：y=${state.y}`);
  physics.dispose();
});

test('起跳仍然能上 1m 台地，崖壁不是死路', () => {
  const physics = terrainWorld((cellX) => (cellX >= 0 ? cell(1) : cell(0)));
  physics.createCharacter('player', { x: -4, y: 0, z: 4, radius: 0.42, halfHeight: 0.42 });
  const state = createCharacterState({ x: -4, y: 0, z: 4, grounded: true });
  const params = createCharacterSimulationParams('player', MOVEMENT, JUMP);
  let jumped = false;
  for (let tick = 0; tick < 60 * 4; tick += 1) {
    // 贴近崖壁一米左右起跳，抛物线顶点约 1.11m，够踩上 1m 台地。
    const jump = !jumped && state.x >= -1.42;
    if (jump) jumped = true;
    stepCharacter(state, { move: { x: 1, z: 0 }, jump }, DT, physics, params);
  }
  assert.equal(jumped, true);
  assert.ok(Math.abs(state.y - 1) < 0.01, `起跳没能踩上台地：y=${state.y}`);
  physics.dispose();
});

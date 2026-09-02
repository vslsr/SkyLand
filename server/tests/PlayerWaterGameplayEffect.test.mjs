import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IN_WATER_STATE_TAG,
  MOVE_SPEED_ATTRIBUTE,
  WATER_MOVEMENT_EFFECT_ID,
} from '../../shared/abilities/index.mjs';
import {
  encodeTerrainCell,
  terrainCellCodeAt,
  terrainCellSurface,
  sampleTerrain,
} from '../../shared/world/terrainContent.mjs';
import {
  TERRAIN_CELL_SIZE,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../shared/world/terrainConfig.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';
import { terrainMovementHeight } from '../../shared/world/terrainMovement.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

function findCell(surface) {
  for (let z = -64; z < 64; z += 1) {
    for (let x = -64; x < 64; x += 1) {
      if (terrainCellSurface(terrainCellCodeAt(DEFAULT_WORLD_SEED, x, z)) === surface) {
        return {
          x: (x + 0.5) * TERRAIN_CELL_SIZE,
          z: (z + 0.5) * TERRAIN_CELL_SIZE,
        };
      }
    }
  }
  throw new Error(`没有找到测试地形表面：${surface}`);
}

function createDefinition(spawn, seaLevel = 0) {
  return {
    id: 'player-water-gas-test',
    renderer: { world: {} },
    gameplay: {
      bounds: { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 },
      spawn: { centerX: spawn.x, centerZ: spawn.z, radius: 0, slots: 1 },
      playerActor: { archetypeId: 'player-slime' },
      water: { seaLevel },
    },
    actorArchetypes: [{
      id: 'player-slime',
      components: {
        playerMovement: {
          walkSpeed: 3.2,
          sprintMultiplier: 1.65,
          maximumStepHeight: 0.2,
        },
        buoyancy: {
          minimumBeam: 0.84,
          minimumLength: 0.84,
          maximumTrimRadians: 0,
          minimumDraft: 0.08,
          maximumDraft: 0.28,
          bobAmplitude: 0.3,
          bobFrequency: 0.55,
          parts: [
            { id: 'body', mass: 40, buoyancy: 80, integrity: 1, localX: 0, localZ: 0 },
          ],
        },
        render: { model: 'line-art-player-slime', radius: 0.42 },
      },
    }],
  };
}

test('玩家进水时 GAS 减速，权威 Y 只随固定物理输入步变化', () => {
  let now = 1_000_000;
  const water = findCell(TERRAIN_SURFACE.WATER);
  const ground = findCell(TERRAIN_SURFACE.GROUND);
  const scene = new ServerScene(createDefinition(water), {
    worldSeed: DEFAULT_WORLD_SEED,
    now: () => now,
  });
  scene.addPlayer({ id: 'water-player', name: '涉水玩家', slot: 0 });

  const player = scene.players.get('water-player');
  const abilities = player.gameAbility.abilitySystem;
  assert.equal(abilities.attributes.getBaseValue(MOVE_SPEED_ATTRIBUTE), 3.2);
  assert.equal(abilities.attributes.getCurrentValue(MOVE_SPEED_ATTRIBUTE), 1.6);
  assert.equal(abilities.hasTag(IN_WATER_STATE_TAG), true);
  assert.deepEqual(
    abilities.createSnapshot().effects.map((effect) => effect.effectId),
    [WATER_MOVEMENT_EFFECT_ID],
  );
  const terrain = sampleTerrain(DEFAULT_WORLD_SEED, water.x, water.z);
  const support = terrainMovementHeight(terrain, 0, player.getComponent('buoyancy').draft);
  const expectedInitialY = Math.max(terrain.groundY, support);
  assert.ok(Math.abs(player.y - expectedInitialY) < 1e-9);
  const initialY = player.y;
  now += 400;
  scene.update();
  assert.equal(player.y, initialY, '房间 update 不能绕过固定物理步直接覆盖玩家 Y');
  assert.equal(scene.createSnapshot('water-player').players[0].y, Math.round(player.y * 1000) / 1000);

  const beforeX = player.x;
  scene.applyInput(player.id, {
    inputs: Array.from({ length: 3 }, (_, index) => ({
      tick: index + 1,
      move: { x: 1, z: 0 },
      sprint: false,
      jump: false,
      yaw: 0,
    })),
  });
  assert.ok(player.x > beforeX);
  assert.notEqual(player.y, initialY, '浮力应通过输入固定步里的垂直速度积分生效');
  assert.ok(player.speed <= 1.6 + 1e-6);
  assert.equal(abilities.createSnapshot().effects.length, 1, '水中连续输入不能重复堆叠效果');

  player.setPosition(ground.x, ground.z);
  scene.applyInput(player.id, {
    inputs: [{ tick: 4, move: { x: 0, z: 0 }, sprint: false, jump: false, yaw: 0 }],
  });
  assert.equal(abilities.attributes.getCurrentValue(MOVE_SPEED_ATTRIBUTE), 3.2);
  assert.equal(abilities.hasTag(IN_WATER_STATE_TAG), false);
  assert.equal(abilities.createSnapshot().effects.length, 0);
});

test('服务端允许玩家跳过岸沿并在落地后继续向岸内移动', () => {
  let now = 1_000_000;
  const scene = new ServerScene(createDefinition({ x: 0.1, z: 1 }, -0.4), {
    worldSeed: DEFAULT_WORLD_SEED,
    now: () => now,
  });
  const water = encodeTerrainCell(-1, TERRAIN_SURFACE.WATER, TERRAIN_SHAPE.FLAT);
  const land = encodeTerrainCell(0, TERRAIN_SURFACE.GROUND, TERRAIN_SHAPE.FLAT);
  scene.terrainPatches.setCellCode(-1, 0, water);
  scene.terrainPatches.setCellCode(0, 0, land);
  // 本用例只验证地形岸沿，排除程序化树石碰撞的随机干扰。
  scene.collision.resolveCircle = (position) => position;
  scene.addPlayer({ id: 'shore-jumper', name: '越岸玩家', slot: 0 });

  const player = scene.players.get('shore-jumper');
  const waterPosition = { x: -0.5, z: 1 };
  const shorePosition = { x: 0.1, z: 1 };
  const inlandPosition = { x: 0.5, z: 1 };
  const waterY = scene.playerSupportHeightAt(player, waterPosition.x, waterPosition.z, now / 1000);
  player.setPosition(waterPosition.x, waterPosition.z, waterY);
  player.jump.applyAuthoritativeState(0, true);
  player.characterState.grounded = true;

  let tick = 1;
  const advancePacket = (jump = false) => {
    now += 50;
    scene.update();
    const inputs = Array.from({ length: 3 }, (_, index) => ({
      tick: tick + index,
      move: { x: 1, z: 0 },
      sprint: false,
      jump,
      yaw: Math.PI / 2,
    }));
    tick += 3;
    scene.applyInput(player.id, { inputs });
  };

  for (let packet = 0; packet < 4; packet += 1) advancePacket(false);
  assert.ok(player.x < shorePosition.x, '未起跳时岸沿仍应阻挡玩家');

  advancePacket(true);
  assert.equal(player.characterState.grounded, false, '水面支撑仍必须允许起跳');
  assert.ok(player.characterState.vy > 0, '起跳后必须保留向上速度');
  for (let packet = 0; packet < 24 && player.x < inlandPosition.x; packet += 1) {
    advancePacket(false);
  }
  assert.ok(
    player.x >= inlandPosition.x,
    `起跳后应越过岸沿，实际 ${JSON.stringify({
      x: player.x,
      y: player.y,
      vx: player.characterState.vx,
      vy: player.characterState.vy,
      grounded: player.characterState.grounded,
      ackTick: player.ackTick,
    })}`,
  );
  for (let packet = 0; packet < 20 && !player.characterState.grounded; packet += 1) {
    advancePacket(false);
  }
  assert.equal(player.characterState.grounded, true);
});
import './initRapier.mjs';

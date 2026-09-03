import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleBuoyancyBobOffset } from '../../shared/actor/buoyancyMotion.mjs';
import { RECONCILE_TOLERANCE, SIMULATION_STEP_SECONDS } from '../../shared/networkTuning.mjs';
import { initRapier } from '../../shared/physics/RapierRuntime.mjs';
import { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { simpleCollisionGroupToPhysicsDefinitions } from '../../shared/physics/simpleCollisionToPhysics.mjs';
import { createCharacterSimulationParams, stepCharacter } from '../../shared/physics/stepCharacter.mjs';
import { buildChunkColliders } from '../../shared/world/chunkColliders.mjs';
import { toChunkKey } from '../../shared/world/chunkKey.mjs';
import { TERRAIN_CELL_SIZE, TERRAIN_SURFACE } from '../../shared/world/terrainConfig.mjs';
import {
  sampleTerrain,
  terrainCellCodeAt,
  terrainCellSurface,
} from '../../shared/world/terrainContent.mjs';
import { buildTerrainCollisionMesh } from '../../shared/world/terrainCollisionMesh.mjs';
import { terrainMovementHeight } from '../../shared/world/terrainMovement.mjs';
import { CHUNK_SIZE, DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';
import { ServerScene } from '../scene/ServerScene.mjs';

/**
 * 客户端和解重放必须落在服务端到过的地方——涉水时也一样。
 *
 * 服务端每个固定步之前都按**那一步的位置和 tick** 重算 `walkSpeed` 与
 * `buoyancyHeight`（`ServerScene.stepPlayerOnce`）。客户端一度把这两个值冻在和解
 * 那一刻跑完整段重放，于是浮力的上下起伏被按住不动，重放越长偏得越远。旱地上
 * 这两个值恒定，所以这个错只在带水域的地图上露出来——这条测试因此必须站在水里。
 *
 * 这里两侧跑的是同一份 `stepCharacter` 和同一批碰撞体，唯一的变量就是「涉水参数
 * 逐步重判还是冻住」，偏差因此只可能来自那一处。
 */

const SEED = DEFAULT_WORLD_SEED;
const WALK_SPEED = 3.2;
const SPRINT_MULTIPLIER = 1.65;
/** 客户端物理世界的 keepRadius；比服务端的常驻圈大，覆盖重放走到的每一格。 */
const CLIENT_CHUNK_RADIUS = 3;

const BUOYANCY = {
  minimumBeam: 0.84,
  minimumLength: 0.84,
  maximumTrimRadians: 0,
  minimumDraft: 0.08,
  maximumDraft: 0.28,
  bobAmplitude: 0.3,
  bobFrequency: 0.55,
  parts: [{ id: 'body', mass: 40, buoyancy: 80, integrity: 1, localX: 0, localZ: 0 }],
};

function findWaterCell() {
  for (let z = -64; z < 64; z += 1) {
    for (let x = -64; x < 64; x += 1) {
      if (terrainCellSurface(terrainCellCodeAt(SEED, x, z)) === TERRAIN_SURFACE.WATER) {
        return { x: (x + 0.5) * TERRAIN_CELL_SIZE, z: (z + 0.5) * TERRAIN_CELL_SIZE };
      }
    }
  }
  throw new Error('测试世界里没有水域格');
}

function createDefinition(spawn) {
  return {
    id: 'water-replay-parity',
    renderer: { world: {} },
    gameplay: {
      bounds: { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 },
      spawn: { centerX: spawn.x, centerZ: spawn.z, radius: 0, slots: 1 },
      playerActor: { archetypeId: 'player-slime' },
      water: { seaLevel: 0 },
    },
    actorArchetypes: [{
      id: 'player-slime',
      components: {
        playerMovement: {
          walkSpeed: WALK_SPEED,
          sprintMultiplier: SPRINT_MULTIPLIER,
          maximumStepHeight: 0.2,
        },
        buoyancy: BUOYANCY,
        render: { model: 'line-art-player-slime', radius: 0.42 },
      },
    }],
  };
}

/** 客户端那一侧的碰撞世界：同一批 chunk trimesh 与物件盒子。 */
function createClientPhysics(rapier, spawn) {
  const physics = new PhysicsWorld(rapier, { timestep: SIMULATION_STEP_SECONDS });
  const centerX = Math.floor(spawn.x / CHUNK_SIZE);
  const centerZ = Math.floor(spawn.z / CHUNK_SIZE);
  for (let dz = -CLIENT_CHUNK_RADIUS; dz <= CLIENT_CHUNK_RADIUS; dz += 1) {
    for (let dx = -CLIENT_CHUNK_RADIUS; dx <= CLIENT_CHUNK_RADIUS; dx += 1) {
      const chunkX = centerX + dx;
      const chunkZ = centerZ + dz;
      const key = toChunkKey(chunkX, chunkZ);
      physics.setChunkCollider(
        key,
        buildTerrainCollisionMesh(chunkX, chunkZ, (x, z) => terrainCellCodeAt(SEED, x, z)),
      );
      physics.setStaticColliderGroup(
        `props:${key}`,
        simpleCollisionGroupToPhysicsDefinitions(buildChunkColliders(SEED, chunkX, chunkZ)),
      );
    }
  }
  return physics;
}

/**
 * 照 `PlayerEntity` 那三个钩子 + `TopDownController.refreshWaterStepParams` 的组合重放。
 * `perStep` 为 false 时复现修复之前的行为：涉水参数只解析一次，之后整段冻住。
 */
function replayOnClient(physics, anchor, inputs, draft, { perStep }) {
  const state = { ...anchor };
  physics.setCharacterTranslation('me', state);
  physics.prepareQueries();
  const params = createCharacterSimulationParams(
    'me',
    { walkSpeed: WALK_SPEED, sprintMultiplier: SPRINT_MULTIPLIER },
    {},
  );
  const trace = [];
  let resolved;
  for (const input of inputs) {
    if (perStep || resolved === undefined) {
      const sample = sampleTerrain(SEED, state.x, state.z, {});
      const inWater = sample.surface === TERRAIN_SURFACE.WATER;
      resolved = {
        // Effect.Movement.WaterSlow 把移动速度砍半。
        walkSpeed: inWater ? WALK_SPEED * 0.5 : WALK_SPEED,
        buoyancyHeight: inWater
          ? Math.max(
              sample.groundY,
              terrainMovementHeight(sample, 0, draft) + sampleBuoyancyBobOffset(
                'me',
                input.tick * SIMULATION_STEP_SECONDS,
                BUOYANCY.bobAmplitude,
                BUOYANCY.bobFrequency,
              ),
            )
          : undefined,
      };
    }
    params.walkSpeed = resolved.walkSpeed;
    params.buoyancyHeight = resolved.buoyancyHeight;
    stepCharacter(state, input, SIMULATION_STEP_SECONDS, physics, params);
    trace.push({ ...state });
  }
  return trace;
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

test('水里重放：逐步重判涉水参数才落在服务端到过的地方', async () => {
  const rapier = await initRapier(() => import('@dimforge/rapier3d-compat'));
  const spawn = findWaterCell();
  let now = 1_000_000;
  const scene = new ServerScene(createDefinition(spawn), { worldSeed: SEED, now: () => now });
  scene.addPlayer({ id: 'me', name: '涉水玩家', slot: 0 });
  const player = scene.players.get('me');
  const draft = player.getComponent('buoyancy').draft;

  const anchor = { ...player.characterState };
  const inputs = Array.from({ length: 24 }, (_, index) => ({
    tick: index + 1,
    move: { x: 1, z: 0.35 },
    sprint: false,
    jump: false,
    yaw: 0,
  }));
  const authoritative = [];
  for (const input of inputs) {
    player.stepBudget = 1;
    scene.stepPlayerOnce(player, input);
    authoritative.push({ ...player.characterState });
  }
  // 这条路径必须真的在水里，否则测的就不是涉水那一段。
  assert.equal(scene.isWaterAt(player.x, player.z), true, '重放路径已经走出水域，换一格');

  const physics = createClientPhysics(rapier, spawn);
  physics.createCharacter('me', {
    x: anchor.x, y: anchor.y, z: anchor.z, radius: 0.42, halfHeight: 0.42,
  });
  physics.step();

  const perStep = replayOnClient(physics, anchor, inputs, draft, { perStep: true });
  for (let index = 0; index < inputs.length; index += 1) {
    assert.ok(
      distance(perStep[index], authoritative[index]) < 1e-9,
      `第 ${index + 1} 步就和权威分了家：${distance(perStep[index], authoritative[index])}`,
    );
  }

  // 反证：冻住涉水参数会在容差内攒出偏差，攒够了每份快照都要硬拉回一次。
  const frozen = replayOnClient(physics, anchor, inputs, draft, { perStep: false });
  const frozenDrift = distance(frozen.at(-1), authoritative.at(-1));
  assert.ok(
    frozenDrift > RECONCILE_TOLERANCE,
    `冻住涉水参数本应攒出超过容差的偏差，实际只有 ${frozenDrift}`,
  );
  // 冻住的是浮力起伏，所以偏差几乎全在竖直方向上——站着不动也会被拉。
  const vertical = Math.abs(frozen.at(-1).y - authoritative.at(-1).y);
  assert.ok(vertical > frozenDrift * 0.9, '偏差应当主要来自被按住的浮力起伏');

  physics.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PhysicsWorld } from '../shared/physics/PhysicsWorld.mjs';
import type { SnapshotActor } from '../src/network/protocol';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';
import { createTestActorSystem, stepActorFrame } from './renderProxyProbe';

/**
 * Actor 碰撞体只在变了的时候登记（`ClientActorSystem.publishColliders`）。
 *
 * 原来每帧把每个 Actor 的碰撞体在 Rapier 里删掉再建一遍——主线程 `sim-colliders`
 * 那几毫秒就是它。场景里绝大多数 Actor 根本不动：不动的一步都不走，动了的只挪位姿，
 * 形状变了才重建。用一个记账的假物理世界盯这三条。
 */

const crateArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'crate',
  components: {
    render: {
      model: 'line-art-cargo-crate',
      color: '#b68b60',
      accentColor: '#735239',
      length: 0.62,
      width: 0.62,
      height: 0.48,
    },
  },
};

const definition = {
  schemaVersion: 1,
  id: 'crates',
  displayName: '箱子',
  description: 'test',
  capacity: 8,
  sceneComponents: [],
  actors: [],
  actorArchetypes: [crateArchetype],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: false },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
  },
  gameplay: {
    playerActor: { archetypeId: 'player-slime' },
    worldProps: { tree: [], rock: [] },
    bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    spawn: { centerX: 0, centerZ: 0, radius: 0, slots: 8 },
  },
} as unknown as SceneDefinition;

function crateSnapshot(x: number, revision = 1): SnapshotActor {
  return {
    id: 'crate-01',
    archetypeId: 'crate',
    revision,
    transform: { x, y: 0, z: 1, yaw: 0.3 },
  };
}

function physicsSpy() {
  const calls = { set: 0, move: 0, remove: 0, lastMove: undefined as unknown };
  const physics = {
    setActorCollider(_id: string) { calls.set += 1; return []; },
    moveActorCollider(_id: string, definitions: unknown) { calls.move += 1; calls.lastMove = definitions; return true; },
    removeActorCollider(_id: string) { calls.remove += 1; return true; },
  } as unknown as PhysicsWorld;
  return { physics, calls };
}

function createSystem(physics: PhysicsWorld, clock: { now: number }) {
  return createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => clock.now,
    physics,
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
}

test('没动的 Actor 一帧只登记一次，之后每帧一步不走', () => {
  const clock = { now: 1_000 };
  const { physics, calls } = physicsSpy();
  const system = createSystem(physics, clock);
  system.syncSnapshots([crateSnapshot(2)], 1_000);
  stepActorFrame(system, 0, 0);
  assert.equal(calls.set, 1, '第一次登记要建碰撞体');
  assert.equal(calls.move, 0);
  for (let frame = 0; frame < 5; frame += 1) {
    clock.now += 16;
    stepActorFrame(system, 1 / 60, 0.1);
  }
  assert.equal(calls.set, 1, '没动就不重建');
  assert.equal(calls.move, 0, '没动也不挪');
});

test('位姿变了只挪不重建', () => {
  const clock = { now: 1_000 };
  const { physics, calls } = physicsSpy();
  const system = createSystem(physics, clock);
  system.syncSnapshots([crateSnapshot(2)], 1_000);
  stepActorFrame(system, 0, 0);
  system.syncSnapshots([crateSnapshot(5, 2)], 1_500);
  clock.now = 1_800;
  stepActorFrame(system, 1 / 60, 0.8);
  assert.equal(calls.set, 1, '形状没变就不重建');
  assert.ok(calls.move >= 1, '位姿变了要挪');
  const moved = calls.lastMove as { x: number }[];
  assert.equal(moved[0].x, 5, '挪到快照里的新位置');
});

test('挪不动（没登记过）就回落到重建', () => {
  const clock = { now: 1_000 };
  const { physics, calls } = physicsSpy();
  (physics as unknown as { moveActorCollider: () => boolean }).moveActorCollider = () => false;
  const system = createSystem(physics, clock);
  system.syncSnapshots([crateSnapshot(2)], 1_000);
  stepActorFrame(system, 0, 0);
  system.syncSnapshots([crateSnapshot(5, 2)], 1_500);
  clock.now = 1_800;
  stepActorFrame(system, 1 / 60, 0.8);
  assert.equal(calls.set, 2, '挪失败就重建一次');
});

test('Actor 消失时撤掉碰撞体，再出现时重新登记', () => {
  const clock = { now: 1_000 };
  const { physics, calls } = physicsSpy();
  const system = createSystem(physics, clock);
  system.syncSnapshots([crateSnapshot(2)], 1_000);
  stepActorFrame(system, 0, 0);
  system.syncSnapshots([], 1_500);
  clock.now = 1_800;
  stepActorFrame(system, 1 / 60, 0.8);
  assert.equal(calls.remove, 1);
  system.syncSnapshots([crateSnapshot(2, 3)], 2_000);
  clock.now = 2_300;
  stepActorFrame(system, 1 / 60, 1.3);
  assert.equal(calls.set, 2, '重新出现要重新登记');
});

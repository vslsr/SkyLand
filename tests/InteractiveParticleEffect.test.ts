import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import { InteractiveParticleEffectActor } from '../src/actors/InteractiveParticleEffectActor';
import { InteractiveParticleEffectSystem } from '../src/actors/systems/InteractiveParticleEffectSystem';
import { InteractiveParticleEffectHost } from '../src/particles/InteractiveParticleEffectHost';
import { createLineArtLeafGeometry, LINE_ART_LEAF_GEOMETRY_STATS } from '../src/models/particles/lineArtLeaf';
import {
  LINE_ART_LEAF_PARTICLE_LIMITS,
  LineArtLeafParticleEffect,
} from '../src/particles/LineArtLeafParticleEffect';
import { generateInteractiveParticleWorldPoint } from '../src/particles/interactiveParticleWorld';

const environment = { fogColor: '#fdfbf6', fogNear: 22, fogFar: 52 };

const GROUND_CLEARANCE = 0.035;

function createEffect(
  seed = 7,
  particleCount = 32,
  surface?: {
    origin: readonly [number, number, number];
    sampleSurfaceHeight: (worldX: number, worldZ: number) => number;
  },
): LineArtLeafParticleEffect {
  return new LineArtLeafParticleEffect({
    particleCount,
    radius: 4,
    seed,
    fillColor: '#d6a45b',
    accentColor: '#bd7041',
    lineColor: '#493426',
    environment,
    ...surface,
  });
}

function settle(effect: LineArtLeafParticleEffect, seconds = 12): void {
  const frames = Math.round(seconds * 60);
  for (let frame = 0; frame < frames; frame += 1) effect.update(1 / 60, frame / 60);
}

/** 逐叶片高度存在 Float32Array 里，比较时按 float32 精度留出余量。 */
function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}：得到 ${actual}，应当是 ${expected}`);
}

test('line-art leaf keeps a small filled shape and a real EdgesGeometry outline', () => {
  const geometry = createLineArtLeafGeometry();
  assert.equal(
    geometry.fill.getAttribute('position').count,
    LINE_ART_LEAF_GEOMETRY_STATS.vertexCount,
  );
  assert.equal(
    geometry.fill.index?.count,
    LINE_ART_LEAF_GEOMETRY_STATS.triangleCount * 3,
  );
  assert.ok(geometry.outline.getAttribute('position').count > 0);
  geometry.fill.dispose();
  geometry.outline.dispose();
});

test('one Actor owns a bounded instanced leaf group with deterministic initial state', () => {
  const first = createEffect(91);
  const second = createEffect(91);
  const actor = new InteractiveParticleEffectActor('local-leaf-field', first);
  const fill = actor.object3D.getObjectByName('interactive-leaf-fill') as THREE.Mesh;
  const outline = actor.object3D.getObjectByName('interactive-leaf-outline') as THREE.LineSegments;

  assert.deepEqual(first.getParticleState(0), second.getParticleState(0));
  assert.equal((fill.geometry as THREE.InstancedBufferGeometry).instanceCount, 32);
  assert.equal((outline.geometry as THREE.InstancedBufferGeometry).instanceCount, 32);
  assert.throws(
    () => createEffect(1, LINE_ART_LEAF_PARTICLE_LIMITS.maximumParticleCount + 1),
    /落叶数量/,
  );

  actor.dispose();
  second.dispose();
});

test('a swept player impulse wakes nearby leaves without creating particle Actors', () => {
  const effect = createEffect(17);
  const actor = new InteractiveParticleEffectActor('interactive-leaf-field', effect);
  const world = new ActorWorld();
  world.addSystem(new InteractiveParticleEffectSystem());
  world.addActor(actor);
  const before = effect.getParticleState(0);
  const affected = actor.applyWorldImpulse({
    startPosition: {
      x: before.positionX - 0.1,
      y: 0,
      z: before.positionZ,
    },
    position: {
      x: before.positionX + 0.1,
      y: 0,
      z: before.positionZ,
    },
    radius: 0.35,
    strength: 3,
  });
  const kicked = effect.getParticleState(0);

  assert.ok(affected >= 1);
  assert.ok(kicked.velocityY > before.velocityY);
  assert.equal(world.size, 1);
  world.update(1 / 60, 1);
  assert.ok(effect.getParticleState(0).positionY >= before.positionY);

  world.dispose();
  assert.equal(actor.object3D.children.length, 0);
});

test('large focus jumps do not sweep an interaction across the whole world', () => {
  const effect = createEffect(23);
  const state = effect.getParticleState(0);
  const affected = effect.applyWorldImpulse({
    startPosition: { x: state.positionX, y: 0, z: state.positionZ },
    position: { x: 10_000, y: 0, z: -10_000 },
    radius: 0.5,
    strength: 5,
  });

  assert.equal(affected, 0);
  effect.dispose();
});

test('streamed leaf clusters are deterministic and stay inside negative-coordinate chunks', () => {
  const first = generateInteractiveParticleWorldPoint(0x12345678, 91, -2, 3, 1, 4.5);
  const second = generateInteractiveParticleWorldPoint(0x12345678, 91, -2, 3, 1, 4.5);
  assert.deepEqual(first, second);
  assert.ok(first);
  assert.ok(first.x >= -64 + 4.5 && first.x <= -32 - 4.5);
  assert.ok(first.z >= 96 + 4.5 && first.z <= 128 - 4.5);

  assert.equal(
    generateInteractiveParticleWorldPoint(0x12345678, 91, -2, 3, 0, 4.5),
    undefined,
  );
});

test('streamed leaf clusters stay bounded and discard old chunks after a large focus jump', () => {
  const mounted = new Set<THREE.Object3D>();
  let focus = { focusX: 0, focusY: 0, focusZ: 0 };
  const renderer = {
    environmentRuntime: undefined,
    addWorldObject: (object: THREE.Object3D) => mounted.add(object),
    removeWorldObject: (object: THREE.Object3D) => mounted.delete(object),
  };
  // 地形采样搬去 SceneWorld 了：渲染器只剩渲染核心（实现路径文档 §3）。
  const world = {
    isWaterAt: () => false,
    sampleGroundHeight: () => 0,
    sampleSurfaceHeight: () => 0,
    onTerrainChanged: () => () => undefined,
  };
  const definition = {
    type: 'interactive-particle-effect',
    id: 'streamed-leaves',
    preset: 'line-art-leaves',
    worldGeneration: { spawnChance: 1 },
    particleCount: 16,
    clusterRadius: 4,
    seed: 91,
    fillColor: '#d6a45b',
    accentColor: '#bd7041',
    lineColor: '#493426',
    interactionRadius: 0.9,
    impulseStrength: 3.4,
  } as const;
  // 落叶归渲染世界建，收的是几个数和一块地形，不再是主线程的渲染器与 SceneWorld
  //（实现路径文档 §3）。挂载点因此是它自己的根，不是 renderer.addWorldObject。
  const root = new THREE.Group();
  const component = new InteractiveParticleEffectHost(definition, {
    sceneDefinition: {
      renderer: {
        fog: { color: '#fdfbf6', near: 22, far: 52 },
        world: { loadRadius: 2, keepRadius: 3 },
      },
    } as never,
    worldSeed: 0x12345678,
    root,
    terrain: world,
  });

  component.activate();
  for (let frame = 0; frame < 30; frame += 1) component.update(1 / 60, frame / 60, focus);
  assert.equal(root.children.length, 25);

  focus = { focusX: 160, focusY: 0, focusZ: 0 };
  component.update(1 / 60, 1, focus);
  assert.ok(
    root.children.length <= 6,
    '传送后只保留 keepRadius 边缘的迟滞列，并且每帧只补一个新 chunk',
  );
  for (let frame = 0; frame < 30; frame += 1) component.update(1 / 60, 2 + frame / 60, focus);
  assert.ok(root.children.length <= 49, '常驻落叶团始终受 keepRadius 的 7×7 chunk 窗口约束');

  component.dispose();
  assert.equal(root.children.length, 0);
});

test('每片落叶落在自己脚下的地表，而不是整团挂在落点中心的高度', () => {
  // 台阶地形：落点中心在高台上，落叶团有一半悬在低了一层的地面之上。
  const terrainHeight = (worldX: number) => (worldX < 0 ? 6 : 7);
  const origin: readonly [number, number, number] = [0, 7, 0];
  const effect = createEffect(41, 96, {
    origin,
    sampleSurfaceHeight: (worldX) => terrainHeight(worldX),
  });

  assert.deepEqual(effect.root.position.toArray(), [0, 7, 0]);
  settle(effect);

  let lowSideLeaves = 0;
  for (let index = 0; index < 96; index += 1) {
    const state = effect.getParticleState(index);
    const worldX = origin[0] + state.positionX;
    assertClose(
      origin[1] + state.positionY,
      terrainHeight(worldX) + GROUND_CLEARANCE,
      `第 ${index} 片落叶的停留高度`,
    );
    if (worldX < 0) lowSideLeaves += 1;
  }
  assert.ok(lowSideLeaves > 0, '这一团必须真的跨过台阶，否则用例没有覆盖到高低差');

  effect.dispose();
});

test('没有地表采样时整团退回原来的平面表现', () => {
  const effect = createEffect(41, 24);
  settle(effect);
  for (let index = 0; index < 24; index += 1) {
    assertClose(effect.getParticleState(index).groundY, GROUND_CLEARANCE, '静止高度');
  }
  effect.dispose();
});

test('地形被改写后落叶重新贴地：抬高直接托起，挖低则重新下落', () => {
  let level = 0;
  const effect = createEffect(53, 24, {
    origin: [0, 0, 0],
    sampleSurfaceHeight: () => level,
  });
  settle(effect);

  // 别处的地形改写也会广播到这一团；脚下没变就不该把静止的落叶重新叫醒。
  effect.refreshSurfaceHeights();
  for (let index = 0; index < 24; index += 1) {
    assert.equal(effect.getParticleState(index).active, false);
  }

  level = 2;
  effect.refreshSurfaceHeights();
  for (let index = 0; index < 24; index += 1) {
    const state = effect.getParticleState(index);
    assertClose(state.groundY, 2 + GROUND_CLEARANCE, '抬高后的静止高度');
    assert.ok(state.positionY >= 2, '抬高的地面不能把落叶埋在下面');
  }

  level = -3;
  effect.refreshSurfaceHeights();
  assert.ok(
    effect.getParticleState(0).active,
    '脚下被挖空的落叶要交还给模拟，自己落到新的地表',
  );
  settle(effect);
  for (let index = 0; index < 24; index += 1) {
    assertClose(
      effect.getParticleState(index).positionY,
      -3 + GROUND_CLEARANCE,
      `第 ${index} 片落叶挖低后的停留高度`,
    );
  }

  effect.dispose();
});

test('被踢起的落叶按落点当地的地表停下，而不是起飞点的高度', () => {
  const terrainHeight = (worldX: number) => (worldX < 1 ? 0 : -1.5);
  const effect = createEffect(67, 48, {
    origin: [0, 0, 0],
    sampleSurfaceHeight: (worldX) => terrainHeight(worldX),
  });
  settle(effect);

  effect.applyWorldImpulse({
    startPosition: { x: -0.6, y: 0, z: 0 },
    position: { x: 0.6, y: 0, z: 0 },
    radius: 2.5,
    strength: 12,
  });
  settle(effect);

  let crossedLeaves = 0;
  for (let index = 0; index < 48; index += 1) {
    const state = effect.getParticleState(index);
    assertClose(
      state.positionY,
      terrainHeight(state.positionX) + GROUND_CLEARANCE,
      `第 ${index} 片落叶被踢开后的停留高度`,
    );
    if (state.positionX >= 1) crossedLeaves += 1;
  }
  assert.ok(crossedLeaves > 0, '至少要有落叶被踢到低一层的地面上');

  effect.dispose();
});

test('落叶团在停用时释放地形订阅，不把监听器留在旧场景里', () => {
  const listeners = new Set<() => void>();
  const renderer = {
    environmentRuntime: undefined,
    addWorldObject: () => undefined,
    removeWorldObject: () => undefined,
  };
  let level = 0;
  const world = {
    isWaterAt: () => false,
    sampleGroundHeight: () => level,
    sampleSurfaceHeight: () => level,
    onTerrainChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const definition = {
    type: 'interactive-particle-effect',
    id: 'fixed-leaves',
    preset: 'line-art-leaves',
    position: [0, 0, 0],
    particleCount: 12,
    clusterRadius: 4,
    seed: 91,
    fillColor: '#d6a45b',
    accentColor: '#bd7041',
    lineColor: '#493426',
    interactionRadius: 0.9,
    impulseStrength: 3.4,
  } as const;
  const component = new InteractiveParticleEffectHost(definition, {
    sceneDefinition: {
      renderer: { fog: { color: '#fdfbf6', near: 22, far: 52 } },
    } as never,
    root: new THREE.Group(),
    terrain: world,
  });

  component.activate();
  assert.equal(listeners.size, 1);
  level = 4;
  for (const listener of listeners) listener();
  component.deactivate();
  assert.equal(listeners.size, 0, '停用后不能再持有上一张地图的地形订阅');

  component.dispose();
});

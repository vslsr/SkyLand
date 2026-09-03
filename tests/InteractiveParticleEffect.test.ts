import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import { InteractiveParticleEffectActor } from '../src/actors/InteractiveParticleEffectActor';
import { InteractiveParticleEffectSystem } from '../src/actors/systems/InteractiveParticleEffectSystem';
import { InteractiveParticleEffectSceneComponent } from '../src/scene/components/InteractiveParticleEffectSceneComponent';
import { createLineArtLeafGeometry, LINE_ART_LEAF_GEOMETRY_STATS } from '../src/models/particles/lineArtLeaf';
import {
  LINE_ART_LEAF_PARTICLE_LIMITS,
  LineArtLeafParticleEffect,
} from '../src/particles/LineArtLeafParticleEffect';
import { generateInteractiveParticleWorldPoint } from '../src/particles/interactiveParticleWorld';

const environment = { fogColor: '#fdfbf6', fogNear: 22, fogFar: 52 };

function createEffect(seed = 7, particleCount = 32): LineArtLeafParticleEffect {
  return new LineArtLeafParticleEffect({
    particleCount,
    radius: 4,
    seed,
    fillColor: '#d6a45b',
    accentColor: '#bd7041',
    lineColor: '#493426',
    environment,
  });
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
  const component = new InteractiveParticleEffectSceneComponent(definition, {
    definition: {
      renderer: {
        fog: { color: '#fdfbf6', near: 22, far: 52 },
        world: { loadRadius: 2, keepRadius: 3 },
      },
    } as never,
    renderer: renderer as never,
    world: world as never,
    worldSeed: 0x12345678,
    getFocus: () => focus,
  } as never);

  component.activate();
  for (let frame = 0; frame < 30; frame += 1) component.update(1 / 60, frame / 60);
  assert.equal(mounted.size, 25);

  focus = { focusX: 160, focusY: 0, focusZ: 0 };
  component.update(1 / 60, 1);
  assert.ok(
    mounted.size <= 6,
    '传送后只保留 keepRadius 边缘的迟滞列，并且每帧只补一个新 chunk',
  );
  for (let frame = 0; frame < 30; frame += 1) component.update(1 / 60, 2 + frame / 60);
  assert.ok(mounted.size <= 49, '常驻落叶团始终受 keepRadius 的 7×7 chunk 窗口约束');

  component.dispose();
  assert.equal(mounted.size, 0);
});

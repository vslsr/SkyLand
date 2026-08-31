import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import { InteractiveParticleEffectActor } from '../src/actors/InteractiveParticleEffectActor';
import { InteractiveParticleEffectSystem } from '../src/actors/systems/InteractiveParticleEffectSystem';
import { createLineArtLeafGeometry, LINE_ART_LEAF_GEOMETRY_STATS } from '../src/models/particles/lineArtLeaf';
import {
  LINE_ART_LEAF_PARTICLE_LIMITS,
  LineArtLeafParticleEffect,
} from '../src/particles/LineArtLeafParticleEffect';

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

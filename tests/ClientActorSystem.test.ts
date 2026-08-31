import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUOYANCY_COMPONENT,
  type BuoyancyComponent,
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../shared/actor/index.mjs';
import { ClientActorSystem } from '../src/actors/ClientActorSystem';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../src/actors/components/ThreeObjectComponent';
import type { SnapshotActor } from '../src/network/protocol';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';

const ocean = {
  size: 32,
  segments: 8,
  waveHeight: 0.32,
  waveSpeed: 0.82,
  noiseScale: 0.085,
  noiseStrength: 1.15,
  interlaceStrength: 0.42,
  surfaceColor: '#d7e7e5',
  secondaryColor: '#c6dcdb',
  gridLineColor: '#617f82',
  gridLineOpacity: 0.28,
};

const raftArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'raft',
  components: {
    buoyancy: {
      minimumBeam: 3.2,
      minimumLength: 4.8,
      maximumTrimRadians: 0.09,
      minimumDraft: 0.08,
      maximumDraft: 0.28,
      parts: [
        { id: 'hull', mass: 10, buoyancy: 20, integrity: 1, localX: 0, localZ: 0 },
      ],
    },
    render: {
      model: 'line-art-raft',
      foamColor: '#fffdf7',
      length: 4.8,
      width: 3.2,
    },
  },
};

const definition = {
  schemaVersion: 1,
  id: 'water',
  displayName: '水域',
  description: 'test',
  capacity: 8,
  actors: [{ id: 'demo-raft-01', archetypeId: 'raft', position: [0, 0, 0], yaw: 0.24 }],
  actorArchetypes: [raftArchetype],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: true },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
    ocean,
  },
  gameplay: {
    bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    spawn: { centerX: 0, centerZ: 0, radius: 0, slots: 8 },
    water: { seaLevel: 0 },
  },
  camera: { mode: 'fly', position: [0, 5, 10], yaw: 0, pitch: 0, moveSpeed: 8 },
} satisfies SceneDefinition;

const snapshot: SnapshotActor = {
  id: 'demo-raft-01',
  archetypeId: 'raft',
  revision: 1,
  transform: { x: 2, y: 0, z: -3, yaw: 0.4 },
  buoyancy: {
    state: 'afloat',
    draft: 0.21,
    staticRoll: -0.01,
    staticPitch: 0.02,
    speedFactor: 1,
  },
};

test('客户端收到快照后才创建 Actor Replica 并应用权威 Component 状态', () => {
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
  });
  assert.equal(system.getActor(snapshot.id), undefined);

  system.syncSnapshots([snapshot]);
  system.update(0, 0);

  const actor = system.getActor(snapshot.id)!;
  const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT) as BuoyancyComponent;
  const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  assert.deepEqual([transform.x, transform.y, transform.z, transform.yaw], [2, 0, -3, 0.4]);
  assert.equal(buoyancy.draft, 0.21);
  assert.equal(render.root.position.x, 2);
  assert.equal(render.root.position.z, -3);
  assert.equal(render.root.rotation.y, 0.4);
  assert.ok(system.root.getObjectByName('actor-demo-raft-01-visual'));
});

test('视觉波动只作用于 VisualRoot，且快照移除会销毁 Replica', () => {
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
  });
  system.syncSnapshots([snapshot]);
  system.update(1 / 60, 1.25);

  const actor = system.getActor(snapshot.id)!;
  const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  assert.equal(render.root.position.y, snapshot.transform.y);
  assert.ok(Number.isFinite(render.visualRoot.position.y));
  assert.notEqual(render.visualRoot.position.y, render.root.position.y);
  assert.ok(Math.abs(render.visualRoot.rotation.x) <= 0.07 + Number.EPSILON);
  assert.ok(Math.abs(render.visualRoot.rotation.z) <= 0.09 + Number.EPSILON);

  system.syncSnapshots([]);
  assert.equal(system.getActor(snapshot.id), undefined);
  assert.equal(system.root.children.length, 0);
});

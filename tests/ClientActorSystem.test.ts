import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  BUOYANCY_COMPONENT,
  type BuoyancyComponent,
  SIMPLE_COLLISION_COMPONENT,
  type SimpleCollisionComponent,
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
    vesselMotor: {
      maximumForwardSpeed: 4.2,
      maximumReverseSpeed: 1.6,
      acceleration: 2.4,
      deceleration: 3.2,
      drag: 1.1,
      turnSpeed: 0.85,
      inputTimeoutMs: 300,
    },
    render: {
      model: 'line-art-raft',
      foamColor: '#fffdf7',
      length: 4.8,
      width: 3.2,
    },
  },
};

const deckPropArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'deck-prop',
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
  id: 'water',
  displayName: '水域',
  description: 'test',
  capacity: 8,
  sceneComponents: [],
  actors: [{
    id: 'demo-raft-01',
    archetypeId: 'raft',
    parentActorId: null,
    localTransform: { position: [0, 0, 0], yaw: 0.24 },
  }],
  actorArchetypes: [raftArchetype, deckPropArchetype],
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
    cargoMass: 0,
    damagedPartCount: 0,
    eventRevision: 0,
    lastEvent: null,
  },
  vessel: { speed: 0, throttle: 0, steering: 0 },
  control: { ownerPlayerId: null, revision: 0 },
};

function createDeckPropSnapshot(localX = 0.72): SnapshotActor {
  const localZ = -0.55;
  return {
    id: 'raft-deck-prop-01',
    archetypeId: 'deck-prop',
    parentActorId: snapshot.id,
    revision: 1,
    transform: {
      x: snapshot.transform.x + Math.cos(snapshot.transform.yaw) * localX
        + Math.sin(snapshot.transform.yaw) * localZ,
      y: 0.62,
      z: snapshot.transform.z - Math.sin(snapshot.transform.yaw) * localX
        + Math.cos(snapshot.transform.yaw) * localZ,
      yaw: snapshot.transform.yaw - 0.1,
    },
    localTransform: { x: localX, y: 0.62, z: localZ, yaw: -0.1 },
  };
}

test('客户端收到快照后才创建 Actor Replica 并应用权威 Component 状态', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
  });
  assert.equal(system.getActor(snapshot.id), undefined);

  system.syncSnapshots([snapshot], 1_000);
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
  const collision = actor.requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent;
  assert.equal(collision.halfWidth, 1.6);
  assert.equal(collision.halfLength, 2.4);

  const resolved = system.resolveSimpleCollision({ x: 2, z: -3 }, 0.42);
  assert.ok(Math.hypot(resolved.x - 2, resolved.z + 3) > 1.6);
  system.setSimpleCollisionVisible(true);
  assert.equal(render.simpleCollisionVisible, true);
  assert.ok(render.root.getObjectByName('actor-simple-collision-helper'));

  const owned = { ...snapshot, control: { ownerPlayerId: 'player-1', revision: 1 } };
  now = 1_100;
  system.syncSnapshots([owned], 1_100);
  now = 1_230;
  system.update(0, 0);
  assert.equal(system.findOwnedActorId('player-1'), snapshot.id);
  assert.equal(system.findControllableActorId(), undefined);
});

test('视觉波动只作用于 VisualRoot，且快照移除会销毁 Replica', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
  });
  system.syncSnapshots([snapshot], 1_000);
  system.update(1 / 60, 1.25);

  const actor = system.getActor(snapshot.id)!;
  const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  assert.equal(render.root.position.y, snapshot.transform.y);
  assert.ok(Number.isFinite(render.visualRoot.position.y));
  assert.notEqual(render.visualRoot.position.y, render.root.position.y);
  assert.ok(Math.abs(render.visualRoot.rotation.x) <= 0.07 + Number.EPSILON);
  assert.ok(Math.abs(render.visualRoot.rotation.z) <= 0.09 + Number.EPSILON);

  now = 1_100;
  system.syncSnapshots([], 1_100);
  now = 1_230;
  system.update(0, 1.3);
  assert.equal(system.getActor(snapshot.id), undefined);
  assert.equal(system.root.children.length, 0);
});

test('Actor Transform 在两份服务端快照之间插值而不做客户端外推', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
  });
  const from = { ...snapshot, transform: { x: 0, y: 0, z: 0, yaw: 0 } };
  const to = {
    ...snapshot,
    transform: { x: 10, y: 2, z: -4, yaw: Math.PI / 2 },
    vessel: { speed: 4, throttle: 1, steering: 0.5 },
  };
  system.syncSnapshots([from], 1_000, 1_000);
  now = 1_100;
  system.syncSnapshots([to], 1_100, 1_100);
  now = 1_170;
  system.update(0, 0);

  const actor = system.getActor(snapshot.id)!;
  const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  assert.ok(Math.abs(transform.x - 5) < 1e-6);
  assert.ok(Math.abs(transform.z + 2) < 1e-6);
  assert.ok(Math.abs(transform.yaw - Math.PI / 4) < 1e-6);
});

test('客户端离散恢复父子关系，并只插值子 Actor 的权威世界坐标', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
  });
  const childFrom = createDeckPropSnapshot(0.72);

  // 故意把子节点放在父节点前，验证快照顺序不影响层级恢复。
  system.syncSnapshots([childFrom, snapshot], 1_000, 1_000);
  system.update(1 / 60, 1.25);

  const parent = system.getActor(snapshot.id)!;
  const child = system.getActor(childFrom.id)!;
  const parentRender = parent.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  const childRender = child.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  const childTransform = child.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  let childGeometry: THREE.BufferGeometry | undefined;
  childRender.root.traverse((object) => {
    childGeometry ??= (object as THREE.Mesh).geometry;
  });
  assert.ok(childGeometry);
  const originalDispose = childGeometry.dispose.bind(childGeometry);
  let childGeometryDisposeCount = 0;
  childGeometry.dispose = () => {
    childGeometryDisposeCount += 1;
    originalDispose();
  };
  assert.equal(child.parent, parent);
  assert.deepEqual(parent.children, [child]);
  assert.equal(childRender.root.parent, parentRender.root);
  assert.ok(Math.abs(childRender.root.position.x - 0.72) < 1e-9);
  assert.ok(Math.abs(childRender.root.position.y - 0.62) < 1e-9);
  assert.ok(Math.abs(childRender.root.position.z + 0.55) < 1e-9);
  assert.ok(Math.abs(childRender.root.rotation.y + 0.1) < 1e-9);
  assert.ok(Math.abs(childTransform.x - childFrom.transform.x) < 1e-9);
  assert.ok(
    childRender.attachmentVisualRoot.position.lengthSq() > 1e-9
      || Math.abs(childRender.attachmentVisualRoot.quaternion.w - 1) > 1e-9,
  );

  const childTo = createDeckPropSnapshot(1.72);
  now = 1_100;
  system.syncSnapshots([snapshot, childTo], 1_100, 1_100);
  now = 1_170;
  system.update(0, 1.3);
  assert.ok(Math.abs(childRender.root.position.x - 1.22) < 1e-9);
  assert.equal(childTransform.localX, 1.72);
  parentRender.root.updateWorldMatrix(true, true);
  const childWorld = childRender.root.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(childWorld.x - childTransform.x) < 1e-9);
  assert.ok(Math.abs(childWorld.y - childTransform.y) < 1e-9);
  assert.ok(Math.abs(childWorld.z - childTransform.z) < 1e-9);

  // 服务端删除父节点时采用默认策略：子节点解除挂载并保持世界坐标。
  const detached = { ...childTo, parentActorId: null };
  now = 1_200;
  system.syncSnapshots([detached], 1_200, 1_200);
  now = 1_330;
  system.update(0, 1.4);
  assert.equal(system.getActor(parent.id), undefined);
  assert.equal(system.getActor(child.id)?.parent, undefined);
  assert.equal(childRender.root.parent, system.root);
  assert.equal(childGeometryDisposeCount, 0);

  now = 1_400;
  system.syncSnapshots([], 1_400, 1_400);
  now = 1_530;
  system.update(0, 1.5);
  assert.equal(system.getActor(child.id), undefined);
  assert.equal(childGeometryDisposeCount, 1);
});

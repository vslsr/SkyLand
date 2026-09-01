import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  BUOYANCY_COMPONENT,
  type BuoyancyComponent,
  COMBUSTIBLE_COMPONENT,
  type CombustibleComponent,
  GENERATED_TREE_COMPONENT,
  type GeneratedTreeComponent,
  ITEM_STACK_COMPONENT,
  type ItemStackComponent,
  SIMPLE_COLLISION_COMPONENT,
  type SimpleCollisionComponent,
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../shared/actor/index.mjs';
import { CollisionWorld } from '../shared/collision/index.mjs';
import {
  PROP_BUFFER_LENGTH,
  PROP_FIELD,
  PROP_STRIDE,
  generateChunkProps,
} from '../shared/world/chunkContent.mjs';
import { readChunkColliders } from '../shared/world/chunkColliders.mjs';
import { formatGeneratedTreeId } from '../shared/world/generatedTree.mjs';
import { DEFAULT_WORLD_SEED, PROP_KIND } from '../shared/world/worldConfig.mjs';
import { ClientActorSystem } from '../src/actors/ClientActorSystem';
import {
  THREE_OBJECT_COMPONENT,
  type ThreeObjectComponent,
} from '../src/actors/components/ThreeObjectComponent';
import {
  FIRE_VISUAL_COMPONENT,
  type FireVisualComponent,
} from '../src/actors/components/FireVisualComponent';
import {
  TEMPERATURE_MARKER_COMPONENT,
  type TemperatureMarkerComponent,
} from '../src/actors/components/TemperatureMarkerComponent';
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

const trainingDummyArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'training-dummy',
  components: {
    render: {
      model: 'line-art-training-dummy',
      woodColor: '#b58c63',
      accentColor: '#e0c6a4',
      radius: 0.82,
      height: 2.22,
    },
  },
};

const focusObeliskArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'arcane-focus-obelisk',
  components: {
    render: {
      model: 'line-art-focus-obelisk',
      stoneColor: '#d8cfb9',
      crystalColor: '#c9bad9',
      radius: 0.36,
      height: 2.32,
    },
  },
};

const floorPlaqueArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'ability-floor-plaque',
  components: {
    render: {
      model: 'line-art-floor-plaque',
      color: '#f7f0df',
      accentColor: '#8e5f47',
      width: 3.8,
      length: 1.1,
      height: 0.12,
    },
  },
};

const campfireArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'campfire',
  components: {
    heatEmitter: { power: 520, radius: 3.2, enabled: true },
    render: {
      model: 'line-art-campfire',
      stoneColor: '#c8c0b2',
      woodColor: '#79513a',
      emberColor: '#c95d32',
      radius: 0.65,
      height: 0.45,
    },
  },
};

const dryHayArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'dry-hay',
  components: {
    temperature: {
      initialTemperature: 20,
      ambientTemperature: 20,
      heatCapacity: 10,
      coolingRate: 0.08,
    },
    combustible: {
      ignitionTemperature: 75,
      extinguishTemperature: 45,
      fuel: 60,
      burnRate: 0.5,
      heatOutput: 340,
      heatRadius: 2.2,
    },
    render: {
      model: 'line-art-dry-hay',
      color: '#d6b765',
      accentColor: '#846438',
      radius: 0.45,
      height: 0.72,
    },
  },
};

const woodPileArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'wood-pile',
  components: {
    interactable: { action: 'pickup-stack', label: '木材', maximumDistance: 2.4 },
    itemStack: {
      itemType: 'wood', displayName: '木材', defaultQuantity: 1,
      maximumQuantity: 999, compatibilityKey: 'wood-standard',
    },
    actorResidency: { sleepDelaySeconds: 1, dormantDelaySeconds: 3, dormantEligible: true },
    dropMotion: { gravity: 9.8, drag: 5, settleSpeed: 0.08 },
    lifetime: { lifetimeSeconds: 900 },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
    temperature: { initialTemperature: 20, ambientTemperature: 20, heatCapacity: 8, coolingRate: 0.18 },
    combustible: {
      ignitionTemperature: 260, extinguishTemperature: 180, fuel: 90,
      burnRate: 1.2, heatOutput: 110, heatRadius: 2.2,
    },
    render: {
      model: 'line-art-wood-pile', woodColor: '#b98558', cutColor: '#e6c89c',
      inkColor: '#51463e', radius: 0.55, height: 0.38,
    },
  },
};

const generatedTreeArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'generated-tree',
  components: {
    interactable: { action: 'chop-tree', label: '树木', maximumDistance: 2.6 },
    generatedTree: { maximumHealth: 3, chopDamage: 1, woodQuantity: 5 },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
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
  actorArchetypes: [
    raftArchetype,
    deckPropArchetype,
    trainingDummyArchetype,
    focusObeliskArchetype,
    floorPlaqueArchetype,
    campfireArchetype,
    dryHayArchetype,
    woodPileArchetype,
    generatedTreeArchetype,
  ],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: true },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
    ocean,
  },
  gameplay: {
    playerActor: { archetypeId: 'player-slime' },
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

const trainingDummySnapshot: SnapshotActor = {
  id: 'training-dummy-01',
  archetypeId: 'training-dummy',
  revision: 0,
  transform: { x: 0, y: 0, z: -1.5, yaw: 0 },
};

const focusObeliskSnapshot: SnapshotActor = {
  id: 'arcane-focus-01',
  archetypeId: 'arcane-focus-obelisk',
  revision: 0,
  transform: { x: -2.1, y: 0, z: -1.5, yaw: 0 },
};

const floorPlaqueSnapshot: SnapshotActor = {
  id: 'ability-floor-plaque-01',
  archetypeId: 'ability-floor-plaque',
  revision: 0,
  transform: { x: 0, y: 0, z: -3.6, yaw: 0 },
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

test('能力实验室对象由 Actor 快照创建，训练假人暴露 visualRoot 内的目标 rig', () => {
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
  });
  system.syncSnapshots([
    trainingDummySnapshot,
    focusObeliskSnapshot,
    floorPlaqueSnapshot,
  ], 1_000);
  system.update(0, 0);

  const actor = system.getActor(trainingDummySnapshot.id)!;
  const render = actor.requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  assert.equal(actor.archetypeId, 'training-dummy');
  assert.ok(render.abilityTargetRig);
  assert.equal(render.abilityTargetRig.targetRoot, render.visualRoot);
  assert.equal(render.abilityTargetRig.burningAura.visible, false);
  assert.equal(render.root.position.z, -1.5);
  const focusRender = system.getActor(focusObeliskSnapshot.id)!
    .requireComponent(THREE_OBJECT_COMPONENT) as ThreeObjectComponent;
  assert.ok(focusRender.root.getObjectByName('focus-obelisk-crystal'));
  const plaqueCollision = system.getActor(floorPlaqueSnapshot.id)!
    .requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent;
  assert.equal(plaqueCollision.halfWidth, 1.9);
  assert.equal(plaqueCollision.halfLength, 0.55);
  system.dispose();
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

test('客户端按权威燃烧状态显示参考 LineLoop 火焰，稳定篝火始终可见', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
  });
  const campfire: SnapshotActor = {
    id: 'campfire-01',
    archetypeId: 'campfire',
    revision: 0,
    transform: { x: 0, y: 0, z: -1.5, yaw: 0 },
  };
  const coldHay: SnapshotActor = {
    id: 'dry-hay-01',
    archetypeId: 'dry-hay',
    revision: 0,
    transform: { x: 1.4, y: 0, z: -1.5, yaw: 0 },
    thermal: { temperature: 20, burning: false, fuelRatio: 1, revision: 0 },
  };
  system.syncSnapshots([campfire, coldHay], 1_000, 1_000);
  system.update(1 / 60, 0.5);

  const campfireFire = system.getActor(campfire.id)!
    .requireComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent;
  const hayActor = system.getActor(coldHay.id)!;
  const hayFire = hayActor.requireComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent;
  const temperatureMarker = hayActor.requireComponent(
    TEMPERATURE_MARKER_COMPONENT,
  ) as TemperatureMarkerComponent;
  assert.equal(campfireFire.rig.root.visible, true);
  assert.equal(hayFire.rig.root.visible, false);
  assert.equal(temperatureMarker.visible, false);
  assert.equal(temperatureMarker.label, '');
  assert.equal(campfireFire.rig.flames.length, 5);
  assert.equal(campfireFire.rig.sparks.length, 6);

  system.setTemperatureVisible(true);
  assert.equal(temperatureMarker.visible, true);
  assert.equal(temperatureMarker.label, '20.0 °C');
  assert.ok(hayActor.requireComponent(THREE_OBJECT_COMPONENT)
    .root.getObjectByName('actor-temperature-marker'));
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 4, 7);
  system.beforeRender({} as THREE.WebGLRenderer, camera);

  const burningHay: SnapshotActor = {
    ...coldHay,
    revision: 4,
    thermal: { temperature: 78.4, burning: true, fuelRatio: 0.99, revision: 4 },
  };
  now = 1_100;
  system.syncSnapshots([campfire, burningHay], 1_100, 1_100);
  now = 1_230;
  system.update(0.1, 0.6);

  const combustible = hayActor.requireComponent(COMBUSTIBLE_COMPONENT) as CombustibleComponent;
  assert.equal(combustible.burning, true);
  assert.equal(hayFire.rig.root.visible, true);
  assert.equal(temperatureMarker.label, '78.4 °C');
  assert.equal(hayFire.rig.flames.length, 4);
  assert.equal(hayFire.rig.sparks.length, 4);
  const flameTop = Math.max(...hayFire.rig.flames.map((flame) => (
    hayFire.rig.root.position.y
      + (flame.y + flame.height) * hayFire.rig.root.scale.y
  )));
  assert.ok(flameTop > dryHayArchetype.components.render.height);
  const flameOrigins = hayFire.rig.flames.map((flame) => (
    new THREE.Vector3(flame.x, flame.y, flame.z)
  ));
  let minimumOriginDistance = Number.POSITIVE_INFINITY;
  for (let left = 0; left < flameOrigins.length; left += 1) {
    for (let right = left + 1; right < flameOrigins.length; right += 1) {
      minimumOriginDistance = Math.min(
        minimumOriginDistance,
        flameOrigins[left].distanceTo(flameOrigins[right]),
      );
    }
  }
  assert.ok(minimumOriginDistance > dryHayArchetype.components.render.radius * 0.22);
  const positions = hayFire.rig.flames[0].position.array as Float32Array;
  assert.ok(positions.some((value) => Math.abs(value) > 1e-5));
  system.setTemperatureVisible(false);
  assert.equal(temperatureMarker.visible, false);
  system.dispose();
});

test('高数量物品 Actor 保留交互与碰撞身份，但用批次绘制而没有独立 Object3D', () => {
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
  });
  const wood: SnapshotActor = {
    id: 'drop-1',
    archetypeId: 'wood-pile',
    revision: 2,
    transform: { x: 1, y: 0, z: 2, yaw: 0.2 },
    interactable: { action: 'pickup-stack', label: '木材', enabled: true, revision: 0 },
    itemStack: { itemType: 'wood', displayName: '木材', quantity: 12, maximumQuantity: 999, revision: 1 },
    residency: { state: 'sleeping', revision: 1 },
    thermal: { temperature: 20, burning: false, fuelRatio: 1, revision: 0 },
  };
  system.syncSnapshots([wood], 1_000, 1_000);
  system.update(0, 0);

  const actor = system.getActor(wood.id)!;
  assert.equal(actor.getComponent(THREE_OBJECT_COMPONENT), undefined);
  assert.equal((actor.requireComponent(ITEM_STACK_COMPONENT) as ItemStackComponent).quantity, 12);
  assert.ok(actor.getComponent(SIMPLE_COLLISION_COMPONENT));
  assert.equal(system.findNearbyInteractableActor({ x: 1, z: 2 })?.quantity, 12);

  const batchRoot = system.root.getObjectByName('high-count-actor-batches')!;
  const fills: THREE.InstancedMesh[] = [];
  const outlines: THREE.LineSegments[] = [];
  batchRoot.traverse((object) => {
    if ((object as THREE.InstancedMesh).isInstancedMesh) fills.push(object as THREE.InstancedMesh);
    if ((object as THREE.LineSegments).isLineSegments) outlines.push(object as THREE.LineSegments);
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].count, 1);
  assert.equal(outlines.length, 1);
  system.dispose();
});

test('流式树按 Chunk 构造无网格 Actor，偏离态可在无 Transform 快照中应用且不会误删', () => {
  let now = 1_000;
  const collision = new CollisionWorld();
  const overrides: Array<{ chunkX: number; chunkZ: number; propIndex: number; removed: boolean }> = [];
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    collision,
    now: () => now,
  });
  system.setGeneratedTreeOverrideTarget((chunkX, chunkZ, propIndex, removed) => {
    overrides.push({ chunkX, chunkZ, propIndex, removed });
  });

  const props = new Int32Array(PROP_BUFFER_LENGTH);
  const propCount = generateChunkProps(DEFAULT_WORLD_SEED, -1, 0, props);
  let propIndex = -1;
  for (let index = 0; index < propCount; index += 1) {
    if (props[index * PROP_STRIDE + PROP_FIELD.KIND] === PROP_KIND.TREE) {
      propIndex = index;
      break;
    }
  }
  assert.ok(propIndex >= 0);
  collision.setStaticGroup('-1:0', readChunkColliders(props, propCount, [], {
    chunkX: -1,
    chunkZ: 0,
  }));
  system.mountGeneratedTreeChunk('-1:0', -1, 0, props, propCount);
  system.update(0, 0);

  const actorId = formatGeneratedTreeId(-1, 0, propIndex);
  const actor = system.getActor(actorId)!;
  assert.ok(actor);
  assert.equal(actor.hasComponents(THREE_OBJECT_COMPONENT), false);
  const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  assert.equal(
    system.findNearbyInteractableActor({ x: transform.x + 0.2, z: transform.z })?.actorId,
    actorId,
  );

  system.syncSnapshots([{
    id: actorId,
    revision: 3,
    treeState: { health: 0, removed: true },
  }], 1_000);
  system.update(0, 0);
  const tree = actor.requireComponent(GENERATED_TREE_COMPONENT) as GeneratedTreeComponent;
  assert.equal(tree.removed, true);
  assert.deepEqual(overrides.at(-1), { chunkX: -1, chunkZ: 0, propIndex, removed: true });

  now = 1_100;
  system.syncSnapshots([], 1_100);
  now = 1_230;
  system.update(0, 0);
  assert.equal(system.getActor(actorId), actor);
  system.unmountGeneratedTreeChunk('-1:0');
  assert.equal(system.getActor(actorId), undefined);
  system.dispose();
});

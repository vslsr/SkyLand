import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  BUOYANCY_COMPONENT,
  type BuoyancyComponent,
  COMBUSTIBLE_COMPONENT,
  type CombustibleComponent,
  GENERATED_PROP_COMPONENT,
  GUIDE_PATH_COMPONENT,
  type GuidePathComponent,
  INTERACTABLE_COMPONENT,
  type InteractableComponent,
  type GeneratedPropComponent,
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
import { formatGeneratedPropId } from '../shared/world/generatedProp.mjs';
import { DEFAULT_WORLD_SEED, PROP_KIND } from '../shared/world/worldConfig.mjs';
import { selectWorldPropVariant } from '../shared/world/worldPropVariants.mjs';
import type { ClientActorSystem } from '../src/actors/ClientActorSystem';
import {
  createTestActorSystem,
  renderBackendOf,
  renderProxyOf,
  renderRootOf,
  stepActorFrame,
} from './renderProxyProbe';
import {
  RENDER_PROXY_COMPONENT,
} from '../src/actors/components/RenderProxyComponent';
import {
  FIRE_VISUAL_COMPONENT,
  type FireVisualComponent,
} from '../src/actors/components/FireVisualComponent';
import type { SnapshotActor } from '../src/network/protocol';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { resolvePlayerVisualShape } from '../src/player/playerVisualShape';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import type { ThreeHybridSlimeVisual } from '../src/render/three/ThreeHybridSlimeVisual';
import type {
  PlayerRenderDefinition,
  ProxyId,
  SlimeSurfaceDragDefinition,
} from '../src/render/RenderScene';
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

const pbfSlimeArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'pbf-slime',
  components: {
    slimeSurfaceDrag: {
      maximumDistance: 1.05,
      pullForce: 120,
      falloffExponent: 1.35,
      influenceRadius: 1.15,
    },
    render: {
      model: 'line-art-pbf-slime',
      radius: 0.95,
      collisionRadius: 0.52,
      collisionHeight: 0.72,
      particleCount: 72,
      constraintIterations: 2,
      gravity: 9.8,
      centerForce: 22,
      viscosity: 10,
      bubbleCount: 9,
      bubbleSpeed: 0.1,
      surfaceColor: '#90ebcb',
      innerColor: '#3ca98e',
      highlightColor: '#d8fff0',
      bubbleColor: '#e8fff8',
      inkColor: '#142f2b',
      shadowColor: '#7bd3bd',
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

const guidePathArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'guide-path',
  components: {
    guidePath: {
      points: [[0, 0.4, 0], [2, 0.4, -2], [4, 0.4, 0]],
      curve: 'catmull-rom',
      lineColor: '#fffdf4',
      markerColor: '#fffdf4',
      lineWidth: 5,
      dashLength: 0.8,
      gapLength: 0.55,
      dashSpeed: 0.5,
      markerSize: 0.6,
      hitRadius: 1.25,
      autoAdvance: true,
      loop: false,
      enabled: true,
    },
  },
};

const woodLogArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'wood-log',
  components: {
    interactable: { action: 'pickup-stack', label: '圆木', maximumDistance: 2.4 },
    itemStack: {
      itemType: 'wood-log', displayName: '圆木', defaultQuantity: 1,
      maximumQuantity: 999, compatibilityKey: 'wood-log',
    },
    actorResidency: { sleepDelaySeconds: 1, dormantDelaySeconds: 3, dormantEligible: true },
    dropMotion: {
      gravity: 9.8,
      drag: 0.65,
      groundDrag: 3.1,
      restitution: 0.18,
      radius: 0.11,
      settleSpeed: 0.07,
    },
    lifetime: { lifetimeSeconds: 900 },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
    render: {
      model: 'line-art-wood-log', woodColor: '#d6bea3', cutColor: '#eadbc8',
      inkColor: '#51463e', radius: 0.11, length: 0.88,
    },
  },
};

const stonePileArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'stone-pile',
  components: {
    interactable: { action: 'pickup-stack', label: '石料', maximumDistance: 2.4 },
    itemStack: {
      itemType: 'stone', displayName: '石料',
      defaultQuantity: 1, maximumQuantity: 999, compatibilityKey: 'stone-standard',
    },
    actorResidency: { sleepDelaySeconds: 1, dormantDelaySeconds: 3, dormantEligible: true },
    dropMotion: { gravity: 9.8, drag: 6.5, settleSpeed: 0.08 },
    lifetime: { lifetimeSeconds: 900 },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
    render: {
      model: 'line-art-stone-pile', stoneColor: '#b9b4a8', accentColor: '#8e8880',
      inkColor: '#4a453e', radius: 0.5, height: 0.32,
    },
  },
};

const generatedRockArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'generated-rock',
  components: {
    interactable: { action: 'harvest-prop', label: '岩石', maximumDistance: 2.2 },
    generatedProp: {
      kind: 'rock',
      maximumHealth: 4,
      harvestDamage: 1,
      drop: { archetypeId: 'stone-pile', quantity: 3 },
    },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
  },
};

const generatedPropArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'generated-tree',
  components: {
    interactable: { action: 'harvest-prop', label: '树木', maximumDistance: 2.6 },
    generatedProp: {
      kind: 'tree',
      maximumHealth: 3,
      harvestDamage: 1,
      drop: { archetypeId: 'wood-pile', quantity: 5 },
    },
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
    woodLogArchetype,
    generatedPropArchetype,
    stonePileArchetype,
    generatedRockArchetype,
    pbfSlimeArchetype,
    guidePathArchetype,
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
    worldProps: {
      tree: [{ archetypeId: 'generated-tree', weight: 1 }],
      rock: [{ archetypeId: 'generated-rock', weight: 1 }],
    },
    bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    spawn: { centerX: 0, centerZ: 0, radius: 0, slots: 8 },
    water: { seaLevel: 0 },
  },
  camera: { mode: 'fly', position: [0, 5, 10], yaw: 0, pitch: 0, moveSpeed: 8 },
} satisfies SceneDefinition;

/** beforeRender 会读画布尺寸给引导线算像素线宽；测试只需要这一个字段。 */
const FAKE_RENDERER = {
  domElement: { width: 1280, height: 720 },
} as unknown as THREE.WebGLRenderer;

const RENDER_ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 };

/**
 * 玩家史莱姆的表现现在住在渲染世界里，所以测试也从渲染世界这一侧取。
 *
 * `update` 保留搬迁前 `createPlayerActorVisual().update()` 的参数顺序，另外
 * 先把 yaw 写到 proxy 的 root 上——真实链路里那一步由 `submitTransforms` 做，
 * 软体读的正是它。
 */
function createPlayerVisualHarness(
  name: string,
  render: PlayerRenderDefinition,
  walkSpeed: number,
  surfaceDrag?: SlimeSurfaceDragDefinition,
) {
  const scene = new ThreeRenderScene(new THREE.Group(), RENDER_ENVIRONMENT);
  // 槽位由玩法侧分配：渲染世界不回话（见 RenderScene.createPlayerProxy）。
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, { name, render, walkSpeed, surfaceDrag });
  const proxy = scene.resolve(proxyId)!;
  const slime = scene.resolveSlimeVisual(proxyId) as ThreeHybridSlimeVisual;
  return {
    scene,
    proxyId: proxyId as ProxyId,
    root: proxy.root,
    get rig() {
      return slime.rig;
    },
    get slime() {
      return slime;
    },
    update(
      deltaSeconds: number,
      elapsedSeconds: number,
      movementSpeed: number,
      authorityYaw: number,
      motion?: {
        velocityX: number;
        velocityZ: number;
        verticalVelocity?: number;
        grounded?: boolean;
        collisionDisplacement?: { x: number; z: number };
      },
    ): void {
      proxy.root.rotation.y = authorityYaw;
      slime.update(deltaSeconds, elapsedSeconds, proxy.root.rotation.y, {
        movementSpeed,
        movementVelocityX: motion?.velocityX ?? 0,
        movementVelocityZ: motion?.velocityZ ?? 0,
        verticalVelocity: motion?.verticalVelocity ?? 0,
        airborne: motion?.grounded === false ? 1 : 0,
        collisionDisplacementX: motion?.collisionDisplacement?.x ?? 0,
        collisionDisplacementZ: motion?.collisionDisplacement?.z ?? 0,
      });
    },
    dispose(): void {
      scene.dispose();
    },
  };
}

test('普通玩家眼睛使用独立的无光照、无雾渲染层', () => {
  const scene = new ThreeRenderScene(new THREE.Group(), RENDER_ENVIRONMENT);
  // 槽位由玩法侧分配：渲染世界不回话（见 RenderScene.createPlayerProxy）。
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, {
    name: 'unlit-eye-player',
    walkSpeed: 3.2,
    render: {
      model: 'line-art-player-slime',
      radius: 0.42,
      membraneColor: '#4fd695',
      middleColor: '#8ce8b6',
      coreColor: '#2fbb7c',
      bubbleColor: '#eafff2',
      inkColor: '#173a2b',
      shadowColor: '#1e5a40',
    },
  });
  const root = scene.resolve(proxyId)!.root;
  const eyes = [
    root.getObjectByName('player-slime-eye-left'),
    root.getObjectByName('player-slime-eye-right'),
  ] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];

  for (const eye of eyes) {
    assert.ok(eye);
    assert.equal(eye.material.type, 'MeshBasicMaterial');
    assert.equal(eye.material.depthWrite, false);
    assert.equal(eye.material.fog, false);
    assert.equal(eye.material.toneMapped, false);
  }
  scene.dispose();
});

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
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  assert.equal(system.getActor(snapshot.id), undefined);

  system.syncSnapshots([snapshot], 1_000);
  stepActorFrame(system, 0, 0);

  const actor = system.getActor(snapshot.id)!;
  const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  const buoyancy = actor.requireComponent(BUOYANCY_COMPONENT) as BuoyancyComponent;
  const render = renderProxyOf(system, actor.id)!;
  assert.deepEqual([transform.x, transform.y, transform.z, transform.yaw], [2, 0, -3, 0.4]);
  assert.equal(buoyancy.draft, 0.21);
  // 渲染世界拿到的是权威 transform 的 f32 镜像（边界上的 SoA 是 Float32Array），
  // 所以这里按 f32 精度比较；Actor 上的权威值仍然是 f64，见上一行 deepEqual。
  assert.equal(render.root.position.x, 2);
  assert.equal(render.root.position.z, -3);
  assert.ok(Math.abs(render.root.rotation.y - 0.4) < 1e-6);
  assert.ok(renderRootOf(system).getObjectByName('actor-demo-raft-01-visual'));
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
  stepActorFrame(system, 0, 0);
  assert.equal(system.findOwnedActorId('player-1'), snapshot.id);
  assert.equal(system.findControllableActorId(), undefined);
});

test('视觉波动只作用于 VisualRoot，且快照移除会销毁 Replica', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  system.syncSnapshots([snapshot], 1_000);
  stepActorFrame(system, 1 / 60, 1.25);

  const actor = system.getActor(snapshot.id)!;
  const render = renderProxyOf(system, actor.id)!;
  assert.equal(render.root.position.y, snapshot.transform.y);
  assert.ok(Number.isFinite(render.visualRoot.position.y));
  assert.notEqual(render.visualRoot.position.y, render.root.position.y);
  assert.ok(Math.abs(render.visualRoot.rotation.x) <= 0.07 + Number.EPSILON);
  assert.ok(Math.abs(render.visualRoot.rotation.z) <= 0.09 + Number.EPSILON);

  now = 1_100;
  system.syncSnapshots([], 1_100);
  now = 1_230;
  stepActorFrame(system, 0, 1.3);
  assert.equal(system.getActor(snapshot.id), undefined);
  assert.equal(renderRootOf(system).children.length, 0);
});

test('Actor Transform 在两份服务端快照之间插值而不做客户端外推', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
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
  stepActorFrame(system, 0, 0);

  const actor = system.getActor(snapshot.id)!;
  const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  assert.ok(Math.abs(transform.x - 5) < 1e-6);
  assert.ok(Math.abs(transform.z + 2) < 1e-6);
  assert.ok(Math.abs(transform.yaw - Math.PI / 4) < 1e-6);
});

test('能力实验室对象由 Actor 快照创建，训练假人暴露 visualRoot 内的目标 rig', () => {
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  system.syncSnapshots([
    trainingDummySnapshot,
    focusObeliskSnapshot,
    floorPlaqueSnapshot,
  ], 1_000);
  stepActorFrame(system, 0, 0);

  const actor = system.getActor(trainingDummySnapshot.id)!;
  const render = renderProxyOf(system, actor.id)!;
  assert.equal(actor.archetypeId, 'training-dummy');
  assert.ok(render.abilityTargetRig);
  assert.equal(render.abilityTargetRig.targetRoot, render.visualRoot);
  assert.equal(render.abilityTargetRig.burningAura.visible, false);
  assert.equal(render.root.position.z, -1.5);
  const focusRender = renderProxyOf(system, focusObeliskSnapshot.id)!;
  assert.ok(focusRender.root.getObjectByName('focus-obelisk-crystal'));
  const plaqueCollision = system.getActor(floorPlaqueSnapshot.id)!
    .requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent;
  assert.equal(plaqueCollision.halfWidth, 1.9);
  assert.equal(plaqueCollision.halfLength, 0.55);
  system.dispose();
});

test('客户端离散恢复父子关系，并只插值子 Actor 的权威世界坐标', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const childFrom = createDeckPropSnapshot(0.72);

  // 故意把子节点放在父节点前，验证快照顺序不影响层级恢复。
  system.syncSnapshots([childFrom, snapshot], 1_000, 1_000);
  stepActorFrame(system, 1 / 60, 1.25);

  const parent = system.getActor(snapshot.id)!;
  const child = system.getActor(childFrom.id)!;
  const parentRender = renderProxyOf(system, parent.id)!;
  const childRender = renderProxyOf(system, child.id)!;
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
  // 局部坐标由渲染侧从 f32 的父/子世界坐标反算，容差按 f32 取。
  assert.ok(Math.abs(childRender.root.position.x - 0.72) < 1e-6);
  assert.ok(Math.abs(childRender.root.position.y - 0.62) < 1e-6);
  assert.ok(Math.abs(childRender.root.position.z + 0.55) < 1e-6);
  assert.ok(Math.abs(childRender.root.rotation.y + 0.1) < 1e-6);
  assert.ok(Math.abs(childTransform.x - childFrom.transform.x) < 1e-9);
  assert.ok(
    childRender.attachmentVisualRoot.position.lengthSq() > 1e-9
      || Math.abs(childRender.attachmentVisualRoot.quaternion.w - 1) > 1e-9,
  );

  const childTo = createDeckPropSnapshot(1.72);
  now = 1_100;
  system.syncSnapshots([snapshot, childTo], 1_100, 1_100);
  now = 1_170;
  stepActorFrame(system, 0, 1.3);
  assert.ok(Math.abs(childRender.root.position.x - 1.22) < 1e-6);
  assert.equal(childTransform.localX, 1.72);
  parentRender.root.updateWorldMatrix(true, true);
  // Three 层级组合出的世界坐标必须等于权威插值结果，容差按 f32 镜像取。
  const childWorld = childRender.root.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(childWorld.x - childTransform.x) < 1e-6);
  assert.ok(Math.abs(childWorld.y - childTransform.y) < 1e-6);
  assert.ok(Math.abs(childWorld.z - childTransform.z) < 1e-6);

  // 服务端删除父节点时采用默认策略：子节点解除挂载并保持世界坐标。
  const detached = { ...childTo, parentActorId: null };
  now = 1_200;
  system.syncSnapshots([detached], 1_200, 1_200);
  now = 1_330;
  stepActorFrame(system, 0, 1.4);
  assert.equal(system.getActor(parent.id), undefined);
  assert.equal(system.getActor(child.id)?.parent, undefined);
  assert.equal(childRender.root.parent, renderRootOf(system));
  assert.equal(childGeometryDisposeCount, 0);

  now = 1_400;
  system.syncSnapshots([], 1_400, 1_400);
  now = 1_530;
  stepActorFrame(system, 0, 1.5);
  assert.equal(system.getActor(child.id), undefined);
  assert.equal(childGeometryDisposeCount, 1);
});

test('客户端按权威燃烧状态显示参考 LineLoop 火焰，稳定篝火始终可见', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
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
  stepActorFrame(system, 1 / 60, 0.5);

  // rig 住在渲染世界里；Actor 上的 FireVisualComponent 只剩一个目标强度。
  const campfireRig = renderProxyOf(system, campfire.id)!.fireVisualRig!;
  const hayActor = system.getActor(coldHay.id)!;
  const hayRig = renderProxyOf(system, hayActor.id)!.fireVisualRig!;
  const hayFire = hayActor.requireComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent;
  assert.equal(
    (system.getActor(campfire.id)!
      .requireComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent).targetIntensity,
    1,
    '静态热源的目标强度应当在 spawn 时就是 1',
  );
  assert.equal(hayFire.targetIntensity, 0, '没烧起来时目标强度是 0');
  const temperatureMarker = renderProxyOf(system, hayActor.id)!.markers;
  assert.equal(campfireRig.root.visible, true);
  assert.equal(hayRig.root.visible, false);
  assert.equal(temperatureMarker.temperatureVisible, false);
  assert.equal(temperatureMarker.temperatureLabel, '');
  assert.equal(campfireRig.flames.length, 5);
  assert.equal(campfireRig.sparks.length, 6);

  system.setTemperatureVisible(true);
  assert.equal(temperatureMarker.temperatureVisible, true);
  assert.equal(temperatureMarker.temperatureLabel, '20.0 °C');
  assert.ok(renderProxyOf(system, hayActor.id)!
    .root.getObjectByName('actor-temperature-marker'));
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 4, 7);
  renderBackendOf(system).beforeRender(FAKE_RENDERER, camera);

  const burningHay: SnapshotActor = {
    ...coldHay,
    revision: 4,
    thermal: { temperature: 78.4, burning: true, fuelRatio: 0.99, revision: 4 },
  };
  now = 1_100;
  system.syncSnapshots([campfire, burningHay], 1_100, 1_100);
  now = 1_230;
  stepActorFrame(system, 0.1, 0.6);

  const combustible = hayActor.requireComponent(COMBUSTIBLE_COMPONENT) as CombustibleComponent;
  assert.equal(combustible.burning, true);
  assert.equal(hayFire.targetIntensity, 1, '燃烧快照必须把目标强度推到 1');
  assert.equal(hayRig.root.visible, true);
  assert.equal(temperatureMarker.temperatureLabel, '78.4 °C');
  assert.equal(hayRig.flames.length, 4);
  assert.equal(hayRig.sparks.length, 4);
  const flameTop = Math.max(...hayRig.flames.map((flame) => (
    hayRig.root.position.y
      + (flame.y + flame.height) * hayRig.root.scale.y
  )));
  assert.ok(flameTop > dryHayArchetype.components.render.height);
  const flameOrigins = hayRig.flames.map((flame) => (
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
  const positions = hayRig.flames[0].position.array as Float32Array;
  assert.ok(positions.some((value) => Math.abs(value) > 1e-5));
  system.setTemperatureVisible(false);
  assert.equal(temperatureMarker.temperatureVisible, false);
  system.dispose();
});

test('混合史莱姆用单球核心与休眠弹簧蒙皮，且不会改写权威 Actor 根节点', () => {
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const pbfSlime: SnapshotActor = {
    id: 'pbf-slime-01',
    archetypeId: 'pbf-slime',
    revision: 0,
    transform: { x: 1.5, y: 0, z: -2.8, yaw: 0.2 },
  };
  system.syncSnapshots([pbfSlime], 1_000, 1_000);
  stepActorFrame(system, 0, 0);

  const actor = system.getActor(pbfSlime.id)!;
  const render = renderProxyOf(system, actor.id)!;
  const visual = system.getRenderScene().resolveSlimeVisual(render.id)!;
  const initialSurface = Float32Array.from(
    visual.rig.surfacePosition.array as ArrayLike<number>,
  );
  for (let frame = 1; frame <= 120; frame += 1) {
    stepActorFrame(system, 1 / 60, frame / 60);
  }

  for (const [actual, expected] of [
    [render.root.position.x, 1.5],
    [render.root.position.y, 0],
    [render.root.position.z, -2.8],
    [render.root.rotation.y, 0.2],
  ]) {
    assert.ok(Math.abs(actual - expected) < 1e-6, `权威根节点被改写：${actual} ≠ ${expected}`);
  }
  // 抵消量现在取自权威 TransformComponent.yaw（f64），而 root.rotation.y 是
  // 边界上的 f32 镜像，两者差一个 f32 舍入——1 米半径上约 3 纳米。容差按 f32 取。
  assert.ok(
    Math.abs(render.root.rotation.y + visual.rig.root.rotation.y) < 1e-6,
    '弹簧外壳应抵消权威 Actor yaw，避免把软体蒙皮整团硬转',
  );
  assert.equal(visual.simulation.vertexCount, visual.rig.surfaceDirections.length / 3);
  assert.ok(Array.from(visual.simulation.positions).every(Number.isFinite));
  const skinY = Array.from(visual.simulation.positions).filter((_, index) => index % 3 === 1);
  assert.ok(Math.min(...skinY) <= 0.95 * 0.03, '休眠蒙皮底部应直接贴近地面');
  let rimVertexCount = 0;
  let maximumRimY = 0;
  for (let offset = 0; offset < visual.rig.surfaceDirections.length; offset += 3) {
    if (Math.abs(visual.rig.surfaceDirections[offset + 1]) > 1e-5) continue;
    rimVertexCount += 1;
    maximumRimY = Math.max(maximumRimY, visual.simulation.positions[offset + 1]);
  }
  assert.ok(rimVertexCount > 0);
  assert.ok(
    maximumRimY <= 0.95 * 0.022,
    '最大平面半径所在的外圈应瘫软到地面，而不是悬在质心高度',
  );
  assert.ok(visual.simulation.center[1] < 0.95 * 0.55, '休眠质心不应初始化在空中');
  assert.ok(Array.from(visual.rig.surfacePosition.array as ArrayLike<number>).every(Number.isFinite));
  assert.ok(Array.from(visual.rig.surfacePosition.array as ArrayLike<number>).every((value, index) => (
    Math.abs(value - initialSurface[index]) < 1e-7
  )), '没有外部碰撞时，出生后的休眠外壳不应自行改变结构');
  for (let frame = 121; frame <= 360; frame += 1) {
    stepActorFrame(system, 1 / 60, frame / 60);
  }
  let previousSurface = Float32Array.from(
    visual.rig.surfacePosition.array as ArrayLike<number>,
  );
  let maximumSettledSurfaceDelta = 0;
  let maximumSettledPlanarCenter = 0;
  for (let frame = 361; frame <= 480; frame += 1) {
    stepActorFrame(system, 1 / 60, frame / 60);
    maximumSettledPlanarCenter = Math.max(
      maximumSettledPlanarCenter,
      Math.hypot(visual.simulation.center[0], visual.simulation.center[2]),
    );
    const currentSurface = visual.rig.surfacePosition.array as ArrayLike<number>;
    for (let index = 0; index < currentSurface.length; index += 1) {
      maximumSettledSurfaceDelta = Math.max(
        maximumSettledSurfaceDelta,
        Math.abs(currentSurface[index] - previousSurface[index]),
      );
    }
    previousSurface = Float32Array.from(currentSurface);
  }
  assert.ok(
    maximumSettledPlanarCenter < 0.95 * 0.025,
    '胡克中心弹簧应阻止软核心在局部空间随机游走',
  );
  assert.ok(
    maximumSettledSurfaceDelta < 0.95 * 0.012,
    '休眠弹簧蒙皮不应自行产生跳动尖角',
  );
  assert.ok(render.visualRoot.getObjectByName('pbf-slime-surface'));
  assert.equal(render.visualRoot.getObjectByName('pbf-slime-fluid-grid'), undefined);
  assert.ok(render.visualRoot.getObjectByName('hybrid-slime-spherical-core'));
  const surfaceMesh = render.visualRoot.getObjectByName('pbf-slime-surface') as THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshBasicMaterial
  >;
  const visualCore = render.visualRoot.getObjectByName(
    'hybrid-slime-spherical-core',
  ) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  assert.equal(surfaceMesh.material.transparent, true);
  assert.equal(surfaceMesh.material.depthWrite, false);
  assert.equal(surfaceMesh.material.type, 'MeshBasicMaterial');
  assert.equal(surfaceMesh.material.toneMapped, false);
  assert.equal(surfaceMesh.material.color.getHexString(), '90ebcb');
  assert.ok(surfaceMesh.material.opacity > 0.35 && surfaceMesh.material.opacity < 0.55);
  assert.equal(visualCore.material.transparent, true);
  assert.equal(visualCore.material.depthWrite, false);
  assert.ok(visualCore.material.opacity > 0.65);
  const surfaceBrightness = (
    surfaceMesh.material.color.r
    + surfaceMesh.material.color.g
    + surfaceMesh.material.color.b
  );
  const coreBrightness = (
    visualCore.material.color.r
    + visualCore.material.color.g
    + visualCore.material.color.b
  );
  assert.ok(
    coreBrightness < surfaceBrightness * 0.7,
    '内部球形核心应明显深于半透明薄荷绿外壳',
  );
  assert.equal(visual.rig.faceRoot.children.length, 2, '脸部只能保留两只眼睛');
  assert.equal(
    visual.rig.faceRoot.children.some((child) => (child as THREE.Line).isLine),
    false,
    '史莱姆不应绘制嘴巴',
  );
  for (const eye of visual.rig.faceRoot.children as THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshBasicMaterial
  >[]) {
    assert.equal(eye.material.color.getHexString(), '142f2b');
    assert.equal(eye.material.type, 'MeshBasicMaterial');
    assert.equal(eye.material.depthTest, false);
    assert.equal(eye.material.depthWrite, false);
    assert.equal(eye.material.fog, false);
    assert.equal(eye.material.toneMapped, false);
  }
  const eyeCenterX = visual.rig.faceRoot.position.x - visual.simulation.center[0];
  const eyeCenterZ = visual.rig.faceRoot.position.z - visual.simulation.center[2];
  const eyeCenterRadius = Math.hypot(eyeCenterX, eyeCenterZ);
  const eyeDirectionX = eyeCenterX / Math.max(1e-6, eyeCenterRadius);
  const eyeDirectionZ = eyeCenterZ / Math.max(1e-6, eyeCenterRadius);
  let shellRadiusAtEyeHeight = 0;
  for (let offset = 0; offset < visual.simulation.positions.length; offset += 3) {
    if (
      Math.abs(
        visual.simulation.positions[offset + 1] - visual.rig.faceRoot.position.y,
      ) > visual.rig.radius * 0.14
    ) continue;
    shellRadiusAtEyeHeight = Math.max(
      shellRadiusAtEyeHeight,
      (visual.simulation.positions[offset] - visual.simulation.center[0]) * eyeDirectionX
        + (visual.simulation.positions[offset + 2] - visual.simulation.center[2]) * eyeDirectionZ,
    );
  }
  assert.ok(
    eyeCenterRadius + visual.rig.radius * 0.075 < shellRadiusAtEyeHeight,
    '两只眼球的最前端也必须缩进半透明外壳内部',
  );
  assert.ok(
    Math.hypot(
      visualCore.position.x - visual.simulation.forceCenter[0],
      visualCore.position.y - visual.simulation.forceCenter[1],
      visualCore.position.z - visual.simulation.forceCenter[2],
    ) < 1e-7,
    '可见球形核心必须与蒙皮向心力中心重合',
  );
  assert.ok(visualCore.renderOrder < surfaceMesh.renderOrder, '核心必须先于透明外壳绘制');
  assert.equal(render.simpleCollision.shape, 'cylinder');
  assert.equal(render.simpleCollision.halfWidth, 0.52);
  assert.equal(render.simpleCollision.halfLength, 0.52);
  assert.equal(render.simpleCollision.maximumY, 0.72);
  assert.equal(visual.rig.root.userData.hybridStats.vertexCount, visual.simulation.vertexCount);
  assert.equal(visual.rig.root.userData.hybridSimulationActive, false);
  for (let ringVertex = 0; ringVertex < visual.rig.shadowBoundaryVertices.length; ringVertex += 1) {
    const surfaceOffset = visual.rig.shadowBoundaryVertices[ringVertex] * 3;
    assert.ok(
      Math.abs(
        visual.rig.shadowPosition.getX(ringVertex + 1)
        - visual.simulation.positions[surfaceOffset]
      ) < 1e-7,
    );
    assert.ok(
      Math.abs(
        visual.rig.shadowPosition.getY(ringVertex + 1)
        + visual.simulation.positions[surfaceOffset + 2]
      ) < 1e-7,
    );
  }
  // 与上面同理：抵消量来自 f64 权威 yaw，root.rotation.y 是 f32 镜像。
  assert.ok(
    Math.abs(render.root.rotation.y + visual.rig.shadowRoot.rotation.y) < 1e-6,
    '阴影应与外壳使用同一世界朝向，不能再独立旋转或拉伸',
  );
  for (const bubble of visual.rig.bubbles) {
    assert.ok(
      Math.hypot(
        bubble.mesh.position.x - visual.simulation.center[0] * 0.72,
        bubble.mesh.position.z - visual.simulation.center[2] * 0.72,
      ) < 0.95 * 0.17,
      '内部气泡必须留在核心附近，不能穿出蒙皮形成随机凸块',
    );
  }
  system.dispose();
});

test('无模型 GuidePath Actor 只在快照存在时创建客户端 Three.js 表现', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const guideSnapshot: SnapshotActor = {
    id: 'guide-path-01',
    archetypeId: 'guide-path',
    revision: 3,
    transform: { x: 6, y: 0, z: -4, yaw: 0.25 },
    guidePath: {
      points: [[0, 0.4, 0], [3, 0.4, -1], [5, 0.4, 2]],
      curve: 'linear',
      enabled: true,
      currentPointIndex: 1,
      pathRevision: 2,
      revision: 3,
    },
  };

  system.syncSnapshots([guideSnapshot], 1_000);
  stepActorFrame(system, 1 / 60, 0);

  const actor = system.getActor(guideSnapshot.id)!;
  const state = actor.requireComponent(GUIDE_PATH_COMPONENT) as GuidePathComponent;
  const render = renderProxyOf(system, actor.id)!;
  // 表现住在渲染世界里；Actor 上只剩 shared/ 的权威 GuidePathComponent。
  const guide = system.getRenderScene().resolveGuidePath(render.id)!.guide;
  assert.equal(actor.hasComponents(SIMPLE_COLLISION_COMPONENT), false);
  assert.equal(state.currentPointIndex, 1);
  assert.equal(state.curve, 'linear');
  assert.equal(guide.currentMarkerIndex, 1);
  assert.equal(render.root.position.x, 6);
  assert.equal(render.root.position.z, -4);
  assert.ok(render.visualRoot.children.includes(guide.root));

  now = 1_100;
  system.syncSnapshots([], 1_100);
  now = 1_230;
  stepActorFrame(system, 0, 0);
  assert.equal(system.getActor(guideSnapshot.id), undefined);
  assert.equal(renderRootOf(system).getObjectByName('actor-guide-path-01-root'), undefined);
  system.dispose();
});

test('史莱姆表面拖拽带动整团软体，命中处最强，接近上限时衰减并在释放后回弹', () => {
  const render = pbfSlimeArchetype.components.render;
  const dragDefinition = pbfSlimeArchetype.components.slimeSurfaceDrag;
  assert.ok(render?.model === 'line-art-pbf-slime');
  assert.ok(dragDefinition);
  const visual = createPlayerVisualHarness('surface-drag-player', render, 3.2, dragDefinition);
  const initialSurface = Float32Array.from(visual.slime.simulation.positions);
  let topOffset = 0;
  for (let offset = 3; offset < initialSurface.length; offset += 3) {
    if (initialSurface[offset + 1] > initialSurface[topOffset + 1]) topOffset = offset;
  }

  // 动态几何的标准三角拾取短暂漏报时，窄范围顶点容错仍应命中肉眼可见表面。
  const surfaceRaycast = visual.rig.surface.raycast;
  visual.rig.surface.raycast = () => undefined;
  assert.equal(visual.scene.beginSlimeSurfaceDrag(visual.proxyId, {
    origin: [0, 3, 0],
    direction: [0, -1, 0],
  }), true);
  visual.rig.surface.raycast = surfaceRaycast;
  assert.equal(visual.scene.updateSlimeSurfaceDrag(visual.proxyId, {
    origin: [3, 3, 0],
    direction: [0, -1, 0],
  }), true);
  for (let frame = 0; frame < 150; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, { velocityX: 0, velocityZ: 0 });
  }

  const pulledSurface = visual.slime.simulation.positions;
  const selectedExtension = pulledSurface[topOffset] - initialSurface[topOffset];
  const statsWhileDragging = visual.slime.simulation.stats();
  assert.ok(selectedExtension > render.radius * 0.08, '命中表面应产生可见的局部拉伸');
  assert.ok(
    selectedExtension <= dragDefinition.maximumDistance + 1e-5,
    '即使鼠标远超表面，形变也不能越过 maximumDistance',
  );
  assert.equal(statsWhileDragging.surfaceDragActive, true);
  assert.ok(statsWhileDragging.surfaceDragExtensionRatio > 0);
  assert.ok(
    statsWhileDragging.surfaceDragForceScale < 1,
    '蒙皮越接近最大伸长，实际拉力比例应越小',
  );

  let farSideMaximumDelta = 0;
  let equatorMaximumDelta = 0;
  for (let offset = 0; offset < pulledSurface.length; offset += 3) {
    const delta = Math.abs(pulledSurface[offset] - initialSurface[offset]);
    if (Math.abs(visual.rig.surfaceDirections[offset + 1]) < 0.25) {
      equatorMaximumDelta = Math.max(equatorMaximumDelta, delta);
    }
    if (visual.rig.surfaceDirections[offset + 1] > -0.65) continue;
    farSideMaximumDelta = Math.max(farSideMaximumDelta, delta);
  }
  assert.ok(
    equatorMaximumDelta > selectedExtension * 0.3,
    '拖拽不是只鼓出一个局部的包，腰部同样要被整体带走',
  );
  assert.ok(
    farSideMaximumDelta > selectedExtension * 0.12,
    '影响圈之外的底面也应跟随，整只史莱姆都受拖拽影响',
  );
  assert.ok(
    farSideMaximumDelta < selectedExtension * 0.8,
    '底面仍被地面黏住，不能把整团史莱姆当作刚体平移',
  );

  visual.scene.endSlimeSurfaceDrag(visual.proxyId);
  for (let frame = 150; frame < 510; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, { velocityX: 0, velocityZ: 0 });
  }
  const releasedExtension = Math.abs(
    visual.slime.simulation.positions[topOffset] - initialSurface[topOffset],
  );
  assert.equal(visual.slime.simulation.stats().surfaceDragActive, false);
  assert.ok(releasedExtension < selectedExtension * 0.2, '松开后应由原有胡克弹簧平滑回弹');
  visual.dispose();
});

test('混合史莱姆的软核心产生黏地拖后，内部圆柱碰撞令接触侧蒙皮凹陷', () => {
  const render = pbfSlimeArchetype.components.render;
  assert.ok(render?.model === 'line-art-pbf-slime');
  const visual = createPlayerVisualHarness('pbf-player', render, 3.2);
  const rig = visual.rig;

  visual.root.rotation.y = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, { velocityX: 0, velocityZ: 0 });
  }
  assert.equal(rig.root.userData.hybridSimulationActive, false);
  const settledSurface = Float32Array.from(visual.slime.simulation.positions);
  const averageSideRadius = (surface: ArrayLike<number>): number => {
    let radiusSum = 0;
    let count = 0;
    for (let offset = 0; offset < rig.surfaceDirections.length; offset += 3) {
      const directionX = Math.abs(rig.surfaceDirections[offset]);
      const directionY = rig.surfaceDirections[offset + 1];
      if (directionX < 0.55 || directionY < 0.2) continue;
      radiusSum += Math.abs(surface[offset]);
      count += 1;
    }
    return radiusSum / Math.max(1, count);
  };
  const settledSideRadius = averageSideRadius(settledSurface);

  visual.update(1 / 60, 120 / 60, 3.2, 0, { velocityX: 0, velocityZ: 3.2 });
  const firstMovingForceBias = (
    visual.slime.simulation.forceCenter[2] - visual.slime.simulation.center[2]
  );
  assert.ok(
    firstMovingForceBias > render.radius * 0.005
      && firstMovingForceBias < render.radius * 0.05,
    '移动首帧向心核心应开始前移，但不能瞬间跳到完整速度偏移量',
  );
  for (let frame = 121; frame < 210; frame += 1) {
    visual.update(1 / 60, frame / 60, 3.2, 0, { velocityX: 0, velocityZ: 3.2 });
  }
  assert.ok(settledSurface.some((value, index) => (
    Math.abs(value - visual.slime.simulation.positions[index]) > render.radius * 0.02
  )), '移动锚点应通过胡克弹簧带动蒙皮，而不是整团刚体平移');
  assert.ok(
    visual.slime.simulation.center[2] < -render.radius * 0.1,
    '内部质量中心应平滑拖在 Actor 根节点后方',
  );
  assert.ok(
    visual.slime.simulation.forceCenter[2]
      > visual.slime.simulation.center[2] + render.radius * 0.12,
    '蒙皮的中心力应向 +Z 移动方向偏移，同时允许质量中心留在后方',
  );
  assert.ok(
    Math.hypot(
      rig.core.position.x - visual.slime.simulation.forceCenter[0],
      rig.core.position.y - visual.slime.simulation.forceCenter[1],
      rig.core.position.z - visual.slime.simulation.forceCenter[2],
    ) < 1e-7,
    '移动时可见核心必须持续跟随向心力中心，而不是滞后的质量中心',
  );
  assert.ok(
    averageSideRadius(visual.slime.simulation.positions) < settledSideRadius * 0.92,
    '移动时中上层蒙皮应受到随速度增强的向心弹簧力',
  );

  const surface = rig.surfacePosition.array as Float32Array;
  let upperZ = 0;
  let upperCount = 0;
  let lowerZ = 0;
  let lowerCount = 0;
  for (let offset = 0; offset < surface.length; offset += 3) {
    if (rig.surfaceDirections[offset + 1] > 0.35) {
      upperZ += surface[offset + 2];
      upperCount += 1;
    } else if (rig.surfaceDirections[offset + 1] < -0.35) {
      lowerZ += surface[offset + 2];
      lowerCount += 1;
    }
  }
  assert.ok(
    upperZ / upperCount > lowerZ / lowerCount + render.radius * 0.08,
    '上层应跟随角色，黏地接触层应明显滞留在后方',
  );
  let frontWidth = 0;
  let frontWidthCount = 0;
  let rearWidth = 0;
  let rearWidthCount = 0;
  for (let offset = 0; offset < rig.surfaceDirections.length; offset += 3) {
    const directionY = rig.surfaceDirections[offset + 1];
    const directionZ = rig.surfaceDirections[offset + 2];
    if (directionY < 0.2 || directionY > 0.8) continue;
    if (directionZ > 0.45) {
      frontWidth += Math.abs(surface[offset]);
      frontWidthCount += 1;
    } else if (directionZ < -0.45) {
      rearWidth += Math.abs(surface[offset]);
      rearWidthCount += 1;
    }
  }
  assert.ok(
    frontWidth / frontWidthCount < rearWidth / rearWidthCount * 0.94,
    '移动方向的水滴前端应比黏地后部更窄',
  );
  assert.deepEqual(
    [rig.shadow.scale.x, rig.shadow.scale.y, rig.shadow.scale.z],
    [1, 1, 1],
    '阴影不能再用独立缩放伪造拖尾',
  );
  for (let ringVertex = 0; ringVertex < rig.shadowBoundaryVertices.length; ringVertex += 1) {
    const surfaceOffset = rig.shadowBoundaryVertices[ringVertex] * 3;
    assert.ok(
      Math.abs(rig.shadowPosition.getX(ringVertex + 1) - surface[surfaceOffset]) < 1e-7,
    );
    assert.ok(
      Math.abs(rig.shadowPosition.getY(ringVertex + 1) + surface[surfaceOffset + 2]) < 1e-7,
    );
  }

  const movingLag = Math.abs(visual.slime.simulation.center[2]);
  visual.update(1 / 60, 210 / 60, 0, 0, { velocityX: 0, velocityZ: 0 });
  assert.ok(
    Math.abs(visual.slime.simulation.center[2]) > movingLag * 0.85,
    '停止首帧仍应保留大部分拖后量，而不是瞬间弹回',
  );

  visual.root.rotation.y = Math.PI / 2;
  const forceCenterBeforeTurn = Float32Array.from(visual.slime.simulation.forceCenter);
  visual.update(1 / 60, 211 / 60, 3.2, Math.PI / 2, {
    velocityX: 3.2,
    velocityZ: 0,
  });
  assert.ok(
    Math.hypot(
      visual.slime.simulation.forceCenter[0] - forceCenterBeforeTurn[0],
      visual.slime.simulation.forceCenter[2] - forceCenterBeforeTurn[2],
    ) < render.radius * 0.05,
    '转向首帧核心只能逐步补间，不能从旧方向闪到新方向',
  );
  assert.ok(
    visual.slime.simulation.forceCenter[0] > forceCenterBeforeTurn[0]
      && visual.slime.simulation.forceCenter[2] < forceCenterBeforeTurn[2],
    '核心补间位移必须沿旧向心力中心指向新向心力中心的方向',
  );

  const firstTurnFaceYaw = rig.faceRoot.rotation.y;
  assert.ok(firstTurnFaceYaw > 0 && firstTurnFaceYaw < Math.PI / 2);
  assert.ok(Math.abs(visual.root.rotation.y + rig.root.rotation.y) < 1e-9);

  for (let frame = 212; frame <= 330; frame += 1) {
    visual.update(1 / 60, frame / 60, 3.2, Math.PI / 2, {
      velocityX: 3.2,
      velocityZ: 0,
    });
  }
  assert.ok(visual.scene.resolveSlimeVisual(visual.proxyId), 'PBF 玩家的软体表现应由渲染世界持有');
  assert.ok(visual.root.getObjectByName('pbf-slime-surface'));
  assert.ok(Math.abs(rig.faceRoot.rotation.y - Math.PI / 2) < 0.001);

  const beforeCollisionSurface = Float32Array.from(rig.surfacePosition.array);
  visual.update(1 / 60, 331 / 60, 0, Math.PI / 2, {
    velocityX: 0,
    velocityZ: 0,
    collisionDisplacement: { x: 0.04, z: 0 },
  });
  assert.equal(rig.root.userData.hybridSimulationActive, true);
  let contactSideIndentation = 0;
  let contactSideCount = 0;
  for (let offset = 0; offset < rig.surfaceDirections.length; offset += 3) {
    if (rig.surfaceDirections[offset] < 0.65) continue;
    contactSideIndentation += (
      beforeCollisionSurface[offset] - rig.surfacePosition.array[offset]
    );
    contactSideCount += 1;
  }
  assert.ok(
    contactSideIndentation / contactSideCount > render.radius * 0.12,
    '圆柱被阻挡时，朝向障碍的一侧蒙皮必须向核心凹陷',
  );

  for (let frame = 332; frame <= 344; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, Math.PI / 2, {
      velocityX: 0,
      velocityZ: 0,
      collisionDisplacement: { x: 0.04, z: 0 },
    });
  }
  assert.ok(beforeCollisionSurface.some((value, index) => (
    Math.abs(value - rig.surfacePosition.array[index]) > render.radius * 0.02
  )), '真实碰撞必须让可见弹簧蒙皮发生适应性形变');
  const adaptingError = visual.slime.simulation.stats().maximumSkinError;

  for (let frame = 345; frame <= 392; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, Math.PI / 2, {
      velocityX: 0,
      velocityZ: 0,
      collisionDisplacement: { x: 0.04, z: 0 },
    });
  }
  assert.ok(
    visual.slime.simulation.stats().maximumSkinError < adaptingError * 0.6,
    '持续顶住同一碰撞面时只允许平滑恢复，不应每帧重复注入冲击',
  );
  for (let frame = 393; frame <= 512; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, Math.PI / 2, {
      velocityX: 0,
      velocityZ: 0,
    });
  }
  assert.equal(
    rig.root.userData.hybridSimulationActive,
    false,
    '碰撞适应结束后必须进入休眠，避免长期低幅抖动',
  );
  assert.ok(
    Math.hypot(
      visual.slime.simulation.center[0],
      visual.slime.simulation.center[2],
    ) < render.radius * 0.001,
  );
  assert.ok(
    Math.hypot(
      visual.slime.simulation.forceCenter[0] - visual.slime.simulation.center[0],
      visual.slime.simulation.forceCenter[2] - visual.slime.simulation.center[2],
    ) < render.radius * 1e-6,
    '停止后偏心吸引点应回到球形核心，水滴形平滑恢复',
  );
  const shape = resolvePlayerVisualShape(render);
  assert.equal(shape.collisionRadius, 0.52);
  assert.ok(shape.collisionRadius < render.radius * 0.6, '权威圆柱必须留在可变形蒙皮内部');
  visual.dispose();
});

test('混合史莱姆用移动与跳跃速度合成三维水滴轴，并让质量核心反向塌陷', () => {
  const render = pbfSlimeArchetype.components.render;
  assert.ok(render?.model === 'line-art-pbf-slime');
  const visual = createPlayerVisualHarness('jump-visual-player', render, 3.2);
  const simulation = visual.slime.simulation;
  const minimumSurfaceY = (): number => {
    let minimum = Number.POSITIVE_INFINITY;
    for (let offset = 1; offset < simulation.positions.length; offset += 3) {
      minimum = Math.min(minimum, simulation.positions[offset]);
    }
    return minimum;
  };
  const projectionExtent = (axisX: number, axisY: number, axisZ: number): number => {
    const axisLength = Math.hypot(axisX, axisY, axisZ);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let offset = 0; offset < simulation.positions.length; offset += 3) {
      const projection = (
        simulation.positions[offset] * axisX
        + simulation.positions[offset + 1] * axisY
        + simulation.positions[offset + 2] * axisZ
      ) / axisLength;
      minimum = Math.min(minimum, projection);
      maximum = Math.max(maximum, projection);
    }
    return maximum - minimum;
  };
  const axisBandRadius = (
    axisX: number,
    axisY: number,
    minimumAlignment: number,
    maximumAlignment: number,
  ): number => {
    const directions = visual.rig.surfaceDirections;
    let sum = 0;
    let count = 0;
    for (let offset = 0; offset < simulation.positions.length; offset += 3) {
      const alignment = directions[offset] * axisX + directions[offset + 1] * axisY;
      if (alignment < minimumAlignment || alignment > maximumAlignment) continue;
      const localX = simulation.positions[offset] - simulation.center[0];
      const localY = simulation.positions[offset + 1] - simulation.center[1];
      const localZ = simulation.positions[offset + 2] - simulation.center[2];
      const parallel = localX * axisX + localY * axisY;
      sum += Math.sqrt(Math.max(
        0,
        localX * localX + localY * localY + localZ * localZ - parallel * parallel,
      ));
      count += 1;
    }
    return sum / Math.max(1, count);
  };
  const jumpAxisLength = Math.hypot(3.2, 7);
  const jumpAxisX = 3.2 / jumpAxisLength;
  const jumpAxisY = 7 / jumpAxisLength;

  for (let frame = 0; frame < 120; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, {
      velocityX: 0,
      velocityZ: 0,
      verticalVelocity: 0,
      grounded: true,
    });
  }
  const groundedCenterY = simulation.center[1];
  const groundedForceCenterY = simulation.forceCenter[1];
  const groundedLowestY = minimumSurfaceY();
  const groundedJumpAxisExtent = projectionExtent(jumpAxisX, jumpAxisY, 0);

  for (let frame = 120; frame < 180; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, {
      velocityX: 3.2,
      velocityZ: 0,
      verticalVelocity: 7,
      grounded: false,
    });
  }
  const airborneLowestY = minimumSurfaceY();
  const airborneJumpAxisExtent = projectionExtent(jumpAxisX, jumpAxisY, 0);
  const forceBiasX = simulation.forceCenter[0] - simulation.center[0];
  const forceBiasY = simulation.forceCenter[1] - simulation.center[1];
  const forceBiasLength = Math.hypot(forceBiasX, forceBiasY);
  const movingHeadRadius = axisBandRadius(jumpAxisX, jumpAxisY, 0.65, 0.9);
  const trailingTailRadius = axisBandRadius(jumpAxisX, jumpAxisY, -0.9, -0.65);
  assert.ok(
    simulation.center[1] < groundedCenterY - render.radius * 0.12,
    '起跳时质量核心必须相对 Actor 根向下滞后，形成向下塌陷',
  );
  assert.ok(
    airborneLowestY < groundedLowestY - render.radius * 0.1,
    '离地后应释放局部地面钉扎，让底部向下拖出软尾',
  );
  assert.ok(
    airborneJumpAxisExtent > groundedJumpAxisExtent * 1.06,
    '蒙皮必须沿水平移动与竖直冲量的合成轴拉长',
  );
  assert.ok(forceBiasX > render.radius * 0.03 && forceBiasY > render.radius * 0.08);
  assert.ok(
    (forceBiasX * jumpAxisX + forceBiasY * jumpAxisY) / forceBiasLength > 0.98,
    '向心力偏移必须与三维合成速度同向，不能只使用水平或竖直分量',
  );
  assert.ok(
    movingHeadRadius > trailingTailRadius * 1.3,
    '水滴圆头必须沿移动+跳跃合成方向，反方向只能是收窄的拖尾',
  );

  for (let frame = 180; frame < 240; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, {
      velocityX: 3.2,
      velocityZ: 0,
      verticalVelocity: -7,
      grounded: false,
    });
  }
  const fallAxisY = -jumpAxisY;
  const fallForceBiasX = simulation.forceCenter[0] - simulation.center[0];
  const fallForceBiasY = simulation.forceCenter[1] - simulation.center[1];
  const fallForceBiasLength = Math.hypot(fallForceBiasX, fallForceBiasY);
  const fallingHeadRadius = axisBandRadius(jumpAxisX, fallAxisY, 0.65, 0.9);
  const fallingTailRadius = axisBandRadius(jumpAxisX, fallAxisY, -0.9, -0.65);
  assert.ok(
    simulation.center[1] > groundedCenterY + render.radius * 0.12,
    '下落时质量核心应反向向上滞后',
  );
  assert.ok(
    (
      fallForceBiasX * jumpAxisX + fallForceBiasY * fallAxisY
    ) / fallForceBiasLength > 0.98,
    '下落阶段的水滴轴应随移动+下落矢量平滑翻转',
  );
  assert.ok(
    fallingHeadRadius > fallingTailRadius * 1.3,
    '进入下落后水滴圆头也必须转到新的运动方向，尖尾留在反方向',
  );

  for (let frame = 240; frame < 540; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, {
      velocityX: 0,
      velocityZ: 0,
      verticalVelocity: 0,
      grounded: true,
    });
  }
  assert.ok(Math.abs(simulation.center[1] - groundedCenterY) < render.radius * 0.002);
  assert.ok(Math.abs(simulation.forceCenter[1] - groundedForceCenterY) < render.radius * 0.002);
  assert.ok(Math.abs(minimumSurfaceY() - groundedLowestY) < render.radius * 0.004);
  assert.equal(simulation.isActive, false, '落地恢复后应重新休眠，不能持续抖动');
  visual.dispose();
});

test('混合史莱姆起跳首帧移除平底，并让水滴圆头向上、尖尾向下', () => {
  const render = pbfSlimeArchetype.components.render;
  assert.ok(render?.model === 'line-art-pbf-slime');
  const visual = createPlayerVisualHarness('jump-silhouette-player', render, 3.2);
  const component = visual.slime;
  const simulation = component.simulation;
  const directions = component.rig.surfaceDirections;
  const verticalExtent = (): number => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let offset = 1; offset < simulation.positions.length; offset += 3) {
      minimum = Math.min(minimum, simulation.positions[offset]);
      maximum = Math.max(maximum, simulation.positions[offset]);
    }
    return maximum - minimum;
  };
  const bandPlanarRadius = (minimumDirectionY: number, maximumDirectionY: number): number => {
    let sum = 0;
    let count = 0;
    for (let offset = 0; offset < simulation.positions.length; offset += 3) {
      const directionY = directions[offset + 1];
      if (directionY < minimumDirectionY || directionY > maximumDirectionY) continue;
      sum += Math.hypot(
        simulation.positions[offset] - simulation.center[0],
        simulation.positions[offset + 2] - simulation.center[2],
      );
      count += 1;
    }
    return sum / Math.max(1, count);
  };
  const bandAverageY = (minimumDirectionY: number, maximumDirectionY: number): number => {
    let sum = 0;
    let count = 0;
    for (let offset = 0; offset < simulation.positions.length; offset += 3) {
      const directionY = directions[offset + 1];
      if (directionY < minimumDirectionY || directionY > maximumDirectionY) continue;
      sum += simulation.positions[offset + 1];
      count += 1;
    }
    return sum / Math.max(1, count);
  };

  for (let frame = 0; frame < 120; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, {
      velocityX: 0,
      velocityZ: 0,
      verticalVelocity: 0,
      grounded: true,
    });
  }
  const groundedExtent = verticalExtent();
  const groundedTaperRatio = bandPlanarRadius(-0.9, -0.65)
    / bandPlanarRadius(0.65, 0.9);
  let maximumExtentRatio = 1;
  let minimumTailToHeadRatio = groundedTaperRatio;
  let firstFrameTailToHeadRatio = groundedTaperRatio;
  let sixthFrameTailToHeadRatio = groundedTaperRatio;
  let firstFrameBottomCurveDepth = 0;
  let sixthFrameBottomCurveDepth = 0;
  let maximumRememberedJumpSpeed = 0;
  let verticalVelocity = 7;
  for (let frame = 120; frame < 156; frame += 1) {
    visual.update(1 / 60, frame / 60, 0, 0, {
      velocityX: 0,
      velocityZ: 0,
      verticalVelocity,
      grounded: false,
    });
    verticalVelocity -= 22 / 60;
    maximumExtentRatio = Math.max(maximumExtentRatio, verticalExtent() / groundedExtent);
    const tailToHeadRatio = bandPlanarRadius(-0.9, -0.65)
      / bandPlanarRadius(0.65, 0.9);
    const bottomCurveDepth = bandAverageY(-0.55, -0.25) - bandAverageY(-1, -0.95);
    minimumTailToHeadRatio = Math.min(minimumTailToHeadRatio, tailToHeadRatio);
    if (frame === 120) {
      firstFrameTailToHeadRatio = tailToHeadRatio;
      firstFrameBottomCurveDepth = bottomCurveDepth;
    }
    if (frame === 125) {
      sixthFrameTailToHeadRatio = tailToHeadRatio;
      sixthFrameBottomCurveDepth = bottomCurveDepth;
    }
    maximumRememberedJumpSpeed = Math.max(
      maximumRememberedJumpSpeed,
      simulation.stats().shapeVerticalVelocity,
    );
  }

  assert.ok(maximumRememberedJumpSpeed > 6.5, '起跳冲量必须立即进入黏性形变状态');
  assert.ok(
    maximumExtentRatio > 1.2,
    `真实上升阶段的纵向轮廓至少应增加 20%，当前为 ${maximumExtentRatio.toFixed(3)}`,
  );
  assert.ok(
    firstFrameTailToHeadRatio < groundedTaperRatio * 0.96,
    '起跳首帧必须已经开始形成上宽下尖，不能等到最高点才变化',
  );
  assert.ok(
    sixthFrameTailToHeadRatio < groundedTaperRatio * 0.78,
    `起跳第六帧必须形成圆头向上、尖尾向下，当前比例 ${(
      sixthFrameTailToHeadRatio / groundedTaperRatio
    ).toFixed(3)}`,
  );
  assert.ok(
    minimumTailToHeadRatio < groundedTaperRatio * 0.65,
    '完整上升阶段的下方尖尾必须明显窄于上方水滴头',
  );
  assert.ok(
    firstFrameBottomCurveDepth > render.radius * 0.025,
    '史莱姆底面必须在起跳首帧脱离平面，底点应低于周围下半球',
  );
  assert.ok(
    sixthFrameBottomCurveDepth > render.radius * 0.14,
    '起跳后史莱姆下方必须保持连续弧形尖尾，不能出现平底层',
  );
  visual.dispose();
});

test('高数量物品 Actor 保留交互与碰撞身份，但用批次绘制而没有独立 Object3D', () => {
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
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
  stepActorFrame(system, 0, 0);

  const actor = system.getActor(wood.id)!;
  assert.equal(actor.getComponent(RENDER_PROXY_COMPONENT), undefined);
  assert.equal((actor.requireComponent(ITEM_STACK_COMPONENT) as ItemStackComponent).quantity, 12);
  assert.ok(actor.getComponent(SIMPLE_COLLISION_COMPONENT));
  assert.equal(system.findNearbyInteractableActor({ x: 1, z: 2 })?.quantity, 12);

  const batchRoot = renderRootOf(system).getObjectByName('high-count-actor-batches')!;
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

test('准星也拾得到合批掉落物——它们没有 proxy，但有碰撞体', () => {
  // 合并成一条解析路径之前，「有 proxy 的打场景图、没 proxy 的解析算」是两段
  // 代码。这条用例钉住合并之后没 proxy 的那一半还在。
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const wood: SnapshotActor = {
    id: 'drop-wood',
    archetypeId: 'wood-pile',
    revision: 2,
    transform: { x: 0, y: 0, z: -3, yaw: 0 },
    interactable: { action: 'pickup-stack', label: '木材', enabled: true, revision: 0 },
    itemStack: { itemType: 'wood', displayName: '木材', quantity: 12, maximumQuantity: 999, revision: 1 },
    residency: { state: 'sleeping', revision: 1 },
  };
  system.syncSnapshots([wood], 1_000, 1_000);
  stepActorFrame(system, 0, 0);
  assert.equal(system.getActor('drop-wood')?.getComponent(RENDER_PROXY_COMPONENT), undefined);
  assert.equal(
    system.pickInteractableActor([0, 0.2, 2], [0, 0, -1])?.actorId,
    'drop-wood',
  );
  // 打偏了同样不算：合批物走的是同一条求交，不是「离得近就算」。
  assert.equal(system.pickInteractableActor([3, 0.2, 2], [0, 0, -1]), undefined);
  system.dispose();
});

test('木堆与石堆各自成批：合批系统按渲染模型分派模板，不是只认木堆', () => {
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const wood: SnapshotActor = {
    id: 'drop-wood',
    archetypeId: 'wood-pile',
    revision: 2,
    transform: { x: 1, y: 0, z: 2, yaw: 0.2 },
    interactable: { action: 'pickup-stack', label: '木材', enabled: true, revision: 0 },
    itemStack: { itemType: 'wood', displayName: '木材', quantity: 12, maximumQuantity: 999, revision: 1 },
    residency: { state: 'sleeping', revision: 1 },
  };
  const stone: SnapshotActor = {
    id: 'drop-stone',
    archetypeId: 'stone-pile',
    revision: 2,
    transform: { x: 4, y: 0, z: 2, yaw: -0.4 },
    interactable: { action: 'pickup-stack', label: '石料', enabled: true, revision: 0 },
    itemStack: { itemType: 'stone', displayName: '石料', quantity: 3, maximumQuantity: 999, revision: 1 },
    residency: { state: 'sleeping', revision: 1 },
  };
  system.syncSnapshots([wood, stone], 1_000, 1_000);
  stepActorFrame(system, 0, 0);

  const batchRoot = renderRootOf(system).getObjectByName('high-count-actor-batches')!;
  const fills: THREE.InstancedMesh[] = [];
  batchRoot.traverse((object) => {
    if ((object as THREE.InstancedMesh).isInstancedMesh) fills.push(object as THREE.InstancedMesh);
  });
  // 两种原型 → 两个批次，各一个实例；石堆没有走成木堆的模板。
  assert.equal(fills.length, 2);
  assert.deepEqual(fills.map((fill) => fill.count), [1, 1]);
  const vertexCounts = fills.map((fill) => fill.geometry.getAttribute('position').count);
  assert.notEqual(
    vertexCounts[0],
    vertexCounts[1],
    '圆木与石块的模板顶点数应该不同，相同说明分派没生效',
  );

  // 两种堆都保留各自的交互身份。
  assert.equal(system.findNearbyInteractableActor({ x: 1, z: 2 })?.actorId, 'drop-wood');
  assert.equal(system.findNearbyInteractableActor({ x: 4, z: 2 })?.actorId, 'drop-stone');
  system.dispose();
});

test('圆木使用参考项目的八边形单根模型，并按权威位移滚动', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const snapshot = (x: number): SnapshotActor => ({
    id: 'drop-wood-log-roll',
    archetypeId: 'wood-log',
    revision: 0,
    transform: { x, y: 0.11, z: 0, yaw: 0 },
    interactable: { action: 'pickup-stack', label: '圆木', enabled: true, revision: 0 },
    itemStack: {
      itemType: 'wood-log', displayName: '圆木', quantity: 1, maximumQuantity: 999, revision: 0,
    },
    residency: { state: 'active', revision: 0 },
  });

  system.syncSnapshots([snapshot(0)], 1_000, now);
  stepActorFrame(system, 0, 0);
  const fill = renderRootOf(system).getObjectByName(
    'wood-log:active:normal:single-fill',
  ) as THREE.InstancedMesh;
  assert.ok(fill, '单根圆木应进入独立的高数量合批');
  fill.geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  fill.geometry.boundingBox!.getSize(size);
  assert.ok(size.x > size.y * 3, '参考模型应保持细长的八边形圆柱比例');

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const before = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  fill.getMatrixAt(0, matrix);
  matrix.decompose(position, before, scale);

  now = 1_100;
  system.syncSnapshots([snapshot(0.55)], 1_100, now);
  now = 1_220;
  stepActorFrame(system, 0, 0);
  const after = new THREE.Quaternion();
  fill.getMatrixAt(0, matrix);
  matrix.decompose(position, after, scale);
  assert.ok(before.angleTo(after) > 0.1, '权威水平位移应转换为圆木的滚动角');
  system.dispose();
});

const fruitPileArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'fruit-pile',
  components: {
    interactable: { action: 'pickup-stack', label: '果实', maximumDistance: 2.4 },
    itemStack: {
      itemType: 'fruit', displayName: '果实',
      defaultQuantity: 1, maximumQuantity: 999, compatibilityKey: 'fruit-standard',
    },
    actorResidency: { sleepDelaySeconds: 1, dormantDelaySeconds: 3, dormantEligible: true },
    dropMotion: {
      gravity: 9.8,
      drag: 0.45,
      groundDrag: 2.4,
      restitution: 0.28,
      radius: 0.14,
      settleSpeed: 0.08,
    },
    lifetime: { lifetimeSeconds: 300 },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
    render: {
      model: 'line-art-fruit-pile', fruitColor: '#d4694f', accentColor: '#e8a24c',
      inkColor: '#5c2f26', radius: 0.42, height: 0.3,
    },
  },
};

const fruitTreeArchetype: SceneDefinition['actorArchetypes'][number] = {
  schemaVersion: 1,
  id: 'fruit-tree',
  components: {
    interactable: { action: 'harvest-prop', label: '果树', maximumDistance: 2.6 },
    generatedProp: {
      regrow: { seconds: 120 },
      drop: { archetypeId: 'fruit-pile', quantity: 3, spawnPattern: 'fruit-anchors' },
    },
    replicationPolicy: { mode: 'aoi', radiusChunks: 2 },
  },
};

/** 和主场景同一套世界生成，只把 tree 换绑到可再生的果树上。 */
const orchardDefinition = {
  ...definition,
  actorArchetypes: [...definition.actorArchetypes, fruitTreeArchetype, fruitPileArchetype],
  gameplay: {
    ...definition.gameplay,
    worldProps: { tree: [{ archetypeId: 'fruit-tree', weight: 1 }] },
  },
} satisfies SceneDefinition;

test('单颗果实按权威位移旋转，sleeping 后不再累积滚动角', () => {
  let now = 1_000;
  const system = createTestActorSystem({
    definition: orchardDefinition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const snapshot = (x: number, state: 'active' | 'sleeping'): SnapshotActor => ({
    id: 'drop-fruit-roll',
    archetypeId: 'fruit-pile',
    revision: state === 'active' ? 0 : 1,
    transform: { x, y: 0.14, z: 0, yaw: 0 },
    interactable: { action: 'pickup-stack', label: '果实', enabled: true, revision: 0 },
    itemStack: {
      itemType: 'fruit', displayName: '果实', quantity: 1, maximumQuantity: 999, revision: 0,
    },
    residency: { state, revision: state === 'active' ? 0 : 1 },
  });

  system.syncSnapshots([snapshot(0, 'active')], 1_000, now);
  stepActorFrame(system, 0, 0);
  const collision = system.getActor('drop-fruit-roll')!
    .requireComponent(SIMPLE_COLLISION_COMPONENT) as SimpleCollisionComponent;
  assert.equal(collision.halfWidth, 0.14, '滚动物使用配置的球半径，不沿用整堆碰撞盒');

  now = 1_100;
  system.syncSnapshots([snapshot(0.7, 'active')], 1_100, now);
  now = 1_220;
  stepActorFrame(system, 0, 0);
  const activeFill = renderRootOf(system).getObjectByName(
    'fruit-pile:active:normal:single-fill',
  ) as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  activeFill.getMatrixAt(0, matrix);
  matrix.decompose(position, rotation, scale);
  assert.ok(Math.abs(rotation.z) > 0.1, '沿 +X 位移时果实应绕 Z 轴产生滚动角');

  now = 1_300;
  system.syncSnapshots([snapshot(0.7, 'sleeping')], 1_200, now);
  now = 1_420;
  stepActorFrame(system, 0, 0);
  const sleepingFill = renderRootOf(system).getObjectByName(
    'fruit-pile:sleeping:normal:single-fill',
  ) as THREE.InstancedMesh;
  const sleepingRotation = new THREE.Quaternion();
  sleepingFill.getMatrixAt(0, matrix);
  matrix.decompose(position, sleepingRotation, scale);
  assert.ok(rotation.angleTo(sleepingRotation) < 1e-6, '休眠后没有位移就不应继续自转');
  system.dispose();
});

const mixedTreeVariants = [
  { archetypeId: 'generated-tree', weight: 5 },
  { archetypeId: 'fruit-tree', weight: 1 },
];

const mixedForestDefinition = {
  ...definition,
  actorArchetypes: [...definition.actorArchetypes, fruitTreeArchetype, fruitPileArchetype],
  gameplay: {
    ...definition.gameplay,
    worldProps: {
      ...definition.gameplay.worldProps,
      tree: mixedTreeVariants,
    },
  },
} satisfies SceneDefinition;

test('客户端用同一世界种子为每棵树选择确定的普通树或果树原型', () => {
  const worldSeed = 0x5c1a2d0b;
  const system = createTestActorSystem({
    definition: mixedForestDefinition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    worldSeed,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  const props = new Int32Array(PROP_BUFFER_LENGTH);
  const propCount = generateChunkProps(worldSeed, -1, 0, props);
  system.mountGeneratedPropChunk('-1:0', -1, 0, props, propCount);

  const treeArchetypes: string[] = [];
  for (let propIndex = 0; propIndex < propCount; propIndex += 1) {
    const kind = props[propIndex * PROP_STRIDE + PROP_FIELD.KIND];
    if (kind !== PROP_KIND.TREE) continue;
    const actorId = formatGeneratedPropId(kind, -1, 0, propIndex);
    const actor = system.getActor(actorId)!;
    const expected = selectWorldPropVariant(
      worldSeed,
      kind,
      -1,
      0,
      propIndex,
      mixedTreeVariants,
    );
    assert.equal(actor.archetypeId, expected?.archetypeId);
    treeArchetypes.push(actor.archetypeId);
  }
  assert.ok(treeArchetypes.includes('generated-tree'));
  assert.ok(treeArchetypes.includes('fruit-tree'));
  stepActorFrame(system, 0, 0);
  const fruitRoot = renderRootOf(system).getObjectByName('generated-prop-fruit')!;
  const fruitFill = fruitRoot.children.find(
    (child) => (child as THREE.InstancedMesh).isInstancedMesh,
  ) as THREE.InstancedMesh;
  assert.equal(
    fruitFill.count,
    Array.from({ length: propCount }, (_, propIndex) => {
      const actorId = formatGeneratedPropId(PROP_KIND.TREE, -1, 0, propIndex);
      const actor = system.getActor(actorId);
      if (actor?.archetypeId !== 'fruit-tree') return 0;
      return (actor.requireComponent(GENERATED_PROP_COMPONENT) as GeneratedPropComponent).dropQuantity;
    }).reduce((total, count) => total + count, 0),
    '只有哈希选中的果树挂果，普通树不应出现果子',
  );
  system.dispose();
});

test('果子按服务端时钟自己熟：冷却中不画也不能交互，到期后无需新快照就恢复', () => {
  let now = 1_000_000;
  const system = createTestActorSystem({
    definition: orchardDefinition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
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

  // 客户端与服务端时钟差 5 分钟：冷却必须按服务端时间算，否则整个偏掉。
  const serverTime = now - 300_000;
  system.syncSnapshots([], serverTime, now);
  system.mountGeneratedPropChunk('-1:0', -1, 0, props, propCount);
  stepActorFrame(system, 0, 0);

  const fruitRoot = renderRootOf(system).getObjectByName('generated-prop-fruit')!;
  assert.ok(fruitRoot, '有果树的地图才挂这一层');
  const fill = fruitRoot.children.find(
    (child) => (child as THREE.InstancedMesh).isInstancedMesh,
  ) as THREE.InstancedMesh;
  const ripeCount = fill.count;
  assert.ok(ripeCount > 0, '默认是熟的，应该画出果子');

  const actorId = formatGeneratedPropId(PROP_KIND.TREE, -1, 0, propIndex);
  const actor = system.getActor(actorId)!;
  const fruitCount = (actor.requireComponent(GENERATED_PROP_COMPONENT) as GeneratedPropComponent).dropQuantity;
  const interactable = actor.requireComponent(INTERACTABLE_COMPONENT) as InteractableComponent;
  assert.equal(interactable.enabled, true);

  // 摘掉一棵：只发 readyAt，不发第二条「长回来」的快照。
  const readyAt = (serverTime + 120_000) / 1000;
  system.syncSnapshots([{
    id: actorId,
    revision: 4,
    propState: { removed: false, readyAt },
  }], serverTime + 1, now);
  // 快照缓冲有 120ms 插值延迟，要等这一帧真的被采样到。
  now += 200;
  stepActorFrame(system, 0, 0);
  assert.equal(fill.count, ripeCount - fruitCount, '这一棵配置数量的果子应该消失');
  assert.equal(interactable.enabled, false, '冷却中不该还提示可采');

  // 时间过去，没有任何新快照，果子自己回来。
  now += 121_000;
  stepActorFrame(system, 0, 0);
  assert.equal(fill.count, ripeCount, '到期后无需新快照就恢复');
  assert.equal(interactable.enabled, true);
  system.dispose();
});

test('流式树按 Chunk 构造无网格 Actor，偏离态可在无 Transform 快照中应用且不会误删', () => {
  let now = 1_000;
  const collision = new CollisionWorld();
  const overrides: Array<{ chunkX: number; chunkZ: number; propIndex: number; removed: boolean }> = [];
  const system = createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    collision,
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  system.setGeneratedPropOverrideTarget((chunkX, chunkZ, propIndex, removed) => {
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
  system.mountGeneratedPropChunk('-1:0', -1, 0, props, propCount);
  stepActorFrame(system, 0, 0);

  const actorId = formatGeneratedPropId(PROP_KIND.TREE, -1, 0, propIndex);
  const actor = system.getActor(actorId)!;
  assert.ok(actor);
  assert.equal(actor.hasComponents(RENDER_PROXY_COMPONENT), false);
  const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
  assert.equal(
    system.findNearbyInteractableActor({ x: transform.x + 0.2, z: transform.z })?.actorId,
    actorId,
  );

  system.syncSnapshots([{
    id: actorId,
    revision: 3,
    propState: { health: 0, removed: true },
  }], 1_000);
  stepActorFrame(system, 0, 0);
  const tree = actor.requireComponent(GENERATED_PROP_COMPONENT) as GeneratedPropComponent;
  assert.equal(tree.removed, true);
  assert.deepEqual(overrides.at(-1), { chunkX: -1, chunkZ: 0, propIndex, removed: true });

  now = 1_100;
  system.syncSnapshots([], 1_100);
  now = 1_230;
  stepActorFrame(system, 0, 0);
  assert.equal(system.getActor(actorId), actor);
  system.unmountGeneratedPropChunk('-1:0');
  assert.equal(system.getActor(actorId), undefined);
  system.dispose();
});


import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  CARGO_COMPONENT,
  ELASTIC_TETHER_COMPONENT,
  type CargoComponent,
  type ElasticTetherComponent,
} from '../shared/actor/index.mjs';
import { ClientActorSystem } from '../src/actors/ClientActorSystem';
import { ActorInteractionController } from '../src/controllers/ActorInteractionController';
import {
  createPlayerInputScheme,
  InputSubsystem,
} from '../src/input/index';
import { BufferedInputDevice } from '../src/input/devices/BufferedInputDevice';
import type { SnapshotActor } from '../src/network/protocol';
import type { ActorInteractionCandidate } from '../src/scene/SceneVisualSystem';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';

const definition = {
  schemaVersion: 1,
  id: 'water',
  displayName: '水域',
  description: 'interaction test',
  capacity: 8,
  sceneComponents: [],
  actors: [],
  actorArchetypes: [
    {
      schemaVersion: 1,
      id: 'raft',
      components: {
        buoyancy: {
          minimumBeam: 3.2,
          minimumLength: 4.8,
          maximumTrimRadians: 0.09,
          minimumDraft: 0.08,
          maximumDraft: 0.28,
          parts: [{ id: 'float', mass: 10, buoyancy: 20, integrity: 1, localX: 0, localZ: 0 }],
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
        render: { model: 'line-art-raft', foamColor: '#fffdf7', length: 4.8, width: 3.2 },
      },
    },
    {
      schemaVersion: 1,
      id: 'cargo-crate',
      components: {
        interactable: { action: 'cargo-toggle', label: '测试货箱', maximumDistance: 7 },
        cargo: { mass: 55, mountLocalX: 0, mountLocalY: 0.62, mountLocalZ: 0.5 },
        render: {
          model: 'line-art-cargo-crate', color: '#a07850', accentColor: '#6f5138',
          length: 0.9, width: 0.9, height: 0.72,
        },
      },
    },
    {
      schemaVersion: 1,
      id: 'reef',
      components: {
        hazard: { radius: 2, damage: 0.2, cooldownMs: 1000, partId: 'float' },
        render: {
          model: 'line-art-reef', color: '#887b6e', accentColor: '#514c47', radius: 1, height: 1.4,
        },
      },
    },
    {
      schemaVersion: 1,
      id: 'elastic-mushroom',
      components: {
        interactable: { action: 'mushroom-bite', label: '弹弹菇', maximumDistance: 1.35 },
        elasticTether: {
          restLength: 0.72,
          breakLength: 2.65,
        },
        render: {
          model: 'line-art-elastic-mushroom', capColor: '#c97868', stemColor: '#eadfc5',
          spotColor: '#f8f1df', radius: 0.5, height: 0.95,
        },
      },
    },
  ],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: true },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
    ocean: {
      size: 32, segments: 8, waveHeight: 0.2, waveSpeed: 0.8, noiseScale: 0.08,
      noiseStrength: 1, interlaceStrength: 0.4, surfaceColor: '#d7e7e5',
      secondaryColor: '#c6dcdb', gridLineColor: '#617f82', gridLineOpacity: 0.3,
    },
  },
  gameplay: {
    playerActor: { archetypeId: 'player-slime' },
    bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    spawn: { centerX: 0, centerZ: 0, radius: 0, slots: 8 },
    water: { seaLevel: 0 },
  },
  camera: { mode: 'fly', position: [0, 1, 5], yaw: 0, pitch: 0, moveSpeed: 8 },
} satisfies SceneDefinition;

const raftSnapshot: SnapshotActor = {
  id: 'raft-1', archetypeId: 'raft', revision: 1,
  transform: { x: 5, y: 0, z: 0, yaw: 0 },
  buoyancy: {
    state: 'afloat', draft: 0.1, staticRoll: 0, staticPitch: 0, speedFactor: 1,
    cargoMass: 0, damagedPartCount: 0, eventRevision: 0, lastEvent: null,
  },
  vessel: { speed: 1.25, throttle: 0.5, steering: 0 },
  control: { ownerPlayerId: 'player-1', revision: 1 },
};

const cargoSnapshot: SnapshotActor = {
  id: 'cargo-1', archetypeId: 'cargo-crate', revision: 0,
  transform: { x: 0, y: 0, z: 0, yaw: 0 },
  interactable: { action: 'cargo-toggle', label: '测试货箱', enabled: true, revision: 0 },
  cargo: { mass: 55, carrierActorId: null, revision: 0 },
};

const reefSnapshot: SnapshotActor = {
  id: 'reef-1', archetypeId: 'reef', revision: 0,
  transform: { x: -5, y: -0.4, z: 0, yaw: 0 },
  hazard: { radius: 2 },
};

const mushroomSnapshot: SnapshotActor = {
  id: 'mushroom-1', archetypeId: 'elastic-mushroom', revision: 0,
  transform: { x: 0, y: 0, z: 0, yaw: 0 },
  interactable: { action: 'mushroom-bite', label: '弹弹菇', enabled: true, revision: 0 },
  elasticTether: {
    holderPlayerId: null, targetX: 0, targetY: 0, targetZ: 0,
    releaseRevision: 0, revision: 0,
  },
};

/** beforeRender 会读画布尺寸给引导线算像素线宽；测试只需要这一个字段。 */
const FAKE_RENDERER = {
  domElement: { width: 1280, height: 720 },
} as unknown as THREE.WebGLRenderer;

test('异构 Actor 创建线稿模型，准星选中货箱并提供木筏 HUD 状态', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  system.syncSnapshots([raftSnapshot, cargoSnapshot, reefSnapshot], 1_000);
  system.update(0, 0);

  const picked = system.pickInteractableActor([0, 0.4, 5], [0, 0, -1]);
  assert.equal(picked?.actorId, 'cargo-1');
  assert.equal(picked?.carrierActorId, null);
  system.setHoveredActorId('cargo-1');
  assert.ok(system.root.getObjectByName('actor-interaction-highlight'));
  assert.equal(system.getVesselHudState('player-1')?.speed, 1.25);

  now = 1_100;
  system.syncSnapshots([
    { ...raftSnapshot, revision: 2, buoyancy: { ...raftSnapshot.buoyancy!, cargoMass: 55, eventRevision: 1, lastEvent: { type: 'cargo:add', targetId: 'cargo-1' } } },
    { ...cargoSnapshot, revision: 1, cargo: { mass: 55, carrierActorId: 'raft-1', revision: 1 } },
    reefSnapshot,
  ], 1_100);
  now = 1_230;
  system.update(0, 0);
  const cargo = system.getActor('cargo-1')?.requireComponent(CARGO_COMPONENT) as CargoComponent;
  assert.equal(cargo.carrierActorId, 'raft-1');
  assert.equal(system.getVesselHudState('player-1')?.cargoMass, 55);

  now = 1_400;
  system.syncSnapshots([raftSnapshot, reefSnapshot], 1_400);
  now = 1_530;
  system.update(0, 0);
  assert.equal(system.root.getObjectByName('actor-interaction-highlight'), undefined);
  system.dispose();
});

class TestKeyboardDevice extends BufferedInputDevice {
  public constructor(private readonly now: () => number) { super('keyboardMouse'); }
  public emit(control: string, value: boolean): void { this.setDigital(control, value, this.now()); }
}

class TestGamepadDevice extends BufferedInputDevice {
  public constructor(private readonly now: () => number) { super('gamepad'); }
  public emit(control: string, value: boolean): void { this.setDigital(control, value, this.now()); }
}

test('E 键只对当前准星货箱发送交互，未控制木筏时只显示提示', () => {
  let now = 0;
  let ownedActorId: string | undefined = 'raft-1';
  let candidate: ActorInteractionCandidate | undefined = {
    actorId: 'cargo-1', label: '测试货箱', action: 'cargo-toggle',
    carrierActorId: null, holderPlayerId: null,
  };
  const sent: string[] = [];
  const prompts: Array<string | undefined> = [];
  const hovered: Array<string | undefined> = [];
  const device = new TestKeyboardDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions, config: scheme.config, contexts: scheme.contexts,
    devices: [device], now: () => now,
  });
  const controller = new ActorInteractionController(input, {
    getPlayerId: () => 'player-1',
    findOwnedActorId: () => ownedActorId,
    pick: () => candidate,
    getInputLabel: (tag) => {
      const control = input.getMappedControls(tag)[0];
      return control ? scheme.getControlLabel(control) : undefined;
    },
    setHoveredActorId: (actorId) => hovered.push(actorId),
    sendInteraction: (actorId) => sent.push(actorId),
    setPrompt: (text) => prompts.push(text),
  });
  const frame = {
    position: [0, 1, 5],
    axes: { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
  } as const;

  device.emit('Keyboard.KeyE', true);
  input.update();
  controller.update(frame);
  assert.deepEqual(sent, ['cargo-1']);
  assert.match(prompts.at(-1) ?? '', /装载/);
  assert.equal(hovered.at(-1), 'cargo-1');

  device.emit('Keyboard.KeyE', false);
  now = 10;
  input.update();
  ownedActorId = undefined;
  now = 20;
  device.emit('Keyboard.KeyE', true);
  input.update();
  controller.update(frame);
  assert.deepEqual(sent, ['cargo-1']);
  assert.match(prompts.at(-1) ?? '', /先按 F/);

  candidate = undefined;
  controller.update(frame);
  assert.equal(prompts.at(-1), undefined);
  controller.dispose();
  input.dispose();
});

test('史莱姆靠近时显示当前设备的世界交互键，按映射键可叼住蘑菇', () => {
  let now = 0;
  const sent: string[] = [];
  const markers: Array<{ actorId?: string; inputLabel?: string }> = [];
  const prompts: Array<string | undefined> = [];
  const device = new TestKeyboardDevice(() => now);
  const gamepad = new TestGamepadDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions, config: scheme.config, contexts: scheme.contexts,
    devices: [device, gamepad], now: () => now,
  });
  const candidate: ActorInteractionCandidate = {
    actorId: 'mushroom-1', label: '弹弹菇', action: 'mushroom-bite',
    carrierActorId: null, holderPlayerId: null,
  };
  const controller = new ActorInteractionController(input, {
    getPlayerId: () => 'player-1',
    getPlayerPosition: () => ({ x: 0.4, z: 0 }),
    findOwnedActorId: () => undefined,
    pick: () => undefined,
    findNearby: () => candidate,
    getInputLabel: (tag) => {
      const control = input.getMappedControls(tag)[0];
      return control ? scheme.getControlLabel(control) : undefined;
    },
    setHoveredActorId: () => undefined,
    setInteractionMarkerActorId: (actorId, inputLabel) => markers.push({ actorId, inputLabel }),
    sendInteraction: (actorId) => sent.push(actorId),
    setPrompt: (text) => prompts.push(text),
  });
  const frame = {
    position: [0, 5, 8],
    axes: { right: [1, 0, 0], up: [0, 1, 0], forward: [0, -0.5, -1] },
  } as const;

  device.emit('Keyboard.KeyE', true);
  input.update();
  controller.update(frame);
  assert.deepEqual(sent, ['mushroom-1']);
  assert.deepEqual(markers.at(-1), { actorId: 'mushroom-1', inputLabel: 'E' });
  assert.match(prompts.at(-1) ?? '', /^E · 叼住/);

  device.emit('Keyboard.KeyE', false);
  now = 10;
  input.update();
  now = 20;
  gamepad.emit('Gamepad.ButtonWest', true);
  input.update();
  controller.update(frame);
  assert.deepEqual(markers.at(-1), { actorId: 'mushroom-1', inputLabel: 'Y' });
  assert.match(prompts.at(-1) ?? '', /^Y · 叼住/);

  scheme.rebind('WorldInteract.Keyboard.Primary', 'Keyboard.KeyQ');
  input.replaceMappingContexts(scheme.contexts);
  now = 30;
  device.emit('Keyboard.KeyQ', true);
  input.update();
  controller.update(frame);
  assert.deepEqual(markers.at(-1), { actorId: 'mushroom-1', inputLabel: 'Q' });
  assert.match(prompts.at(-1) ?? '', /^Q · 叼住/);
  controller.dispose();
  input.dispose();
});

test('靠近生成树时显示砍伐提示，并直接发送自描述 Actor id', () => {
  let now = 0;
  const sent: string[] = [];
  const prompts: Array<string | undefined> = [];
  const device = new TestKeyboardDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });
  const tree: ActorInteractionCandidate = {
    actorId: 'prop:tree:-1:0:12',
    label: '树木',
    action: 'harvest-prop',
    carrierActorId: null,
    holderPlayerId: null,
  };
  const controller = new ActorInteractionController(input, {
    getPlayerId: () => 'player-1',
    getPlayerPosition: () => ({ x: -2, z: 1 }),
    findOwnedActorId: () => undefined,
    pick: () => undefined,
    findNearby: () => tree,
    getInputLabel: () => 'E',
    setHoveredActorId: () => undefined,
    sendInteraction: (actorId) => sent.push(actorId),
    setPrompt: (prompt) => prompts.push(prompt),
  });
  device.emit('Keyboard.KeyE', true);
  input.update();
  controller.update({
    position: [0, 5, 8],
    axes: { right: [1, 0, 0], up: [0, 1, 0], forward: [0, -0.5, -1] },
  });
  assert.deepEqual(sent, ['prop:tree:-1:0:12']);
  assert.equal(prompts.at(-1), 'E · 砍伐「树木」');
  controller.dispose();
  input.dispose();
});

test('弹性蘑菇 Replica 拉长并在释放后回弹，标记组件始终可面向相机', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    // 这些用例不测建模节流：一帧建完，断言才好写。分帧建模由
    // ClientActorSystem.spawn.test.ts 单独覆盖。
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
  system.syncSnapshots([mushroomSnapshot], 1_000);
  system.update(0, 0);
  assert.equal(system.findNearbyInteractableActor({ x: 0.6, z: 0 })?.actorId, 'mushroom-1');

  system.setInteractionMarkerActorId('mushroom-1', 'E');
  const actor = system.getActor('mushroom-1');
  // 标记住在渲染世界里；Actor 那侧什么都不剩。
  const markers = system.getActorRenderProxy('mushroom-1')!.markers;
  assert.equal(markers.interactionVisible, true);
  assert.equal(markers.interactionLabel, 'E');
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(4, 6, 8);
  system.beforeRender(FAKE_RENDERER, camera);
  const markerRoot = system.root.getObjectByName('actor-interaction-marker');
  assert.ok(markerRoot);
  assert.equal(markerRoot.userData.controlLabel, 'E');
  const glyph = markerRoot.getObjectByName('actor-interaction-marker-glyph');
  assert.ok(glyph instanceof THREE.Mesh);

  now = 1_100;
  system.syncSnapshots([{
    ...mushroomSnapshot,
    revision: 1,
    interactable: { ...mushroomSnapshot.interactable!, enabled: false, revision: 1 },
    elasticTether: {
      holderPlayerId: 'player-1', targetX: 2.2, targetY: 0.3, targetZ: 0,
      releaseRevision: 0, revision: 1,
    },
  }], 1_100);
  now = 1_230;
  for (let index = 0; index < 90; index += 1) system.update(1 / 60, index / 60);
  const render = system.getActorRenderProxy(actor!.id)!;
  const stretchedScale = render.elasticTetherRig?.stemRoot.scale.y ?? 1;
  assert.ok(stretchedScale > 2);
  const tether = actor?.requireComponent(ELASTIC_TETHER_COMPONENT) as ElasticTetherComponent;
  assert.equal(tether.holderPlayerId, 'player-1');

  now = 1_400;
  system.syncSnapshots([{
    ...mushroomSnapshot,
    revision: 2,
    elasticTether: {
      holderPlayerId: null, targetX: 2.2, targetY: 0.3, targetZ: 0,
      releaseRevision: 1, revision: 2,
    },
  }], 1_400);
  now = 1_530;
  for (let index = 0; index < 180; index += 1) system.update(1 / 60, 2 + index / 60);
  const returnedScale = render.elasticTetherRig?.stemRoot.scale.y ?? 99;
  assert.ok(returnedScale < stretchedScale);
  assert.ok(Math.abs(returnedScale - 1) < 0.2);
  system.dispose();
});

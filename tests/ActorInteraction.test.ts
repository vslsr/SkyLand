import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARGO_COMPONENT,
  type CargoComponent,
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
  ],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: true },
    grassInteraction: { mouse: false },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
    ocean: {
      size: 32, segments: 8, waveHeight: 0.2, waveSpeed: 0.8, noiseScale: 0.08,
      noiseStrength: 1, interlaceStrength: 0.4, surfaceColor: '#d7e7e5',
      secondaryColor: '#c6dcdb', gridLineColor: '#617f82', gridLineOpacity: 0.3,
    },
  },
  gameplay: {
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

test('异构 Actor 创建线稿模型，准星选中货箱并提供木筏 HUD 状态', () => {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
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

test('E 键只对当前准星货箱发送交互，未控制木筏时只显示提示', () => {
  let now = 0;
  let ownedActorId: string | undefined = 'raft-1';
  let candidate: ActorInteractionCandidate | undefined = {
    actorId: 'cargo-1', label: '测试货箱', action: 'cargo-toggle', carrierActorId: null,
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

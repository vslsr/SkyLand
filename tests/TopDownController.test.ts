import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D } from 'three';
import {
  SLIME_SURFACE_DRAG_COMPONENT,
  type SlimeSurfaceDragComponent,
} from '../src/actors/components/SlimeSurfaceDragComponent';
import { TopDownController } from '../src/controllers/TopDownController';
import {
  createPlayerInputScheme,
  InputSubsystem,
} from '../src/input/index';
import { BufferedInputDevice } from '../src/input/devices/BufferedInputDevice';
import { PlayerEntity } from '../src/player/PlayerEntity';
import type { ActorArchetypeDefinition } from '../src/scenes/data/SceneDefinition';
import { normalizeAngle } from '../shared/playerMovement.mjs';
import { AbilitySystem } from '../src/abilities/index';
import { PlayerJumpComponent } from '../shared/actor/index.mjs';
import {
  MOVE_SPEED_ATTRIBUTE,
  WaterMovementEffectController,
  createPlayerMovementAttributes,
} from '../shared/abilities/playerMovementEffects.mjs';
import { SIMULATION_STEP_SECONDS } from '../shared/networkTuning.mjs';
import { getRapier, PhysicsWorld } from '../shared/physics/index.mjs';

class TestKeyboardMouseDevice extends BufferedInputDevice {
  public constructor(private readonly now: () => number) {
    super('keyboardMouse');
  }

  public emit(control: string, value: boolean): void {
    this.setDigital(control, value, this.now());
  }
}

function createCanvas(): {
  canvas: HTMLCanvasElement;
  dispatchPointer(type: string, clientX: number, clientY: number): void;
} {
  const listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  const canvas = {
    addEventListener(type: string, listener: (event: PointerEvent) => void): void {
      const matching = listeners.get(type) ?? new Set();
      matching.add(listener);
      listeners.set(type, matching);
    },
    removeEventListener(type: string, listener: (event: PointerEvent) => void): void {
      listeners.get(type)?.delete(listener);
    },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 1000,
    }),
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    dispatchPointer(type, clientX, clientY): void {
      for (const listener of listeners.get(type) ?? []) {
        listener({ type, clientX, clientY, pointerId: 1 } as PointerEvent);
      }
    },
  };
}

function assertAngleClose(actual: number, expected: number, message: string): void {
  const difference = Math.abs(normalizeAngle(actual - expected));
  assert.ok(difference < 1e-9, `${message}：相差 ${difference}`);
}

test('TopDown 移动决定朝向，按住鼠标主操作时只让鼠标决定朝向', () => {
  let now = 0;
  const device = new TestKeyboardMouseDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });
  const { canvas, dispatchPointer } = createCanvas();
  const controller = new TopDownController(canvas, new Object3D(), input);

  device.emit('Keyboard.KeyW', true);
  now = 16;
  input.update();
  controller.update(0.1);
  let frame = controller.inputFrame;
  assertAngleClose(
    frame.yaw,
    Math.atan2(frame.move.x, frame.move.z),
    '未点击鼠标时应面向移动方向',
  );
  const movementYaw = frame.yaw;

  const beforeMouseMove = controller.position;
  dispatchPointer('pointerdown', 1000, 500);
  device.emit('Mouse.Button0', true);
  now = 32;
  input.update();
  controller.update(0.1);
  frame = controller.inputFrame;
  assert.notEqual(frame.yaw, movementYaw, '按住鼠标后朝向应切到光标方向');
  assert.notDeepEqual(controller.position, beforeMouseMove, '鼠标控制朝向时移动仍应生效');
  const mouseYaw = frame.yaw;

  device.emit('Keyboard.KeyW', false);
  device.emit('Keyboard.KeyD', true);
  now = 48;
  input.update();
  const beforeStrafe = controller.position;
  controller.update(0.1);
  frame = controller.inputFrame;
  assertAngleClose(frame.yaw, mouseYaw, '按住鼠标移动时不应改写鼠标朝向');
  assert.notDeepEqual(controller.position, beforeStrafe, '按住鼠标时移动只控制位置');

  device.emit('Mouse.Button0', false);
  now = 64;
  input.update();
  controller.update(0.1);
  frame = controller.inputFrame;
  assertAngleClose(
    frame.yaw,
    Math.atan2(frame.move.x, frame.move.z),
    '松开鼠标后应恢复面向移动方向',
  );

  controller.dispose();
  input.dispose();
});

test('TopDown 只把碰撞解算阻挡的位移作为一次性视觉冲击输出', () => {
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [],
  });
  const { canvas } = createCanvas();
  const controller = new TopDownController(canvas, new Object3D(), input, {
    resolveCollision: (position) => ({
      x: Math.min(0.25, position.x),
      z: position.z,
    }),
  });

  controller.setPosition(1, 0);
  assert.deepEqual(controller.position, { x: 0.25, z: 0 });
  assert.deepEqual(controller.consumeCollisionDisplacement(), { x: 0.75, z: 0 });
  assert.equal(controller.consumeCollisionDisplacement(), undefined, '碰撞位移读取后必须清零');

  controller.setPosition(0.1, 0.2);
  assert.equal(controller.consumeCollisionDisplacement(), undefined, '未受阻的移动不能唤醒流体结构');

  controller.dispose();
  input.dispose();
});

test('TopDown 本地预测读取 GAS Movement.Speed，涉水 Effect 使位移降低 50%', () => {
  let now = 0;
  const device = new TestKeyboardMouseDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });
  const gas = new AbilitySystem({
    ownerId: 'local-water-player',
    attributes: createPlayerMovementAttributes(3.2),
  });
  const waterEffect = new WaterMovementEffectController(gas);
  let inWater = false;
  const { canvas } = createCanvas();
  const controller = new TopDownController(canvas, new Object3D(), input, {
    movement: { walkSpeed: 3.2, sprintMultiplier: 1.65 },
    updateMovementState: () => waterEffect.sync(inWater),
    resolveWalkSpeed: () => waterEffect.moveSpeed,
  });

  device.emit('Keyboard.KeyW', true);
  now = 16;
  input.update();
  controller.update(0.1);
  const groundPosition = controller.position;
  assert.ok(Math.abs(Math.hypot(groundPosition.x, groundPosition.z) - 0.32) < 1e-9);

  inWater = true;
  controller.update(0.1);
  const waterPosition = controller.position;
  assert.ok(Math.abs(Math.hypot(
    waterPosition.x - groundPosition.x,
    waterPosition.z - groundPosition.z,
  ) - 0.16) < 1e-9);
  assert.equal(gas.attributes.getCurrentValue(MOVE_SPEED_ATTRIBUTE), 1.6);

  inWater = false;
  controller.update(0.1);
  const leftWaterPosition = controller.position;
  assert.ok(Math.abs(Math.hypot(
    leftWaterPosition.x - waterPosition.x,
    leftWaterPosition.z - waterPosition.z,
  ) - 0.32) < 1e-9);
  assert.equal(gas.attributes.getCurrentValue(MOVE_SPEED_ATTRIBUTE), 3.2);

  waterEffect.dispose();
  controller.dispose();
  input.dispose();
});

test('Space 进入固定物理步，短按边沿进入输入队列且空中方向输入继续移动', () => {
  let now = 0;
  const device = new TestKeyboardMouseDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });
  const root = new Object3D();
  const jump = new PlayerJumpComponent({
    impulse: 7,
    gravity: 22,
    maximumFallSpeed: 20,
    airControl: 0.85,
  });
  const { canvas } = createCanvas();
  const physics = new PhysicsWorld(getRapier(), { timestep: 1 / 60 });
  physics.setActorCollider('ground', {
    shape: 'box', x: 0, y: 0, z: 0, yaw: 0,
    halfWidth: 20, halfLength: 20, minimumY: -1, maximumY: 0,
  });
  physics.prepareQueries();
  const controller = new TopDownController(canvas, root, input, {
    movement: { walkSpeed: 3.2, sprintMultiplier: 1.65 },
    jumpAbility: jump,
    physicsWorld: physics,
    characterId: 'jump-test-player',
    collisionRadius: 0.42,
    collisionHeight: 0.84,
    sampleGroundHeight: () => 0,
  });

  device.emit('Keyboard.Space', true);
  device.emit('Keyboard.KeyW', true);
  now = 16;
  input.update(now);
  controller.update(0.05);
  assert.equal(controller.isGrounded, false);
  assert.ok(controller.verticalPosition > 0, `expected airborne y, got ${controller.verticalPosition}`);
  assert.ok(
    Math.hypot(controller.position.x, controller.position.z) > 0,
    `expected horizontal input, got ${JSON.stringify(controller.position)}`,
  );
  assert.equal(controller.inputFrame.jump, true);
  assert.ok(
    controller.drainInputSteps().some((step) => step.jump === true),
    'fixed input queue lost the jump edge',
  );

  device.emit('Keyboard.Space', false);
  now = 32;
  input.update(now);
  assert.equal(controller.inputFrame.jump, false, '按下沿已经进入固定步队列后即可释放锁存');

  device.emit('Keyboard.KeyW', false);
  for (let frame = 0; frame < 30 && !controller.isGrounded; frame += 1) {
    now += 50;
    input.update(now);
    controller.update(0.05);
  }
  assert.equal(controller.isGrounded, true);
  assert.ok(
    Math.abs(controller.verticalPosition) < 0.03,
    `expected ground feet height, got ${controller.verticalPosition}`,
  );

  controller.dispose();
  physics.dispose();
  input.dispose();
});

test('地形碰撞抬高到角色内部时，本地预测角色会立即上移到新支撑面', () => {
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [],
  });
  const root = new Object3D();
  const jump = new PlayerJumpComponent({
    impulse: 7,
    gravity: 22,
    maximumFallSpeed: 20,
    airControl: 0.85,
  });
  const physics = new PhysicsWorld(getRapier(), { timestep: SIMULATION_STEP_SECONDS });
  const { canvas } = createCanvas();
  const controller = new TopDownController(canvas, root, input, {
    jumpAbility: jump,
    physicsWorld: physics,
    characterId: 'terrain-edit-player',
    collisionRadius: 0.42,
    collisionHeight: 0.84,
  });

  assert.equal(controller.ensureTerrainSupport(1), true);
  assert.equal(controller.verticalPosition, 1);
  assert.equal(root.position.y, 1);
  assert.equal(controller.verticalVelocity, 0);
  assert.equal(controller.isGrounded, true);
  assert.ok(
    Math.abs(physics.getCharacterTranslation('terrain-edit-player').y - 1) < 1e-6,
  );
  assert.equal(controller.ensureTerrainSupport(0.5), false, '下挖不能把角色瞬移向下');
  assert.equal(controller.verticalPosition, 1);

  controller.dispose();
  physics.dispose();
  input.dispose();
});

test('本地玩家和解只纠正逻辑误差，并保留固定步相位与可见连续性', () => {
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [],
  });
  const root = new Object3D();
  const jump = new PlayerJumpComponent({
    impulse: 7,
    gravity: 22,
    maximumFallSpeed: 20,
    airControl: 0.85,
  });
  const physics = new PhysicsWorld(getRapier(), { timestep: SIMULATION_STEP_SECONDS });
  physics.setActorCollider('ground', {
    shape: 'box', x: 0, y: 0, z: 0, yaw: 0,
    halfWidth: 20, halfLength: 20, minimumY: -1, maximumY: 0,
  });
  physics.prepareQueries();
  const { canvas } = createCanvas();
  const controller = new TopDownController(canvas, root, input, {
    enabled: false,
    movement: { walkSpeed: 3.2, sprintMultiplier: 1.65 },
    jumpAbility: jump,
    physicsWorld: physics,
    characterId: 'reconcile-test-player',
    collisionRadius: 0.42,
    collisionHeight: 0.84,
  });

  const halfStep = SIMULATION_STEP_SECONDS * 0.5;
  controller.update(halfStep);
  assert.equal(controller.drainInputSteps().length, 0);

  // 模拟当前画面因固定步插值落后逻辑状态；它不能被算成网络纠正距离。
  root.position.z -= 0.08;
  const predicted = {
    x: controller.position.x,
    y: controller.verticalPosition,
    z: controller.position.z,
    vx: controller.horizontalVelocity.x,
    vy: controller.verticalVelocity,
    vz: controller.horizontalVelocity.z,
    grounded: controller.isGrounded,
  };
  const interpolatedZ = root.position.z;
  const tolerated = controller.rewindAndReplay({ ...predicted, x: predicted.x + 0.005 }, []);

  assert.ok(Math.abs(tolerated.residualDistance - 0.005) < 1e-6);
  assert.equal(tolerated.corrected, false);
  assert.equal(tolerated.snapped, false);
  assert.equal(controller.position.x, predicted.x, '6cm 容差内不能用毫米量化快照改写预测位置');
  assert.equal(root.position.z, interpolatedZ, '可见插值位置不能参与逻辑误差计算');

  controller.update(halfStep);
  assert.equal(
    controller.drainInputSteps().length,
    1,
    '普通和解必须保留此前累计的半个固定步',
  );

  const beforeCorrection = root.position.clone();
  const current = {
    x: controller.position.x,
    y: controller.verticalPosition,
    z: controller.position.z,
    vx: controller.horizontalVelocity.x,
    vy: controller.verticalVelocity,
    vz: controller.horizontalVelocity.z,
    grounded: controller.isGrounded,
  };
  const correctedX = current.x + 0.1;
  const corrected = controller.rewindAndReplay({ ...current, x: correctedX }, []);
  assert.ok(Math.abs(corrected.residualDistance - 0.1) < 1e-6);
  assert.equal(corrected.corrected, true);
  assert.equal(controller.position.x, correctedX);
  assert.ok(root.position.distanceTo(beforeCorrection) < 1e-9, '普通纠正当帧不能让模型跳变');

  controller.update(halfStep);
  assert.ok(root.position.x > beforeCorrection.x, '可见位置应开始向纠正后的逻辑位置收敛');
  assert.ok(root.position.x < correctedX, '普通纠正必须平滑收敛而不是瞬移');

  controller.dispose();
  physics.dispose();
  input.dispose();
});

test('旧房间缺少拖拽配置时 PBF 玩家仍自动装配 Component，并只通过 Primary 语义输入启停', () => {
  let now = 0;
  const device = new TestKeyboardMouseDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });
  const { canvas, dispatchPointer } = createCanvas();
  const archetype: ActorArchetypeDefinition = {
    schemaVersion: 1,
    id: 'pbf-slime',
    components: {
      playerMovement: {
        walkSpeed: 3.2,
        sprintMultiplier: 1.65,
        maximumStepHeight: 0.2,
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
  const player = new PlayerEntity(
    'surface-drag-player',
    canvas,
    { x: 0, z: 0 },
    input,
    { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    { applyImpulse: () => undefined },
    archetype,
  );
  const drag = player.requireComponent(
    SLIME_SURFACE_DRAG_COMPONENT,
  ) as SlimeSurfaceDragComponent;
  assert.equal(drag.isDragging, false);

  // 相机中心正对玩家；物理按键只由测试设备送入 InputSubsystem。
  dispatchPointer('pointerdown', 500, 500);
  // 模拟按下与下一渲染帧之间快速移出史莱姆：首次拾取仍必须使用按下坐标。
  dispatchPointer('pointermove', 900, 500);
  device.emit('Mouse.Button0', true);
  now = 16;
  input.update(now);
  player.update(1 / 60, 1 / 60);
  assert.equal(drag.isDragging, true);

  dispatchPointer('pointermove', 650, 500);
  now = 32;
  input.update(now);
  player.update(1 / 60, 2 / 60);
  assert.equal(drag.simulation.stats().surfaceDragActive, true);

  device.emit('Mouse.Button0', false);
  now = 48;
  input.update(now);
  assert.equal(drag.isDragging, false);
  assert.equal(drag.simulation.stats().surfaceDragActive, false);

  player.dispose();
  input.dispose();
});

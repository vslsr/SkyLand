import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Object3D } from 'three';
import { TopDownCameraOrbit } from '../src/camera/TopDownCameraOrbit';
import { SlimeSurfaceDragController } from '../src/controllers/SlimeSurfaceDragController';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
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
import { RECONCILE_CONVERGENCE, SIMULATION_STEP_SECONDS } from '../shared/networkTuning.mjs';
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
  dispatchPointer(
    type: string,
    clientX: number,
    clientY: number,
    options?: { pointerId?: number; button?: number },
  ): void;
} {
  const listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  const capturedPointers = new Set<number>();
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
    setPointerCapture(pointerId: number): void {
      capturedPointers.add(pointerId);
    },
    hasPointerCapture(pointerId: number): boolean {
      return capturedPointers.has(pointerId);
    },
    releasePointerCapture(pointerId: number): void {
      capturedPointers.delete(pointerId);
    },
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    dispatchPointer(type, clientX, clientY, options = {}): void {
      for (const listener of listeners.get(type) ?? []) {
        listener({
          type,
          clientX,
          clientY,
          pointerId: options.pointerId ?? 1,
          button: options.button ?? 0,
          cancelable: true,
          preventDefault: () => undefined,
        } as unknown as PointerEvent);
      }
    },
  };
}

function assertAngleClose(actual: number, expected: number, message: string): void {
  const difference = Math.abs(normalizeAngle(actual - expected));
  assert.ok(difference < 1e-9, `${message}：相差 ${difference}`);
}

test('TopDown 镜头默认只控制 Yaw 轴：垂直拖动不改俯角', () => {
  const initial: [number, number, number] = [0, 7.5, 10];
  const orbit = new TopDownCameraOrbit(initial);

  orbit.addPointerDelta(0, 400);
  orbit.update(1 / 60);
  assert.deepEqual([...orbit.currentOffset], initial, '默认配置下垂直拖动不该抬高镜头');

  orbit.addPointerDelta(200, 0);
  orbit.update(1 / 60);
  const turned = orbit.currentOffset;
  assert.notEqual(turned[0], initial[0], 'Yaw 轴仍然可以拖动');
  assert.ok(Math.abs(turned[1] - initial[1]) < 1e-9, '转圈不该改变镜头高度');
});

test('打开 pitch 轴后垂直拖动保持距离并把俯仰限制在可移动范围', () => {
  const initial: [number, number, number] = [0, 7.5, 10];
  const distance = Math.hypot(...initial);
  const orbit = new TopDownCameraOrbit(initial, { axes: { pitch: true } });

  orbit.addPointerDelta(0, 100_000);
  orbit.update(1 / 60);
  const raised = orbit.currentOffset;
  assert.ok(Math.hypot(raised[0], raised[2]) > 1, '俯角上限不能让水平移动轴退化');
  assert.ok(Math.abs(Math.hypot(...raised) - distance) < 1e-9);

  orbit.addPointerDelta(0, -100_000);
  orbit.update(1 / 60);
  const lowered = orbit.currentOffset;
  assert.ok(lowered[1] > 0, '俯角下限不能让 TopDown 镜头翻到地面下方');
  assert.ok(Math.abs(Math.hypot(...lowered) - distance) < 1e-9);
});

test('TopDown 朝向只由移动的 Yaw 轴驱动，鼠标按键不再改写它', () => {
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
  const player = new Object3D();
  const controller = new TopDownController(canvas, player, input);

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
  assertAngleClose(frame.yaw, movementYaw, '按住鼠标不应把朝向拉向光标');
  assert.notDeepEqual(controller.position, beforeMouseMove, '按住鼠标时移动仍应生效');

  device.emit('Keyboard.KeyW', false);
  device.emit('Keyboard.KeyD', true);
  now = 48;
  input.update();
  controller.update(0.1);
  frame = controller.inputFrame;
  assert.notEqual(frame.yaw, movementYaw, '改变移动方向后朝向应跟着转');
  assert.ok(
    Math.abs(normalizeAngle(frame.yaw - Math.atan2(frame.move.x, frame.move.z)))
      < Math.abs(normalizeAngle(movementYaw - Math.atan2(frame.move.x, frame.move.z))),
    '朝向应向新的移动方向收敛',
  );

  device.emit('Mouse.Button0', false);
  now = 64;
  input.update();
  controller.update(0.1);
  frame = controller.inputFrame;
  assertAngleClose(frame.yaw, player.rotation.y, '松开鼠标后朝向仍只跟着移动方向');

  controller.dispose();
  input.dispose();
});

test('TopDown 保留对准接口：外部朝向请求接管 Yaw，撤销后交回移动方向', () => {
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
  const { canvas } = createCanvas();
  const controller = new TopDownController(canvas, new Object3D(), input);

  device.emit('Keyboard.KeyW', true);
  now = 16;
  input.update();
  controller.update(0.1);
  const movementYaw = controller.inputFrame.yaw;

  controller.setFacingRequest({ target: { x: 10, z: 0 }, immediate: true });
  controller.update(0.1);
  let frame = controller.inputFrame;
  const aimed = controller.position;
  assertAngleClose(
    frame.yaw,
    Math.atan2(10 - aimed.x, 0 - aimed.z),
    '应按角色当前位置正对世界坐标里的对准点',
  );
  assert.notEqual(frame.yaw, movementYaw, '对准请求应接管移动朝向');

  controller.setFacingRequest({ yaw: -Math.PI / 2, immediate: true });
  controller.update(0.1);
  assertAngleClose(controller.inputFrame.yaw, -Math.PI / 2, '也可以直接给定朝向角');
  assertAngleClose(controller.facing.yaw, -Math.PI / 2, 'facing 应报告当前朝向');
  assert.equal(controller.facingRequestState?.yaw, -Math.PI / 2, '生效中的请求应可读回');

  controller.setFacingRequest(undefined);
  assert.equal(controller.facingRequestState, undefined, '撤销后不应再有生效的请求');
  for (let step = 0; step < 120; step += 1) controller.update(1 / 60);
  frame = controller.inputFrame;
  const movementDifference = Math.abs(
    normalizeAngle(frame.yaw - Math.atan2(frame.move.x, frame.move.z)),
  );
  assert.ok(
    movementDifference < 1e-3,
    `撤销对准请求后应重新收敛到移动方向：相差 ${movementDifference}`,
  );

  controller.dispose();
  input.dispose();
});

test('TopDown 控制器默认只让拖拽转动镜头 Yaw 轴，配置可以放开俯仰', () => {
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
  const controller = new TopDownController(canvas, new Object3D(), input, {
    cameraOffset: [0, 7.5, 10],
  });
  const initialHeight = controller.frame.position[1];

  dispatchPointer('pointerdown', 500, 500);
  dispatchPointer('pointermove', 500, 800);
  dispatchPointer('pointerup', 500, 800);
  controller.update(1 / 60);
  assert.ok(
    Math.abs(controller.frame.position[1] - initialHeight) < 1e-9,
    '默认只控制 Yaw 轴：垂直拖动不该抬高镜头',
  );

  const horizontalBefore = controller.frame.position[0];
  dispatchPointer('pointerdown', 500, 500, { pointerId: 2 });
  dispatchPointer('pointermove', 800, 500, { pointerId: 2 });
  dispatchPointer('pointerup', 800, 500, { pointerId: 2 });
  controller.update(1 / 60);
  assert.notEqual(controller.frame.position[0], horizontalBefore, 'Yaw 轴仍然可以拖动');
  controller.dispose();

  const pitchable = new TopDownController(canvas, new Object3D(), input, {
    cameraOffset: [0, 7.5, 10],
    cameraOrbitAxes: { pitch: true },
  });
  dispatchPointer('pointerdown', 500, 500, { pointerId: 3 });
  dispatchPointer('pointermove', 500, 800, { pointerId: 3 });
  dispatchPointer('pointerup', 500, 800, { pointerId: 3 });
  pitchable.update(1 / 60);
  assert.notEqual(
    pitchable.frame.position[1],
    initialHeight,
    '显式打开 pitch 之后垂直拖动应重新生效',
  );

  pitchable.dispose();
  input.dispose();
});

test('TopDown 拖动屏幕旋转镜头，移动立即改用新的相机前方', () => {
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
  const controller = new TopDownController(canvas, new Object3D(), input, {
    cameraOffset: [0, 7.5, 10],
  });
  const initialFrame = controller.frame;
  const initialDistance = Math.hypot(
    initialFrame.position[0],
    initialFrame.position[1] - 0.25,
    initialFrame.position[2],
  );

  dispatchPointer('pointerdown', 500, 500);
  device.emit('Mouse.Button0', true);
  now = 16;
  input.update(now);
  dispatchPointer('pointermove', 700, 500);
  for (let frame = 0; frame < 30; frame += 1) controller.update(1 / 60);
  dispatchPointer('pointerup', 700, 500);
  device.emit('Mouse.Button0', false);
  now = 32;
  input.update(now);

  const rotatedFrame = controller.frame;
  const rotatedDistance = Math.hypot(
    rotatedFrame.position[0],
    rotatedFrame.position[1] - 0.25,
    rotatedFrame.position[2],
  );
  assert.ok(Math.abs(rotatedFrame.position[0]) > 5, '水平拖动应该绕玩家旋转机位');
  assert.ok(
    Math.abs(rotatedDistance - initialDistance) < 1e-9,
    '轨道旋转不能改写 Scene 配置的镜头距离',
  );

  device.emit('Keyboard.KeyW', true);
  now = 48;
  input.update(now);
  const beforeMove = controller.position;
  controller.update(0.1);
  const afterMove = controller.position;
  const displacementX = afterMove.x - beforeMove.x;
  const displacementZ = afterMove.z - beforeMove.z;
  const displacementLength = Math.hypot(displacementX, displacementZ);
  const move = controller.inputFrame.move;
  assert.ok(Math.abs(move.x) > 0.5, '旋转后 W 不应继续沿原来的世界 Z 轴移动');
  assert.ok(
    Math.abs(displacementX / displacementLength - move.x) < 1e-9
      && Math.abs(displacementZ / displacementLength - move.z) < 1e-9,
    '实际位移必须与新的相机前方一致',
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
  // 容差内不整个采用重放结果（毫米量化的快照会让 Rapier 每拍换个起点），
  // 但必须朝它收敛固定比例——原来原样保留预测，误差永远不消，会一直攒到
  // 6cm 门槛再一次性拉回，走起来就是一秒一顿。
  assert.ok(
    Math.abs(controller.position.x - (predicted.x + 0.005 * RECONCILE_CONVERGENCE)) < 1e-9,
    '容差内应朝权威收敛 RECONCILE_CONVERGENCE 的比例',
  );
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

test('重放逐步重判水域：涉水参数不能冻在和解那一刻', () => {
  const root = new Object3D();
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [],
  });
  const physics = new PhysicsWorld(getRapier(), { timestep: SIMULATION_STEP_SECONDS });
  physics.setActorCollider('ground', {
    shape: 'box', x: 0, y: 0, z: 0, yaw: 0,
    halfWidth: 40, halfLength: 40, minimumY: -1, maximumY: 0,
  });
  physics.prepareQueries();
  const { canvas } = createCanvas();

  // 记下每一步问到的位置：服务端就是这样逐步重判的，客户端必须同构。
  const walkSpeedQueries: number[] = [];
  const buoyancyTicks: number[] = [];
  let movementStateSyncs = 0;
  const controller = new TopDownController(canvas, root, input, {
    enabled: false,
    movement: { walkSpeed: 3.2, sprintMultiplier: 1.65 },
    jumpAbility: new PlayerJumpComponent({
      impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85,
    }),
    physicsWorld: physics,
    characterId: 'water-replay-player',
    collisionRadius: 0.42,
    collisionHeight: 0.84,
    updateMovementState: () => { movementStateSyncs += 1; },
    resolveWalkSpeed: () => {
      walkSpeedQueries.push(controller.position.x);
      // 过了 x=0 就算入水，速度减半——服务端 Effect.Movement.WaterSlow 的形状。
      return controller.position.x > 0 ? 1.6 : 3.2;
    },
    resolveBuoyancyHeight: (tick) => {
      buoyancyTicks.push(tick);
      return undefined;
    },
  });

  controller.update(SIMULATION_STEP_SECONDS);
  controller.drainInputSteps();
  walkSpeedQueries.length = 0;
  buoyancyTicks.length = 0;
  movementStateSyncs = 0;

  const anchorState = {
    x: controller.position.x,
    y: controller.verticalPosition,
    z: controller.position.z,
    vx: 0,
    vy: controller.verticalVelocity,
    vz: 0,
    grounded: controller.isGrounded,
  };
  const pending = [200, 201, 202, 203].map((tick) => ({
    tick,
    move: { x: 1, z: 0 },
    sprint: false,
    jump: false,
    yaw: 0,
  }));
  controller.rewindAndReplay(anchorState, pending);

  assert.equal(
    walkSpeedQueries.length,
    pending.length,
    '重放的每一步都必须重新解析行走速度，而不是沿用和解那一刻的值',
  );
  assert.equal(movementStateSyncs, pending.length, '每一步都要重判涉水状态');
  assert.deepEqual(buoyancyTicks, pending.map((step) => step.tick), '浮力要按每一步的 tick 求值');
  // 位置在重放过程中确实推进了，所以后一次问到的位置比前一次靠前——
  // 这正是「按这一步的位置判水域」的前提。
  for (let index = 1; index < walkSpeedQueries.length; index += 1) {
    assert.ok(
      walkSpeedQueries[index] > walkSpeedQueries[index - 1],
      '每一步解析速度时看到的应当是这一步的位置',
    );
  }

  controller.dispose();
  physics.dispose();
  input.dispose();
});

test('容差内的误差会逐拍衰减，不会攒到门槛再被一次性拉回', () => {
  const root = new Object3D();
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [],
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
    // 没有 jumpAbility 就不会建角色状态，和解会走「没有状态」那条瞬移分支。
    jumpAbility: new PlayerJumpComponent({
      impulse: 7, gravity: 22, maximumFallSpeed: 20, airControl: 0.85,
    }),
    physicsWorld: physics,
    characterId: 'converge-test-player',
    collisionRadius: 0.42,
    collisionHeight: 0.84,
  });

  // 先跑一帧把角色状态与物理代理建起来，否则和解走的是「没有状态」那条瞬移分支。
  controller.update(SIMULATION_STEP_SECONDS);
  controller.drainInputSteps();

  // 这是玩家实际报的那个毛病：站着不动，两端差着 4.9cm 却一直消不掉。
  // 每拍都把权威摆在同一个位置上，看客户端认不认。
  const authorityX = controller.position.x - 0.049;
  const errors: number[] = [];
  for (let snapshot = 0; snapshot < 12; snapshot += 1) {
    const result = controller.rewindAndReplay({
      x: authorityX,
      y: controller.verticalPosition,
      z: controller.position.z,
      vx: 0,
      vy: controller.verticalVelocity,
      vz: 0,
      grounded: controller.isGrounded,
    }, []);
    assert.equal(result.corrected, false, '4.9cm 在 6cm 容差内，不该走可见纠正');
    errors.push(Math.abs(controller.position.x - authorityX));
  }

  for (let index = 1; index < errors.length; index += 1) {
    assert.ok(
      errors[index] < errors[index - 1],
      `第 ${index} 拍误差没有变小：${errors[index - 1].toFixed(5)} → ${errors[index].toFixed(5)}`,
    );
  }
  // 收敛四分之一时，十二拍之后应当只剩零头；原来的实现这里会是恒定的 0.049。
  assert.ok(
    errors.at(-1)! < errors[0] * 0.1,
    `误差应当衰减到一成以下，实际 ${errors[0].toFixed(4)} → ${errors.at(-1)!.toFixed(4)}`,
  );

  controller.dispose();
  physics.dispose();
  input.dispose();
});

test('旧房间缺少拖拽配置时渲染侧仍自动装配蒙皮拖拽，并只通过 Primary 语义输入启停', () => {
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
  // 蒙皮拖拽整条链路都在渲染侧：玩家只贡献一个 ProxyId。
  const dragScene = new ThreeRenderScene(
    new Group(),
    { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
  );
  const renderWorld = {
    scene: dragScene,
    transforms: new RenderTransformBuffer(),
    // 槽位由玩法侧分配：渲染世界不回话（见 RenderScene.createPlayerProxy）。
    proxyIds: new RenderProxyTable(dragScene),
  };
  const player = new PlayerEntity(
    'surface-drag-player',
    canvas,
    { x: 0, z: 0 },
    input,
    { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
    { applyImpulse: () => undefined },
    archetype,
    renderWorld,
  );
  const proxyId = player.renderProxyId;
  const drag = new SlimeSurfaceDragController(
    canvas,
    input,
    renderWorld.scene,
    proxyId,
    () => player.controller.frame,
    (active) => player.controller.setCameraDragSuppressed(active),
  );
  const simulation = renderWorld.scene.resolveSlimeVisual(proxyId)!.simulation;
  assert.equal(renderWorld.scene.isSlimeSurfaceDragging(proxyId), false);
  player.controller.setInputEnabled(true);
  const cameraBeforeSurfaceDrag = [...player.controller.frame.position];

  // 相机中心正对玩家；物理按键只由测试设备送入 InputSubsystem。
  dispatchPointer('pointerdown', 500, 500);
  // 模拟按下与下一渲染帧之间快速移出史莱姆：首次拾取仍必须使用按下坐标。
  dispatchPointer('pointermove', 900, 500);
  device.emit('Mouse.Button0', true);
  now = 16;
  input.update(now);
  assert.equal(
    renderWorld.scene.isSlimeSurfaceDragging(proxyId),
    true,
    '表面拖拽应在 TopDown 更新前抢占这次手势',
  );
  player.controller.update(1 / 60);
  assert.deepEqual(
    player.controller.frame.position,
    cameraBeforeSurfaceDrag,
    '拖动史莱姆表面时不能同时旋转镜头',
  );
  drag.update();
  player.update(1 / 60);
  assert.equal(renderWorld.scene.isSlimeSurfaceDragging(proxyId), true);

  dispatchPointer('pointermove', 650, 500);
  now = 32;
  input.update(now);
  drag.update();
  player.update(1 / 60);
  assert.equal(simulation.stats().surfaceDragActive, true);

  device.emit('Mouse.Button0', false);
  now = 48;
  input.update(now);
  assert.equal(renderWorld.scene.isSlimeSurfaceDragging(proxyId), false);
  assert.equal(simulation.stats().surfaceDragActive, false);

  drag.dispose();
  player.dispose();
  renderWorld.scene.dispose();
  input.dispose();
});

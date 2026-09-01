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

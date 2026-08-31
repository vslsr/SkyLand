import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InputSubsystem,
  VirtualInputDevice,
  type InputActionDefinition,
  type InputActionEvent,
  type InputMappingContextDefinition,
} from '../src/input/index.ts';

interface TestClock {
  value: number;
  readonly now: () => number;
}

function createClock(): TestClock {
  const clock = {
    value: 0,
    now: () => clock.value,
  };
  return clock;
}

function createSingleActionInput(
  action: InputActionDefinition,
  control = 'Virtual.Test',
  mapping: Partial<InputMappingContextDefinition['mappings'][number]> = {},
) {
  const clock = createClock();
  const device = new VirtualInputDevice({ now: clock.now });
  const tag = `Input.Test.${action.id}`;
  const input = new InputSubsystem({
    actions: [action],
    config: { bindings: [{ tag, actionId: action.id }] },
    contexts: [{
      id: 'IMC.Test',
      priority: 1,
      activeByDefault: true,
      mappings: [{ control, actionId: action.id, ...mapping }],
    }],
    devices: [device],
    now: clock.now,
  });
  const events: InputActionEvent[] = [];
  input.bind(tag, (event) => events.push(event));
  return { clock, device, events, input, tag };
}

test('axis2D 会聚合数字方向、限制长度并通过标签派发阶段', () => {
  const clock = createClock();
  const device = new VirtualInputDevice({ now: clock.now });
  const input = new InputSubsystem({
    actions: [{ id: 'Move', valueType: 'axis2D', trigger: { type: 'pressed' } }],
    config: { bindings: [{ tag: 'Input.Player.Move', actionId: 'Move' }] },
    contexts: [{
      id: 'IMC.Gameplay',
      priority: 1,
      activeByDefault: true,
      mappings: [
        { control: 'Virtual.Right', actionId: 'Move', axis2D: { x: 1, y: 0 } },
        { control: 'Virtual.Up', actionId: 'Move', axis2D: { x: 0, y: 1 } },
      ],
    }],
    devices: [device],
    now: clock.now,
  });
  const phases: string[] = [];
  input.bind('Input.Player.Move', (event) => phases.push(event.phase));

  device.setDigital('Virtual.Right', true);
  device.setDigital('Virtual.Up', true);
  input.update();

  const move = input.getAxis2D('Input.Player.Move');
  assert.ok(Math.abs(move.x - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(move.y - Math.SQRT1_2) < 1e-9);
  assert.deepEqual(phases, ['started', 'triggered', 'ongoing']);

  clock.value = 16;
  device.setDigital('Virtual.Right', false);
  device.setDigital('Virtual.Up', false);
  input.update();
  assert.equal(phases.at(-1), 'completed');
  assert.deepEqual(input.getAxis2D('Input.Player.Move'), { x: 0, y: 0 });
});

test('Pressed 只在按下沿触发，保持期间派发 ongoing，释放后 completed', () => {
  const { clock, device, events, input } = createSingleActionInput({
    id: 'Pressed',
    valueType: 'digital',
    trigger: { type: 'pressed' },
  });

  device.setDigital('Virtual.Test', true);
  input.update();
  clock.value = 20;
  input.update();
  clock.value = 40;
  device.setDigital('Virtual.Test', false);
  input.update();

  assert.deepEqual(events.map((event) => event.phase), [
    'started',
    'triggered',
    'ongoing',
    'ongoing',
    'completed',
  ]);
});

test('Hold 到达阈值后触发，提前释放则取消', () => {
  const held = createSingleActionInput({
    id: 'Hold',
    valueType: 'digital',
    trigger: { type: 'hold', thresholdMs: 300 },
  });
  held.device.setDigital('Virtual.Test', true);
  held.input.update();
  held.clock.value = 299;
  held.input.update();
  assert.equal(held.events.some((event) => event.phase === 'triggered'), false);

  held.clock.value = 300;
  held.input.update();
  assert.equal(held.events.filter((event) => event.phase === 'triggered').length, 1);
  held.clock.value = 360;
  held.device.setDigital('Virtual.Test', false);
  held.input.update();
  assert.equal(held.events.at(-1)?.phase, 'completed');

  const early = createSingleActionInput({
    id: 'EarlyHold',
    valueType: 'digital',
    trigger: { type: 'hold', thresholdMs: 300 },
  });
  early.device.setDigital('Virtual.Test', true);
  early.input.update();
  early.clock.value = 100;
  early.device.setDigital('Virtual.Test', false);
  early.input.update();
  assert.equal(early.events.at(-1)?.phase, 'canceled');
});

test('DoubleTap 在规定间隔内第二次按下时触发', () => {
  const { clock, device, events, input } = createSingleActionInput({
    id: 'DoubleTap',
    valueType: 'digital',
    trigger: { type: 'doubleTap', maximumGapMs: 250, maximumTapMs: 180 },
  });

  device.setDigital('Virtual.Test', true);
  input.update();
  clock.value = 60;
  device.setDigital('Virtual.Test', false);
  input.update();
  clock.value = 180;
  device.setDigital('Virtual.Test', true);
  input.update();
  clock.value = 220;
  device.setDigital('Virtual.Test', false);
  input.update();

  assert.equal(events.filter((event) => event.phase === 'started').length, 1);
  assert.equal(events.filter((event) => event.phase === 'triggered').length, 1);
  assert.equal(events.at(-1)?.phase, 'completed');
});

test('DoubleTap 等待第二次输入超时后统一取消', () => {
  const { clock, device, events, input } = createSingleActionInput({
    id: 'DoubleTapTimeout',
    valueType: 'digital',
    trigger: { type: 'doubleTap', maximumGapMs: 200, maximumTapMs: 150 },
  });

  device.setDigital('Virtual.Test', true);
  input.update();
  clock.value = 40;
  device.setDigital('Virtual.Test', false);
  input.update();
  clock.value = 241;
  input.update();

  assert.equal(events.some((event) => event.phase === 'triggered'), false);
  assert.equal(events.at(-1)?.phase, 'canceled');
});

test('高优先级 Context 默认消费相同控制，停用后低优先级接管', () => {
  const clock = createClock();
  const device = new VirtualInputDevice({ now: clock.now });
  const input = new InputSubsystem({
    actions: [
      { id: 'Low', valueType: 'digital' },
      { id: 'High', valueType: 'digital' },
    ],
    config: { bindings: [
      { tag: 'Input.Low', actionId: 'Low' },
      { tag: 'Input.High', actionId: 'High' },
    ] },
    contexts: [
      {
        id: 'IMC.Low',
        priority: 10,
        activeByDefault: true,
        mappings: [{ control: 'Virtual.Shared', actionId: 'Low' }],
      },
      {
        id: 'IMC.High',
        priority: 100,
        activeByDefault: true,
        mappings: [{ control: 'Virtual.Shared', actionId: 'High' }],
      },
    ],
    devices: [device],
    now: clock.now,
  });

  device.setDigital('Virtual.Shared', true);
  input.update();
  assert.equal(input.getDigital('Input.High'), true);
  assert.equal(input.getDigital('Input.Low'), false);

  clock.value = 20;
  input.setContextActive('IMC.High', false);
  input.update();
  assert.equal(input.getDigital('Input.High'), false);
  assert.equal(input.getDigital('Input.Low'), true);
});

test('设备失焦取消会清零状态并派发 canceled', () => {
  const { clock, device, events, input, tag } = createSingleActionInput({
    id: 'Cancelable',
    valueType: 'digital',
  });
  const parentEvents: InputActionEvent[] = [];
  input.bind('Input.Test', (event) => parentEvents.push(event), { includeDescendants: true });

  device.setDigital('Virtual.Test', true);
  input.update();
  clock.value = 30;
  device.cancel();

  assert.equal(input.getDigital(tag), false);
  assert.equal(events.at(-1)?.phase, 'canceled');
  assert.equal(parentEvents.at(-1)?.phase, 'canceled');
});

test('axis2D Modifier 按配置顺序执行', () => {
  const clock = createClock();
  const device = new VirtualInputDevice({ now: clock.now });
  const input = new InputSubsystem({
    actions: [{
      id: 'ModifiedMove',
      valueType: 'axis2D',
      modifiers: [{ type: 'normalize' }],
    }],
    config: { bindings: [{ tag: 'Input.ModifiedMove', actionId: 'ModifiedMove' }] },
    contexts: [{
      id: 'IMC.Modifier',
      priority: 1,
      activeByDefault: true,
      mappings: [{
        control: 'Virtual.RawAxis',
        actionId: 'ModifiedMove',
        modifiers: [
          { type: 'swizzle', order: 'yx' },
          { type: 'negate', axes: 'y' },
          { type: 'scale', x: 2, y: 1 },
        ],
      }],
    }],
    devices: [device],
    now: clock.now,
  });

  device.setAxis2D('Virtual.RawAxis', { x: 0.5, y: 0.25 });
  input.update();

  const value = input.getAxis2D('Input.ModifiedMove');
  assert.ok(Math.abs(value.x - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(value.y + Math.SQRT1_2) < 1e-9);
});

test('axis2D 使用最近活跃的设备来源而不是跨设备相加', () => {
  const clock = createClock();
  const keyboard = new VirtualInputDevice({ now: clock.now, kind: 'keyboardMouse' });
  const touch = new VirtualInputDevice({ now: clock.now, kind: 'touch' });
  const input = new InputSubsystem({
    actions: [{ id: 'MoveBySource', valueType: 'axis2D' }],
    config: { bindings: [{ tag: 'Input.MoveBySource', actionId: 'MoveBySource' }] },
    contexts: [{
      id: 'IMC.Sources',
      priority: 1,
      activeByDefault: true,
      mappings: [
        { control: 'Virtual.KeyboardMove', actionId: 'MoveBySource' },
        { control: 'Virtual.TouchMove', actionId: 'MoveBySource' },
      ],
    }],
    devices: [keyboard, touch],
    now: clock.now,
  });
  const activeDevices: string[] = [];
  input.onActiveDeviceChanged((deviceKind) => activeDevices.push(deviceKind));

  keyboard.setAxis2D('Virtual.KeyboardMove', { x: 1, y: 0 });
  input.update();
  assert.deepEqual(input.getAxis2D('Input.MoveBySource'), { x: 1, y: 0 });

  clock.value = 10;
  touch.setAxis2D('Virtual.TouchMove', { x: 0, y: 1 });
  input.update();
  assert.deepEqual(input.getAxis2D('Input.MoveBySource'), { x: 0, y: 1 });

  clock.value = 20;
  touch.setAxis2D('Virtual.TouchMove', { x: 0, y: 0 });
  input.update();
  assert.deepEqual(input.getAxis2D('Input.MoveBySource'), { x: 1, y: 0 });

  clock.value = 30;
  keyboard.setAxis2D('Virtual.KeyboardMove', { x: 0.8, y: 0 });
  input.update();
  assert.equal(input.activeDeviceKind, 'keyboardMouse');
  assert.deepEqual(activeDevices, ['keyboardMouse', 'touch', 'keyboardMouse']);
});

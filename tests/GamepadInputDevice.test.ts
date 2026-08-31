import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GamepadInputDevice,
  GameplayInputContext,
  InputSubsystem,
  PlayerInputActions,
  PlayerInputConfig,
  PlayerInputTags,
  type GamepadButtonSnapshot,
  type GamepadSnapshot,
} from '../src/input/index.ts';

function buttons(): GamepadButtonSnapshot[] {
  return Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
}

test('标准 Gamepad 轮询会输出摇杆、按钮和断开释放事件', () => {
  const axes = [0, 0, 0, 0];
  const gamepadButtons = buttons();
  let connected = true;
  const gamepad: GamepadSnapshot = {
    connected: true,
    index: 0,
    axes,
    buttons: gamepadButtons,
  };
  const device = new GamepadInputDevice({
    getGamepads: () => connected ? [gamepad] : [],
  });

  device.poll(0);
  device.drainEvents();
  axes[0] = 0.5;
  axes[1] = -0.25;
  gamepadButtons[0] = { pressed: true, value: 1 };
  device.poll(10);
  const activeEvents = device.drainEvents();

  assert.deepEqual(
    activeEvents.find((event) => event.control === 'Gamepad.LeftStick')?.value,
    { x: 0.5, y: -0.25 },
  );
  assert.equal(
    activeEvents.find((event) => event.control === 'Gamepad.ButtonSouth')?.value,
    true,
  );
  assert.ok(activeEvents.every((event) => event.deviceKind === 'gamepad'));

  connected = false;
  device.poll(20);
  const releaseEvents = device.drainEvents();
  assert.deepEqual(
    releaseEvents.find((event) => event.control === 'Gamepad.LeftStick')?.value,
    { x: 0, y: 0 },
  );
  assert.equal(
    releaseEvents.find((event) => event.control === 'Gamepad.ButtonSouth')?.value,
    false,
  );
});

test('默认 Gameplay 配置会修正手柄 Y 轴并切换活跃设备', () => {
  const axes = [0, 0, 0, 0];
  const gamepadButtons = buttons();
  let now = 0;
  const device = new GamepadInputDevice({
    getGamepads: () => [{
      connected: true,
      index: 0,
      axes,
      buttons: gamepadButtons,
    }],
  });
  const input = new InputSubsystem({
    actions: PlayerInputActions,
    config: PlayerInputConfig,
    contexts: [GameplayInputContext],
    devices: [device],
    now: () => now,
  });

  input.update();
  axes[0] = 0.6;
  axes[1] = -0.6;
  gamepadButtons[10] = { pressed: true, value: 1 };
  now = 16;
  input.update();

  const move = input.getAxis2D(PlayerInputTags.Move);
  assert.ok(move.x > 0 && move.y > 0, `实际方向为 ${move.x}, ${move.y}`);
  assert.equal(input.getDigital(PlayerInputTags.Sprint), true);
  assert.equal(input.activeDeviceKind, 'gamepad');
});

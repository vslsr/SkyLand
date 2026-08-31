import assert from 'node:assert/strict';
import test from 'node:test';
import { VesselControlController } from '../src/controllers/VesselControlController';
import {
  createPlayerInputScheme,
  InputSubsystem,
  PlayerInputTags,
} from '../src/input/index';
import { BufferedInputDevice } from '../src/input/devices/BufferedInputDevice';

class TestKeyboardDevice extends BufferedInputDevice {
  public constructor(private readonly now: () => number) {
    super('keyboardMouse');
  }

  public emit(control: string, value: boolean): void {
    this.setDigital(control, value, this.now());
  }
}

test('按下 F 切换木筏控制权，方向键按固定频率发送船舶意图', () => {
  let now = 0;
  let ownedActorId: string | undefined;
  const requested: string[] = [];
  const released: string[] = [];
  const sent: Array<{ actorId: string; throttle: number; steering: number }> = [];
  const device = new TestKeyboardDevice(() => now);
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });
  const controller = new VesselControlController(input, {
    getPlayerId: () => 'player-1',
    findOwnedActorId: () => ownedActorId,
    findControllableActorId: () => ownedActorId ? undefined : 'raft-1',
    requestControl: (actorId) => requested.push(actorId),
    releaseControl: (actorId) => released.push(actorId),
    sendInput: (actorId, value) => sent.push({ actorId, ...value }),
  });

  device.emit('Keyboard.KeyF', true);
  input.update();
  assert.deepEqual(requested, ['raft-1']);

  device.emit('Keyboard.KeyF', false);
  now = 410;
  input.update();
  ownedActorId = 'raft-1';
  device.emit('Keyboard.ArrowUp', true);
  device.emit('Keyboard.ArrowRight', true);
  now = 460;
  input.update();
  controller.update(0.05);
  assert.deepEqual(input.getAxis2D(PlayerInputTags.Move), { x: 0, y: 0 });
  assert.equal(sent[0].actorId, 'raft-1');
  assert.ok(Math.abs(sent[0].throttle - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(sent[0].steering - Math.SQRT1_2) < 1e-9);

  device.emit('Keyboard.KeyF', true);
  now = 500;
  input.update();
  assert.deepEqual(released, ['raft-1']);
  controller.dispose();
  input.dispose();
});

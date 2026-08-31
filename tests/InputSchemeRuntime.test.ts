import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayerInputScheme,
  InputSchemeRuntime,
  InputSubsystem,
  parseInputSchemeDefinition,
  PlayerInputSchemeDefinition,
  PlayerInputTags,
  VirtualInputDevice,
  type InputBindingStorage,
  type StoredInputBindingOverrides,
} from '../src/input/index.ts';

class MemoryBindingStorage implements InputBindingStorage {
  private readonly values = new Map<string, StoredInputBindingOverrides>();

  public load(schemeId: string): StoredInputBindingOverrides | undefined {
    return this.values.get(schemeId);
  }

  public save(value: StoredInputBindingOverrides): void {
    this.values.set(value.schemeId, value);
  }

  public clear(schemeId: string): void {
    this.values.delete(schemeId);
  }
}

test('Player InputAction、InputConfig、Context 与设备提示来自同一份 JSON 方案', () => {
  assert.equal(PlayerInputSchemeDefinition.schemaVersion, 1);
  assert.ok(PlayerInputSchemeDefinition.inputActions.some((action) => action.id === 'IA_Player_Move'));
  assert.equal(
    PlayerInputSchemeDefinition.inputConfig.bindings.find((binding) => binding.actionId === 'IA_Player_Move')?.tag,
    'Input.Player.Move',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputMappingContexts[0].mappings.find((mapping) => (
      mapping.id === 'Move.Keyboard.Up'
    ))?.control,
    'Keyboard.KeyW',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputConfig.bindings.find((binding) => binding.actionId === 'IA_Vessel_Move')?.tag,
    'Input.Vessel.Move',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputMappingContexts[0].mappings.find((mapping) => (
      mapping.id === 'Vessel.Keyboard.Forward'
    ))?.control,
    'Keyboard.ArrowUp',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputMappingContexts[0].mappings.find((mapping) => (
      mapping.id === 'WorldInteract.Keyboard.Primary'
    ))?.control,
    'Keyboard.KeyE',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputConfig.bindings.find((binding) => (
      binding.actionId === 'IA_AbilityLab_Arcane'
    ))?.tag,
    'Input.AbilityLab.Arcane',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputMappingContexts[0].mappings.find((mapping) => (
      mapping.id === 'AbilityLab.Keyboard.Arcane'
    ))?.control,
    'Keyboard.Digit1',
  );
  assert.equal(
    PlayerInputSchemeDefinition.inputMappingContexts
      .find((context) => context.id === 'IMC.Development')
      ?.mappings.find((mapping) => mapping.id === 'DebugMenu.Keyboard.F8')?.control,
    'Keyboard.F8',
  );
  assert.equal(String(PlayerInputTags.DebugMenu), 'Input.Debug.Menu');

  const runtime = createPlayerInputScheme({ storage: null });
  assert.match(runtime.getPrompt('topdown', 'keyboardMouse'), /W\/A\/S\/D · 移动/);
  assert.match(runtime.getPrompt('fly', 'gamepad', 'unlocked'), /F 接管木筏/);
});

test('F8 开发 Context 只在开发方案中启用', () => {
  const development = createPlayerInputScheme({
    storage: null,
    includeDevelopmentMappings: true,
  });
  assert.equal(development.getMapping('DebugMenu.Keyboard.F8').control, 'Keyboard.F8');
  assert.ok(development.getPreventDefaultControls().includes('Keyboard.F8'));

  const production = createPlayerInputScheme({
    storage: null,
    includeDevelopmentMappings: false,
  });
  assert.ok(!production.contexts.some((context) => context.id === 'IMC.Development'));
  assert.ok(!production.getPreventDefaultControls().includes('Keyboard.F8'));
});

test('运行时重绑定会更新 Context 和配置驱动的设备提示', () => {
  const runtime = createPlayerInputScheme({ storage: null });
  const events: string[][] = [];
  runtime.onBindingsChanged((event) => events.push([...event.mappingIds]));

  runtime.rebind('Move.Keyboard.Up', 'Keyboard.KeyI');

  assert.equal(runtime.getMapping('Move.Keyboard.Up').control, 'Keyboard.KeyI');
  assert.match(runtime.getPrompt('topdown', 'keyboardMouse'), /I\/A\/S\/D · 移动/);
  assert.deepEqual(events, [['Move.Keyboard.Up']]);
  assert.ok(runtime.getPreventDefaultControls().includes('Keyboard.KeyI'));
  assert.ok(!runtime.getPreventDefaultControls().includes('Keyboard.KeyW'));
  assert.throws(
    () => runtime.rebind('Move.Keyboard.Up', 'Gamepad.ButtonSouth'),
    /不能绑定 gamepad control/,
  );
});

test('默认冲突策略交换同一 Context 内的按键，reject 策略拒绝覆盖', () => {
  const runtime = createPlayerInputScheme({ storage: null });

  runtime.rebind('Move.Keyboard.Up', 'Keyboard.KeyS');
  assert.equal(runtime.getMapping('Move.Keyboard.Up').control, 'Keyboard.KeyS');
  assert.equal(runtime.getMapping('Move.Keyboard.Down').control, 'Keyboard.KeyW');

  assert.throws(
    () => runtime.rebind('Move.Keyboard.Left', 'Keyboard.KeyD', { conflict: 'reject' }),
    /已绑定到 Move.Keyboard.Right/,
  );
});

test('重绑定覆盖会持久化，并可单条或整体恢复默认值', () => {
  const storage = new MemoryBindingStorage();
  const first = new InputSchemeRuntime(PlayerInputSchemeDefinition, { storage });
  first.rebind('Interact.Keyboard.Primary', 'Keyboard.KeyE');

  const restored = new InputSchemeRuntime(PlayerInputSchemeDefinition, { storage });
  assert.equal(restored.getMapping('Interact.Keyboard.Primary').control, 'Keyboard.KeyE');

  restored.resetBinding('Interact.Keyboard.Primary');
  assert.equal(restored.getMapping('Interact.Keyboard.Primary').control, 'Keyboard.KeyF');
  restored.rebind('Move.Keyboard.Up', 'Keyboard.KeyI');
  restored.resetAllBindings();
  assert.equal(restored.getMapping('Move.Keyboard.Up').control, 'Keyboard.KeyW');
  assert.equal(storage.load(restored.id), undefined);
});

test('替换 InputSubsystem Context 后新绑定立即生效且旧绑定失效', () => {
  let now = 0;
  const device = new VirtualInputDevice({ now: () => now });
  const scheme = createPlayerInputScheme({ storage: null });
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
    now: () => now,
  });

  scheme.rebind('Move.Touch.Stick', 'Virtual.MoveStickAlternate');
  input.replaceMappingContexts(scheme.contexts);
  device.setAxis2D('Virtual.MoveStick', { x: 0, y: 1 });
  input.update();
  assert.deepEqual(input.getAxis2D(PlayerInputTags.Move), { x: 0, y: 0 });

  device.setAxis2D('Virtual.MoveStick', { x: 0, y: 0 });
  device.setAxis2D('Virtual.MoveStickAlternate', { x: 0, y: 1 });
  now = 16;
  input.update();
  assert.ok(input.getAxis2D(PlayerInputTags.Move).y > 0);
});

test('配置解析会拒绝不存在的设备提示 Mapping 引用', () => {
  const broken = JSON.parse(JSON.stringify(PlayerInputSchemeDefinition)) as {
    devicePrompts: { prompts: Array<{ entries?: Array<{ mappingIds?: string[] }> }> };
  };
  broken.devicePrompts.prompts[2].entries?.[0].mappingIds?.push('Missing.Mapping');
  assert.throws(() => parseInputSchemeDefinition(broken), /不存在的 Mapping/);
});

test('虚拟摇杆 V2 配置来自 JSON，并拒绝没有 touch Mapping 的控制路径', () => {
  assert.equal(PlayerInputSchemeDefinition.virtualControls.joystick.mode, 'floating');
  assert.equal(PlayerInputSchemeDefinition.virtualControls.layouts.portrait.scale, 0.9);
  assert.deepEqual(
    PlayerInputSchemeDefinition.virtualControls.buttons.map((button) => button.control),
    ['Virtual.SprintButton', 'Virtual.InteractButton', 'Virtual.DodgeButton'],
  );

  const broken = JSON.parse(JSON.stringify(PlayerInputSchemeDefinition)) as {
    virtualControls: { joystick: { control: string } };
  };
  broken.virtualControls.joystick.control = 'Virtual.MissingStick';
  assert.throws(() => parseInputSchemeDefinition(broken), /没有 touch Mapping/);
});

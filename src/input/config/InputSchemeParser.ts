import { defineTag } from '../../tags/index';
import type {
  Axis2DInputModifier,
  Axis2DValue,
  InputActionDefinition,
  InputDeviceKind,
  InputTriggerDefinition,
} from '../core/types';
import type {
  ConfigurableInputMappingContextDefinition,
  ConfigurableInputMappingDefinition,
  InputDevicePromptDefinition,
  InputPromptEntryDefinition,
  InputSchemeDefinition,
  VirtualButtonDefinition,
  VirtualControlLayoutDefinition,
  VirtualControlsDefinition,
} from './InputSchemeTypes';

const DEVICE_KINDS = new Set<InputDeviceKind>(['keyboardMouse', 'touch', 'gamepad']);

export function inferInputDeviceKind(control: string): InputDeviceKind | undefined {
  if (control.startsWith('Keyboard.') || control.startsWith('Mouse.')) return 'keyboardMouse';
  if (control.startsWith('Virtual.')) return 'touch';
  if (control.startsWith('Gamepad.')) return 'gamepad';
  return undefined;
}

export function parseInputSchemeDefinition(raw: unknown): InputSchemeDefinition {
  const root = record(raw, 'InputScheme');
  if (root.schemaVersion !== 1) throw new RangeError('InputScheme.schemaVersion 当前仅支持 1');
  const id = nonEmptyString(root.id, 'InputScheme.id');
  const inputActions = array(root.inputActions, 'inputActions').map(parseAction);
  const inputConfigRaw = record(root.inputConfig, 'inputConfig');
  const bindings = array(inputConfigRaw.bindings, 'inputConfig.bindings').map((value, index) => {
    const binding = record(value, `inputConfig.bindings[${index}]`);
    return {
      tag: defineTag(nonEmptyString(binding.tag, `inputConfig.bindings[${index}].tag`)),
      actionId: nonEmptyString(binding.actionId, `inputConfig.bindings[${index}].actionId`),
    };
  });
  const inputMappingContexts = array(root.inputMappingContexts, 'inputMappingContexts')
    .map(parseContext);
  const devicePromptsRaw = record(root.devicePrompts, 'devicePrompts');
  const controlLabelsRaw = record(devicePromptsRaw.controlLabels, 'devicePrompts.controlLabels');
  const controlLabels = Object.fromEntries(Object.entries(controlLabelsRaw).map(([control, label]) => [
    nonEmptyString(control, 'controlLabels key'),
    nonEmptyString(label, `controlLabels.${control}`),
  ]));
  const prompts = array(devicePromptsRaw.prompts, 'devicePrompts.prompts').map(parsePrompt);
  const virtualControls = parseVirtualControls(root.virtualControls);

  validateReferences(inputActions, bindings, inputMappingContexts, prompts, virtualControls);
  return {
    schemaVersion: 1,
    id,
    inputActions,
    inputConfig: { bindings },
    inputMappingContexts,
    devicePrompts: { controlLabels, prompts },
    virtualControls,
  };
}

function parseVirtualControls(value: unknown): VirtualControlsDefinition {
  const source = record(value, 'virtualControls');
  const joystickSource = record(source.joystick, 'virtualControls.joystick');
  const control = virtualControl(joystickSource.control, 'virtualControls.joystick.control');
  if (joystickSource.mode !== 'fixed' && joystickSource.mode !== 'floating') {
    throw new TypeError('virtualControls.joystick.mode 必须是 fixed 或 floating');
  }
  const baseRadiusPx = rangedNumber(
    joystickSource.baseRadiusPx,
    'virtualControls.joystick.baseRadiusPx',
    32,
    128,
  );
  const travelRadiusPx = rangedNumber(
    joystickSource.travelRadiusPx,
    'virtualControls.joystick.travelRadiusPx',
    8,
    baseRadiusPx,
  );
  const knobRadiusPx = rangedNumber(
    joystickSource.knobRadiusPx,
    'virtualControls.joystick.knobRadiusPx',
    8,
    baseRadiusPx,
  );
  const buttons = array(source.buttons, 'virtualControls.buttons').map(parseVirtualButton);
  unique(buttons.map((button) => button.id), 'VirtualButton id');
  unique(buttons.map((button) => button.control), 'VirtualButton control');

  const layoutsSource = record(source.layouts, 'virtualControls.layouts');
  return {
    desktopDebugQueryParameter: nonEmptyString(
      source.desktopDebugQueryParameter,
      'virtualControls.desktopDebugQueryParameter',
    ),
    joystick: {
      control,
      mode: joystickSource.mode,
      baseRadiusPx,
      travelRadiusPx,
      knobRadiusPx,
      deadZone: rangedNumber(joystickSource.deadZone, 'virtualControls.joystick.deadZone', 0, 0.95),
      sensitivity: rangedNumber(
        joystickSource.sensitivity,
        'virtualControls.joystick.sensitivity',
        0.1,
        3,
      ),
      activationWidthRatio: rangedNumber(
        joystickSource.activationWidthRatio,
        'virtualControls.joystick.activationWidthRatio',
        0.2,
        0.8,
      ),
      activationHeightRatio: rangedNumber(
        joystickSource.activationHeightRatio,
        'virtualControls.joystick.activationHeightRatio',
        0.25,
        0.9,
      ),
    },
    buttons,
    layouts: {
      landscape: parseVirtualLayout(layoutsSource.landscape, 'virtualControls.layouts.landscape'),
      portrait: parseVirtualLayout(layoutsSource.portrait, 'virtualControls.layouts.portrait'),
    },
  };
}

function parseVirtualButton(value: unknown, index: number): VirtualButtonDefinition {
  const label = `virtualControls.buttons[${index}]`;
  const source = record(value, label);
  return {
    id: nonEmptyString(source.id, `${label}.id`),
    control: virtualControl(source.control, `${label}.control`),
    label: nonEmptyString(source.label, `${label}.label`),
    ariaLabel: nonEmptyString(source.ariaLabel, `${label}.ariaLabel`),
    sizePx: rangedNumber(source.sizePx, `${label}.sizePx`, 36, 128),
    gridColumn: positiveInteger(source.gridColumn, `${label}.gridColumn`, 4),
    gridRow: positiveInteger(source.gridRow, `${label}.gridRow`, 6),
    rowSpan: source.rowSpan === undefined
      ? undefined
      : positiveInteger(source.rowSpan, `${label}.rowSpan`, 4),
  };
}

function parseVirtualLayout(value: unknown, label: string): VirtualControlLayoutDefinition {
  const source = record(value, label);
  return {
    edgeInsetPx: rangedNumber(source.edgeInsetPx, `${label}.edgeInsetPx`, 0, 128),
    bottomInsetPx: rangedNumber(source.bottomInsetPx, `${label}.bottomInsetPx`, 0, 192),
    buttonGapPx: rangedNumber(source.buttonGapPx, `${label}.buttonGapPx`, 0, 48),
    scale: rangedNumber(source.scale, `${label}.scale`, 0.5, 1.5),
  };
}

function parseAction(value: unknown, index: number): InputActionDefinition {
  const source = record(value, `inputActions[${index}]`);
  const id = nonEmptyString(source.id, `inputActions[${index}].id`);
  if (source.valueType !== 'digital' && source.valueType !== 'axis2D') {
    throw new TypeError(`${id}.valueType 必须是 digital 或 axis2D`);
  }
  const modifiers = optionalArray(source.modifiers, `${id}.modifiers`)?.map((modifier, modifierIndex) => (
    parseModifier(modifier, `${id}.modifiers[${modifierIndex}]`)
  ));
  if (source.valueType === 'digital' && modifiers?.length) {
    throw new TypeError(`${id} 的 digital Action 不能配置 axis2D Modifier`);
  }
  return {
    id,
    valueType: source.valueType,
    trigger: source.trigger === undefined ? undefined : parseTrigger(source.trigger, id),
    modifiers,
    deadZone: source.deadZone === undefined ? undefined : finiteNumber(source.deadZone, `${id}.deadZone`),
  };
}

function parseTrigger(value: unknown, actionId: string): InputTriggerDefinition {
  const source = record(value, `${actionId}.trigger`);
  if (source.type === 'pressed') return { type: 'pressed' };
  if (source.type === 'hold') {
    return { type: 'hold', thresholdMs: finiteNumber(source.thresholdMs, `${actionId}.thresholdMs`) };
  }
  if (source.type === 'doubleTap') {
    return {
      type: 'doubleTap',
      maximumGapMs: finiteNumber(source.maximumGapMs, `${actionId}.maximumGapMs`),
      maximumTapMs: source.maximumTapMs === undefined
        ? undefined
        : finiteNumber(source.maximumTapMs, `${actionId}.maximumTapMs`),
    };
  }
  throw new TypeError(`${actionId}.trigger.type 不受支持`);
}

function parseModifier(value: unknown, label: string): Axis2DInputModifier {
  const source = record(value, label);
  if (source.type === 'deadZone') {
    return {
      type: 'deadZone',
      minimum: finiteNumber(source.minimum, `${label}.minimum`),
      maximum: source.maximum === undefined ? undefined : finiteNumber(source.maximum, `${label}.maximum`),
    };
  }
  if (source.type === 'scale') {
    return {
      type: 'scale',
      x: finiteNumber(source.x, `${label}.x`),
      y: finiteNumber(source.y, `${label}.y`),
    };
  }
  if (source.type === 'negate') {
    if (source.axes !== undefined && !['x', 'y', 'xy'].includes(String(source.axes))) {
      throw new TypeError(`${label}.axes 必须是 x、y 或 xy`);
    }
    return { type: 'negate', axes: source.axes as 'x' | 'y' | 'xy' | undefined };
  }
  if (source.type === 'normalize') return { type: 'normalize' };
  if (source.type === 'swizzle' && (source.order === 'xy' || source.order === 'yx')) {
    return { type: 'swizzle', order: source.order };
  }
  throw new TypeError(`${label}.type 不受支持`);
}

function parseContext(value: unknown, index: number): ConfigurableInputMappingContextDefinition {
  const source = record(value, `inputMappingContexts[${index}]`);
  const id = nonEmptyString(source.id, `inputMappingContexts[${index}].id`);
  return {
    id,
    priority: finiteNumber(source.priority, `${id}.priority`),
    activeByDefault: optionalBoolean(source.activeByDefault, `${id}.activeByDefault`),
    mappings: array(source.mappings, `${id}.mappings`).map((mapping, mappingIndex) => (
      parseMapping(mapping, `${id}.mappings[${mappingIndex}]`)
    )),
  };
}

function parseMapping(value: unknown, label: string): ConfigurableInputMappingDefinition {
  const source = record(value, label);
  const control = nonEmptyString(source.control, `${label}.control`);
  const deviceKind = parseDeviceKind(source.deviceKind, `${label}.deviceKind`);
  const inferredKind = inferInputDeviceKind(control);
  if (inferredKind && inferredKind !== deviceKind) {
    throw new TypeError(`${label}.control 属于 ${inferredKind}，与 deviceKind ${deviceKind} 不一致`);
  }
  return {
    id: nonEmptyString(source.id, `${label}.id`),
    control,
    actionId: nonEmptyString(source.actionId, `${label}.actionId`),
    deviceKind,
    axis2D: source.axis2D === undefined ? undefined : parseAxis(source.axis2D, `${label}.axis2D`),
    scale: source.scale === undefined ? undefined : parseAxis(source.scale, `${label}.scale`),
    modifiers: optionalArray(source.modifiers, `${label}.modifiers`)?.map((modifier, index) => (
      parseModifier(modifier, `${label}.modifiers[${index}]`)
    )),
    consume: optionalBoolean(source.consume, `${label}.consume`),
  };
}

function parsePrompt(value: unknown, index: number): InputDevicePromptDefinition {
  const label = `devicePrompts.prompts[${index}]`;
  const source = record(value, label);
  const text = optionalString(source.text, `${label}.text`);
  const entries = optionalArray(source.entries, `${label}.entries`)?.map(parsePromptEntry);
  if (!text && !entries?.length) throw new TypeError(`${label} 必须提供 text 或 entries`);
  return {
    mode: nonEmptyString(source.mode, `${label}.mode`),
    deviceKind: parseDeviceKind(source.deviceKind, `${label}.deviceKind`),
    state: optionalString(source.state, `${label}.state`),
    text,
    entries,
    separator: optionalString(source.separator, `${label}.separator`),
  };
}

function parsePromptEntry(value: unknown, index: number): InputPromptEntryDefinition {
  const label = `prompt.entries[${index}]`;
  const source = record(value, label);
  const mappingIds = optionalArray(source.mappingIds, `${label}.mappingIds`)
    ?.map((mappingId, mappingIndex) => nonEmptyString(mappingId, `${label}.mappingIds[${mappingIndex}]`));
  const text = optionalString(source.text, `${label}.text`);
  if (!text && !mappingIds?.length) throw new TypeError(`${label} 必须提供 text 或 mappingIds`);
  return {
    label: nonEmptyString(source.label, `${label}.label`),
    mappingIds,
    text,
    joinWith: optionalString(source.joinWith, `${label}.joinWith`),
  };
}

function validateReferences(
  actions: readonly InputActionDefinition[],
  bindings: readonly { readonly tag: string; readonly actionId: string }[],
  contexts: readonly ConfigurableInputMappingContextDefinition[],
  prompts: readonly InputDevicePromptDefinition[],
  virtualControls: VirtualControlsDefinition,
): void {
  const actionIds = unique(actions.map((action) => action.id), 'InputAction');
  unique(bindings.map((binding) => String(binding.tag)), 'InputConfig 标签');
  unique(bindings.map((binding) => binding.actionId), 'InputConfig Action');
  for (const binding of bindings) {
    if (!actionIds.has(binding.actionId)) throw new Error(`InputConfig 引用了不存在的 Action：${binding.actionId}`);
  }

  unique(contexts.map((context) => context.id), 'InputMappingContext');
  const mappings = new Map<string, ConfigurableInputMappingDefinition>();
  for (const context of contexts) {
    for (const mapping of context.mappings) {
      if (mappings.has(mapping.id)) throw new Error(`重复的 InputMapping id：${mapping.id}`);
      if (!actionIds.has(mapping.actionId)) throw new Error(`${mapping.id} 引用了不存在的 Action：${mapping.actionId}`);
      mappings.set(mapping.id, mapping);
    }
  }

  unique(prompts.map((prompt) => `${prompt.mode}|${prompt.deviceKind}|${prompt.state ?? ''}`), '设备提示');
  for (const prompt of prompts) {
    for (const entry of prompt.entries ?? []) {
      for (const mappingId of entry.mappingIds ?? []) {
        const mapping = mappings.get(mappingId);
        if (!mapping) throw new Error(`设备提示引用了不存在的 Mapping：${mappingId}`);
        if (mapping.deviceKind !== prompt.deviceKind) {
          throw new Error(`设备提示 ${prompt.mode}/${prompt.deviceKind} 不能引用 ${mappingId}`);
        }
      }
    }
  }


  const touchControls = new Set([...mappings.values()]
    .filter((mapping) => mapping.deviceKind === 'touch')
    .map((mapping) => mapping.control));
  for (const control of [
    virtualControls.joystick.control,
    ...virtualControls.buttons.map((button) => button.control),
  ]) {
    if (!touchControls.has(control)) {
      throw new Error(`虚拟控件引用了没有 touch Mapping 的控制路径：${control}`);
    }
  }
}

function parseAxis(value: unknown, label: string): Axis2DValue {
  const source = record(value, label);
  return { x: finiteNumber(source.x, `${label}.x`), y: finiteNumber(source.y, `${label}.y`) };
}

function parseDeviceKind(value: unknown, label: string): InputDeviceKind {
  if (typeof value !== 'string' || !DEVICE_KINDS.has(value as InputDeviceKind)) {
    throw new TypeError(`${label} 不是有效设备类型`);
  }
  return value as InputDeviceKind;
}

function unique(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (result.has(value)) throw new Error(`重复的 ${label}：${value}`);
    result.add(value);
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} 必须是数组`);
  return value;
}

function optionalArray(value: unknown, label: string): unknown[] | undefined {
  return value === undefined ? undefined : array(value, label);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 不能为空`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} 必须是有限数值`);
  return value;
}

function rangedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = finiteNumber(value, label);
  if (result < minimum || result > maximum) {
    throw new RangeError(`${label} 必须位于 [${minimum}, ${maximum}]`);
  }
  return result;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  const result = rangedNumber(value, label, 1, maximum);
  if (!Number.isInteger(result)) throw new TypeError(`${label} 必须是整数`);
  return result;
}

function virtualControl(value: unknown, label: string): string {
  const control = nonEmptyString(value, label);
  if (inferInputDeviceKind(control) !== 'touch') {
    throw new TypeError(`${label} 必须使用 Virtual.* 控制路径`);
  }
  return control;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${label} 必须是布尔值`);
  return value;
}

import type { TagLike } from '../../tags/index';
import { InputActionRuntime } from './InputActionRuntime';
import { applyAxis2DModifiers, validateAxis2DModifier } from './InputModifiers';
import { InputTagRouter } from './InputTagRouter';
import {
  cloneInputValue,
  inputValueIsActive,
  isAxis2DValue,
  zeroInputValue,
} from './inputValue';
import type {
  Axis2DValue,
  InputActionDefinition,
  InputActionHandler,
  InputBindingOptions,
  InputConfigDefinition,
  InputDevice,
  InputDeviceKind,
  InputMappingContextDefinition,
  InputMappingDefinition,
  InputValue,
} from './types';

export interface InputSubsystemOptions {
  readonly actions: readonly InputActionDefinition[];
  readonly config: InputConfigDefinition;
  readonly contexts: readonly InputMappingContextDefinition[];
  readonly devices?: readonly InputDevice[];
  readonly now?: () => number;
  readonly initialDeviceKind?: InputDeviceKind;
}

const DEFAULT_DOUBLE_TAP_DURATION_MS = 250;
const DEVICE_ACTIVITY_THRESHOLD = 0.12;

interface ControlState {
  readonly value: InputValue;
  readonly deviceKind: InputDeviceKind;
}

interface AxisAccumulator {
  x: number;
  y: number;
  sourceControl?: string;
}

type ActiveDeviceListener = (deviceKind: InputDeviceKind) => void;

/**
 * 把设备事件、Mapping Context、Action 触发器和标签回调组合为统一输入管线。
 * 所有 Action 都在 update 中求值，业务层不需要接触 DOM 或具体控制路径。
 */
export class InputSubsystem {
  private readonly now: () => number;
  private readonly actions = new Map<string, InputActionRuntime>();
  private readonly tagRouter: InputTagRouter;
  private readonly contexts = new Map<string, InputMappingContextDefinition>();
  private readonly activeContexts = new Set<string>();
  private readonly devices: InputDevice[];
  private readonly deviceCancelDisposers: Array<() => void> = [];
  private readonly controlValues = new Map<string, ControlState>();
  private readonly lastDeviceActivityMs = new Map<InputDeviceKind, number>();
  private readonly activeDeviceListeners = new Set<ActiveDeviceListener>();
  private effectiveMappings: readonly InputMappingDefinition[] = [];
  private mappingsDirty = true;
  private inputEnabled = true;
  private inputActiveThisFrame = false;
  private activeInputDevice: InputDeviceKind;
  private lastTimestampMs: number;

  public constructor(options: InputSubsystemOptions) {
    this.now = options.now ?? (() => performance.now());
    this.lastTimestampMs = this.now();
    this.activeInputDevice = options.initialDeviceKind ?? 'keyboardMouse';
    this.devices = [...(options.devices ?? [])];
    this.registerActions(options.actions);
    this.tagRouter = new InputTagRouter(options.config, new Set(this.actions.keys()));
    this.registerContexts(options.contexts);

    for (const device of this.devices) {
      this.deviceCancelDisposers.push(device.onCancel(this.handleDeviceCancel));
    }
  }

  public get enabled(): boolean {
    return this.inputEnabled;
  }

  public get activeDeviceKind(): InputDeviceKind {
    return this.activeInputDevice;
  }

  /**
   * 最近一次 `update` 里玩家有没有在操作：这一帧到达过活动事件（按下即松也算），
   * 或者仍有控制按着不放（按住不放之后不再产生事件，所以还要看当前值）。
   *
   * 输入被关掉时恒为 `false`——CommonUI 打开时场景正是这么关的，所以翻页、点按钮
   * 这类界面操作不会被当成游戏操作。指针锁定下的鼠标视角不经过这条管线（`FlyController`
   * 自己读 `movementX`），因此也不算在内。
   */
  public get hasActiveInput(): boolean {
    return this.inputActiveThisFrame;
  }

  public onActiveDeviceChanged(listener: ActiveDeviceListener): () => void {
    this.activeDeviceListeners.add(listener);
    listener(this.activeInputDevice);
    return () => this.activeDeviceListeners.delete(listener);
  }

  public setEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return;
    this.inputEnabled = enabled;
    this.resetDeviceState();
    this.cancelAll(this.now());
    this.mappingsDirty = true;
  }

  public setContextActive(contextId: string, active: boolean): void {
    if (!this.contexts.has(contextId)) throw new Error(`不存在 InputMappingContext：${contextId}`);
    const changed = active ? !this.activeContexts.has(contextId) : this.activeContexts.has(contextId);
    if (!changed) return;

    this.cancelAll(this.now());
    if (active) this.activeContexts.add(contextId);
    else this.activeContexts.delete(contextId);
    this.mappingsDirty = true;
  }

  public isContextActive(contextId: string): boolean {
    return this.activeContexts.has(contextId);
  }

  /**
   * 原子替换 Mapping Context 定义，用于运行时重绑定。
   * 已激活 Context 会保持激活；替换期间统一取消当前输入，避免按键卡住。
   */
  public replaceMappingContexts(definitions: readonly InputMappingContextDefinition[]): void {
    const nextContexts = new Map<string, InputMappingContextDefinition>();
    for (const definition of definitions) {
      if (!definition.id) throw new TypeError('InputMappingContext id 不能为空');
      if (nextContexts.has(definition.id)) {
        throw new Error(`重复的 InputMappingContext：${definition.id}`);
      }
      this.validateContext(definition);
      nextContexts.set(definition.id, definition);
    }

    const previouslyActive = new Set(this.activeContexts);
    this.resetDeviceState();
    this.cancelAll(this.now());
    this.contexts.clear();
    this.activeContexts.clear();
    for (const [id, context] of nextContexts) {
      this.contexts.set(id, context);
      if (previouslyActive.has(id) || (!previouslyActive.size && context.activeByDefault)) {
        this.activeContexts.add(id);
      }
    }
    this.mappingsDirty = true;
  }

  public bind(
    tag: TagLike,
    handler: InputActionHandler,
    options: InputBindingOptions = {},
  ): () => void {
    return this.tagRouter.bind(tag, handler, options);
  }

  public getValue(tag: TagLike): InputValue {
    return this.getRuntimeForTag(tag).currentValue;
  }

  public getDigital(tag: TagLike): boolean {
    const value = this.getValue(tag);
    if (typeof value !== 'boolean') throw new TypeError(`标签 ${tag} 对应的 Action 不是 digital`);
    return value;
  }

  public getAxis2D(tag: TagLike): Axis2DValue {
    const value = this.getValue(tag);
    if (!isAxis2DValue(value)) throw new TypeError(`标签 ${tag} 对应的 Action 不是 axis2D`);
    return value;
  }

  /**
   * 返回当前生效 MappingContext 中，指定语义标签在某设备上的控制路径。
   * UI 通过这里取得提示来源，避免绕过 Context 优先级或显示已经失效的重绑定。
   */
  public getMappedControls(
    tag: TagLike,
    deviceKind: InputDeviceKind = this.activeInputDevice,
  ): readonly string[] {
    const actionId = this.tagRouter.getActionId(tag);
    if (this.mappingsDirty) this.rebuildEffectiveMappings();
    return [...new Set(this.effectiveMappings
      .filter((mapping) => (
        mapping.actionId === actionId
        && (mapping.deviceKind === undefined || mapping.deviceKind === deviceKind)
      ))
      .map((mapping) => mapping.control))];
  }

  public update(timestampMs = this.now()): void {
    const frameTimestamp = Math.max(this.lastTimestampMs, timestampMs);
    this.inputActiveThisFrame = false;
    if (!this.inputEnabled) {
      for (const device of this.devices) device.reset();
      this.lastTimestampMs = frameTimestamp;
      return;
    }

    if (this.mappingsDirty) {
      this.rebuildEffectiveMappings();
      this.recalculateActions(this.lastTimestampMs);
    }

    for (const device of this.devices) device.poll?.(frameTimestamp);

    const events = this.devices
      .flatMap((device) => [...device.drainEvents()])
      .sort((left, right) => left.timestampMs - right.timestampMs);

    for (const event of events) {
      const eventTimestamp = Math.max(
        this.lastTimestampMs,
        Math.min(frameTimestamp, event.timestampMs),
      );
      this.advanceTimedTriggers(eventTimestamp);
      this.noteDeviceActivity(event.deviceKind, event.value, eventTimestamp);
      this.controlValues.set(event.control, {
        value: cloneInputValue(event.value),
        deviceKind: event.deviceKind,
      });
      this.recalculateActions(eventTimestamp, event.control, event.deviceKind);
      this.advanceTimedTriggers(eventTimestamp);
      this.lastTimestampMs = eventTimestamp;
    }

    this.advanceTimedTriggers(frameTimestamp);
    for (const runtime of this.actions.values()) runtime.emitOngoing(frameTimestamp);
    if (!this.inputActiveThisFrame) this.inputActiveThisFrame = this.hasHeldControl();
    this.lastTimestampMs = frameTimestamp;
  }

  /** 立即清除所有 Action，并对进行中的 Action 统一派发 canceled。 */
  public cancelAll(timestampMs = this.now()): void {
    const safeTimestamp = Math.max(this.lastTimestampMs, timestampMs);
    for (const runtime of this.actions.values()) runtime.cancel(safeTimestamp);
    this.lastTimestampMs = safeTimestamp;
  }

  public dispose(): void {
    this.cancelAll(this.now());
    for (const dispose of this.deviceCancelDisposers.splice(0)) dispose();
    for (const device of this.devices) device.dispose?.();
    this.tagRouter.clear();
    this.controlValues.clear();
    this.activeDeviceListeners.clear();
  }

  private readonly handleDeviceCancel = (): void => {
    this.resetDeviceState();
    this.cancelAll(this.now());
  };

  private registerActions(definitions: readonly InputActionDefinition[]): void {
    for (const definition of definitions) {
      if (!definition.id) throw new TypeError('InputAction id 不能为空');
      if (this.actions.has(definition.id)) throw new Error(`重复的 InputAction：${definition.id}`);
      this.validateAction(definition);
      this.actions.set(definition.id, new InputActionRuntime(
        definition,
        (event) => this.tagRouter.dispatch(definition.id, event),
      ));
    }
  }

  private registerContexts(definitions: readonly InputMappingContextDefinition[]): void {
    for (const definition of definitions) {
      if (!definition.id) throw new TypeError('InputMappingContext id 不能为空');
      if (this.contexts.has(definition.id)) {
        throw new Error(`重复的 InputMappingContext：${definition.id}`);
      }
      this.validateContext(definition);
      this.contexts.set(definition.id, definition);
      if (definition.activeByDefault) this.activeContexts.add(definition.id);
    }
  }

  private validateContext(definition: InputMappingContextDefinition): void {
    for (const mapping of definition.mappings) {
      if (!mapping.control) throw new TypeError(`${definition.id} 中存在空控制路径`);
      if (!this.actions.has(mapping.actionId)) {
        throw new Error(`${definition.id} 引用了不存在的 InputAction：${mapping.actionId}`);
      }
      const action = this.actions.get(mapping.actionId)?.definition;
      if (action?.valueType === 'digital' && mapping.modifiers?.length) {
        throw new TypeError(`${definition.id}/${mapping.control} 不能给 digital Action 配置 axis2D Modifier`);
      }
      this.validateAxis(mapping.axis2D, `${definition.id}/${mapping.control} 的 axis2D`);
      this.validateAxis(mapping.scale, `${definition.id}/${mapping.control} 的 scale`);
      for (const modifier of mapping.modifiers ?? []) {
        validateAxis2DModifier(modifier, `${definition.id}/${mapping.control}`);
      }
    }
  }

  private validateAction(definition: InputActionDefinition): void {
    const deadZone = definition.deadZone ?? 0;
    if (!Number.isFinite(deadZone) || deadZone < 0 || deadZone >= 1) {
      throw new RangeError(`${definition.id} 的 deadZone 必须位于 [0, 1)`);
    }
    if (definition.valueType === 'digital' && definition.modifiers?.length) {
      throw new TypeError(`${definition.id} 不能给 digital Action 配置 axis2D Modifier`);
    }
    for (const modifier of definition.modifiers ?? []) {
      validateAxis2DModifier(modifier, definition.id);
    }
    const trigger = definition.trigger;
    if (trigger?.type === 'hold' && (!Number.isFinite(trigger.thresholdMs) || trigger.thresholdMs < 0)) {
      throw new RangeError(`${definition.id} 的 Hold thresholdMs 不能为负数`);
    }
    if (trigger?.type === 'doubleTap') {
      if (!Number.isFinite(trigger.maximumGapMs) || trigger.maximumGapMs <= 0) {
        throw new RangeError(`${definition.id} 的 DoubleTap maximumGapMs 必须大于 0`);
      }
      const maximumTapMs = trigger.maximumTapMs ?? DEFAULT_DOUBLE_TAP_DURATION_MS;
      if (!Number.isFinite(maximumTapMs) || maximumTapMs <= 0) {
        throw new RangeError(`${definition.id} 的 DoubleTap maximumTapMs 必须大于 0`);
      }
    }
  }

  private validateAxis(axis: Axis2DValue | undefined, label: string): void {
    if (axis && (!Number.isFinite(axis.x) || !Number.isFinite(axis.y))) {
      throw new TypeError(`${label} 必须是有限数值`);
    }
  }

  private rebuildEffectiveMappings(): void {
    const sortedContexts = [...this.activeContexts]
      .map((id) => this.contexts.get(id))
      .filter((context): context is InputMappingContextDefinition => context !== undefined)
      .sort((left, right) => right.priority - left.priority);
    const consumedControls = new Set<string>();
    const effectiveMappings: InputMappingDefinition[] = [];

    for (const context of sortedContexts) {
      const mappingsByControl = new Map<string, InputMappingDefinition[]>();
      for (const mapping of context.mappings) {
        if (consumedControls.has(mapping.control)) continue;
        const mappings = mappingsByControl.get(mapping.control) ?? [];
        mappings.push(mapping);
        mappingsByControl.set(mapping.control, mappings);
      }
      for (const [control, mappings] of mappingsByControl) {
        effectiveMappings.push(...mappings);
        if (mappings.some((mapping) => mapping.consume !== false)) consumedControls.add(control);
      }
    }

    this.effectiveMappings = effectiveMappings;
    this.mappingsDirty = false;
  }

  private recalculateActions(
    timestampMs: number,
    eventControl?: string,
    eventDeviceKind?: InputDeviceKind,
  ): void {
    const digitalSources = new Map<
      string,
      Map<InputDeviceKind, string>
    >();
    const axisSources = new Map<
      string,
      Map<InputDeviceKind, AxisAccumulator>
    >();

    for (const mapping of this.effectiveMappings) {
      const controlState = this.controlValues.get(mapping.control);
      if (!controlState) continue;
      const runtime = this.actions.get(mapping.actionId);
      if (!runtime) continue;

      if (runtime.definition.valueType === 'digital') {
        if (!inputValueIsActive(controlState.value, runtime.definition.deadZone)) continue;
        const sources = digitalSources.get(mapping.actionId) ?? new Map();
        sources.set(controlState.deviceKind, mapping.control);
        digitalSources.set(mapping.actionId, sources);
        continue;
      }

      const contribution = this.mapToAxis2D(controlState.value, mapping);
      if (!contribution || Math.hypot(contribution.x, contribution.y) <= 1e-8) continue;
      const sources = axisSources.get(mapping.actionId) ?? new Map();
      const accumulated = sources.get(controlState.deviceKind) ?? { x: 0, y: 0 };
      accumulated.x += contribution.x;
      accumulated.y += contribution.y;
      accumulated.sourceControl = mapping.control;
      sources.set(controlState.deviceKind, accumulated);
      axisSources.set(mapping.actionId, sources);
    }

    for (const [actionId, runtime] of this.actions) {
      if (runtime.definition.valueType === 'digital') {
        const sources = digitalSources.get(actionId);
        const deviceKind = this.chooseMostRecentDevice(sources?.keys());
        const sourceControl = deviceKind ? sources?.get(deviceKind) : undefined;
        runtime.applyValue(deviceKind !== undefined, timestampMs, sourceControl, deviceKind);
        continue;
      }

      const candidates = new Map<InputDeviceKind, AxisAccumulator>();
      for (const [deviceKind, source] of axisSources.get(actionId) ?? []) {
        const modified = this.finalizeAxis(
          applyAxis2DModifiers(source, runtime.definition.modifiers),
          runtime.definition.deadZone ?? 0,
        );
        if (Math.hypot(modified.x, modified.y) <= 1e-8) continue;
        candidates.set(deviceKind, { ...modified, sourceControl: source.sourceControl });
      }
      const deviceKind = this.chooseMostRecentDevice(candidates.keys());
      const selected = deviceKind ? candidates.get(deviceKind) : undefined;
      const sourceControl = deviceKind === eventDeviceKind
        ? eventControl ?? selected?.sourceControl
        : selected?.sourceControl;
      runtime.applyValue(
        selected ? { x: selected.x, y: selected.y } : zeroInputValue(runtime.definition),
        timestampMs,
        sourceControl,
        deviceKind,
      );
    }
  }

  private mapToAxis2D(
    rawValue: InputValue,
    mapping: InputMappingDefinition,
  ): Axis2DValue | undefined {
    let value: Axis2DValue;
    if (typeof rawValue === 'boolean') {
      if (!mapping.axis2D) return undefined;
      value = rawValue ? mapping.axis2D : { x: 0, y: 0 };
    } else {
      value = rawValue;
    }
    const scaled = {
      x: value.x * (mapping.scale?.x ?? 1),
      y: value.y * (mapping.scale?.y ?? 1),
    };
    return applyAxis2DModifiers(scaled, mapping.modifiers);
  }

  private finalizeAxis(value: Axis2DValue, deadZone: number): Axis2DValue {
    const length = Math.hypot(value.x, value.y);
    if (length <= deadZone) return { x: 0, y: 0 };
    if (length <= 1) return value;
    return { x: value.x / length, y: value.y / length };
  }

  private advanceTimedTriggers(timestampMs: number): void {
    for (const runtime of this.actions.values()) runtime.advanceTimedTrigger(timestampMs);
  }

  private noteDeviceActivity(
    deviceKind: InputDeviceKind,
    value: InputValue,
    timestampMs: number,
  ): void {
    if (!inputValueIsActive(value, DEVICE_ACTIVITY_THRESHOLD)) return;
    this.inputActiveThisFrame = true;
    this.lastDeviceActivityMs.set(deviceKind, timestampMs);
    if (this.activeInputDevice === deviceKind) return;
    this.activeInputDevice = deviceKind;
    for (const listener of [...this.activeDeviceListeners]) listener(deviceKind);
  }

  /**
   * 当前是否还有控制按着不放。遍历量是「这条会话里出现过的控制路径数」，
   * 与世界大小无关；释放后的控制会留在表里，但值是静止的，不会被算成活动。
   */
  private hasHeldControl(): boolean {
    for (const state of this.controlValues.values()) {
      if (inputValueIsActive(state.value, DEVICE_ACTIVITY_THRESHOLD)) return true;
    }
    return false;
  }

  private chooseMostRecentDevice(
    devices: Iterable<InputDeviceKind> | undefined,
  ): InputDeviceKind | undefined {
    if (!devices) return undefined;
    let selected: InputDeviceKind | undefined;
    let selectedTimestamp = Number.NEGATIVE_INFINITY;
    for (const deviceKind of devices) {
      const timestamp = this.lastDeviceActivityMs.get(deviceKind) ?? Number.NEGATIVE_INFINITY;
      if (
        selected === undefined
        || timestamp > selectedTimestamp
        || (timestamp === selectedTimestamp && deviceKind === this.activeInputDevice)
      ) {
        selected = deviceKind;
        selectedTimestamp = timestamp;
      }
    }
    return selected;
  }

  private getRuntimeForTag(tag: TagLike): InputActionRuntime {
    const actionId = this.tagRouter.getActionId(tag);
    const runtime = this.actions.get(actionId);
    if (!runtime) throw new Error(`标签 ${tag} 对应的 InputAction 不存在：${actionId}`);
    return runtime;
  }

  private resetDeviceState(): void {
    for (const device of this.devices) device.reset();
    this.controlValues.clear();
  }
}

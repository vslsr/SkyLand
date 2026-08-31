import type { TagLike } from '../../tags/index';
import { InputActionRuntime } from './InputActionRuntime';
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
}

const DEFAULT_DOUBLE_TAP_DURATION_MS = 250;

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
  private readonly controlValues = new Map<string, InputValue>();
  private effectiveMappings: readonly InputMappingDefinition[] = [];
  private mappingsDirty = true;
  private inputEnabled = true;
  private lastTimestampMs: number;

  public constructor(options: InputSubsystemOptions) {
    this.now = options.now ?? (() => performance.now());
    this.lastTimestampMs = this.now();
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

  public update(timestampMs = this.now()): void {
    const frameTimestamp = Math.max(this.lastTimestampMs, timestampMs);
    if (!this.inputEnabled) {
      for (const device of this.devices) device.reset();
      this.lastTimestampMs = frameTimestamp;
      return;
    }

    if (this.mappingsDirty) {
      this.rebuildEffectiveMappings();
      this.recalculateActions(this.lastTimestampMs);
    }

    const events = this.devices
      .flatMap((device) => [...device.drainEvents()])
      .sort((left, right) => left.timestampMs - right.timestampMs);

    for (const event of events) {
      const eventTimestamp = Math.max(
        this.lastTimestampMs,
        Math.min(frameTimestamp, event.timestampMs),
      );
      this.advanceTimedTriggers(eventTimestamp);
      this.controlValues.set(event.control, cloneInputValue(event.value));
      this.recalculateActions(eventTimestamp, event.control);
      this.advanceTimedTriggers(eventTimestamp);
      this.lastTimestampMs = eventTimestamp;
    }

    this.advanceTimedTriggers(frameTimestamp);
    for (const runtime of this.actions.values()) runtime.emitOngoing(frameTimestamp);
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
      for (const mapping of definition.mappings) {
        if (!mapping.control) throw new TypeError(`${definition.id} 中存在空控制路径`);
        if (!this.actions.has(mapping.actionId)) {
          throw new Error(`${definition.id} 引用了不存在的 InputAction：${mapping.actionId}`);
        }
        this.validateAxis(mapping.axis2D, `${definition.id}/${mapping.control} 的 axis2D`);
        this.validateAxis(mapping.scale, `${definition.id}/${mapping.control} 的 scale`);
      }
      this.contexts.set(definition.id, definition);
      if (definition.activeByDefault) this.activeContexts.add(definition.id);
    }
  }

  private validateAction(definition: InputActionDefinition): void {
    const deadZone = definition.deadZone ?? 0;
    if (!Number.isFinite(deadZone) || deadZone < 0 || deadZone >= 1) {
      throw new RangeError(`${definition.id} 的 deadZone 必须位于 [0, 1)`);
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

  private recalculateActions(timestampMs: number, sourceControl?: string): void {
    const nextValues = new Map<string, InputValue>();
    for (const [actionId, runtime] of this.actions) {
      nextValues.set(actionId, zeroInputValue(runtime.definition));
    }

    for (const mapping of this.effectiveMappings) {
      const rawValue = this.controlValues.get(mapping.control);
      if (rawValue === undefined) continue;
      const runtime = this.actions.get(mapping.actionId);
      if (!runtime) continue;

      if (runtime.definition.valueType === 'digital') {
        if (inputValueIsActive(rawValue, runtime.definition.deadZone)) {
          nextValues.set(mapping.actionId, true);
        }
        continue;
      }

      const contribution = this.mapToAxis2D(rawValue, mapping);
      if (!contribution) continue;
      const accumulated = nextValues.get(mapping.actionId);
      if (!accumulated || typeof accumulated === 'boolean') continue;
      nextValues.set(mapping.actionId, {
        x: accumulated.x + contribution.x,
        y: accumulated.y + contribution.y,
      });
    }

    for (const [actionId, runtime] of this.actions) {
      let nextValue = nextValues.get(actionId) ?? zeroInputValue(runtime.definition);
      if (isAxis2DValue(nextValue)) {
        nextValue = this.finalizeAxis(nextValue, runtime.definition.deadZone ?? 0);
      }
      runtime.applyValue(nextValue, timestampMs, sourceControl);
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
    return {
      x: value.x * (mapping.scale?.x ?? 1),
      y: value.y * (mapping.scale?.y ?? 1),
    };
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

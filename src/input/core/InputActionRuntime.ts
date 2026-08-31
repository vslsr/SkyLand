import type {
  DoubleTapInputTrigger,
  InputActionDefinition,
  InputDeviceKind,
  InputPhase,
  InputTriggerDefinition,
  InputValue,
} from './types';
import {
  cloneInputValue,
  inputValueIsActive,
  inputValuesEqual,
  zeroInputValue,
} from './inputValue';

type DoubleTapStage = 'idle' | 'firstDown' | 'waitingSecond' | 'secondDown';

export interface EvaluatedActionEvent {
  readonly phase: InputPhase;
  readonly value: InputValue;
  readonly elapsedMs: number;
  readonly timestampMs: number;
  readonly sourceControl?: string;
  readonly deviceKind?: InputDeviceKind;
}

const DEFAULT_TRIGGER: InputTriggerDefinition = { type: 'pressed' };
const DEFAULT_DOUBLE_TAP_DURATION_MS = 250;

/** 单个 InputAction 的触发器状态机，与设备和标签路由完全解耦。 */
export class InputActionRuntime {
  public readonly definition: InputActionDefinition;
  private readonly eventHandler: (event: EvaluatedActionEvent) => void;
  private value: InputValue;
  private startedAt?: number;
  private sourceControl?: string;
  private deviceKind?: InputDeviceKind;
  private hasTriggered = false;
  private doubleTapStage: DoubleTapStage = 'idle';
  private firstTapReleasedAt?: number;

  public constructor(
    definition: InputActionDefinition,
    eventHandler: (event: EvaluatedActionEvent) => void,
  ) {
    this.definition = definition;
    this.eventHandler = eventHandler;
    this.value = zeroInputValue(definition);
  }

  public get currentValue(): InputValue {
    return cloneInputValue(this.value);
  }

  public applyValue(
    nextValue: InputValue,
    timestampMs: number,
    sourceControl?: string,
    deviceKind?: InputDeviceKind,
  ): void {
    if (inputValuesEqual(this.value, nextValue)) {
      if (inputValueIsActive(this.value, this.definition.deadZone) && deviceKind) {
        this.sourceControl = sourceControl ?? this.sourceControl;
        this.deviceKind = deviceKind;
      }
      return;
    }
    const wasActive = inputValueIsActive(this.value, this.definition.deadZone);
    const isActive = inputValueIsActive(nextValue, this.definition.deadZone);
    this.value = cloneInputValue(nextValue);
    if (isActive && deviceKind) {
      this.sourceControl = sourceControl ?? this.sourceControl;
      this.deviceKind = deviceKind;
    }
    if (wasActive === isActive) return;

    const trigger = this.definition.trigger ?? DEFAULT_TRIGGER;
    if (trigger.type === 'pressed') {
      if (isActive) {
        this.beginSequence(timestampMs, sourceControl, deviceKind);
        this.triggerSequence(timestampMs);
      } else {
        this.finishSequence('completed', timestampMs);
      }
      return;
    }

    if (trigger.type === 'hold') {
      if (isActive) this.beginSequence(timestampMs, sourceControl, deviceKind);
      else this.finishSequence(this.hasTriggered ? 'completed' : 'canceled', timestampMs);
      return;
    }

    this.applyDoubleTapTransition(trigger, isActive, timestampMs, sourceControl, deviceKind);
  }

  public advanceTimedTrigger(timestampMs: number): void {
    if (this.startedAt === undefined) return;
    const trigger = this.definition.trigger ?? DEFAULT_TRIGGER;
    if (
      trigger.type === 'hold'
      && inputValueIsActive(this.value, this.definition.deadZone)
      && !this.hasTriggered
      && timestampMs - this.startedAt >= trigger.thresholdMs
    ) {
      this.triggerSequence(timestampMs);
    } else if (trigger.type === 'doubleTap') {
      const maximumTapMs = trigger.maximumTapMs ?? DEFAULT_DOUBLE_TAP_DURATION_MS;
      if (this.doubleTapStage === 'firstDown' && timestampMs - this.startedAt > maximumTapMs) {
        this.finishSequence('canceled', timestampMs);
      } else if (
        this.doubleTapStage === 'waitingSecond'
        && this.firstTapReleasedAt !== undefined
        && timestampMs - this.firstTapReleasedAt > trigger.maximumGapMs
      ) {
        this.finishSequence('canceled', timestampMs);
      }
    }
  }

  public emitOngoing(timestampMs: number): void {
    if (this.startedAt !== undefined) this.emit('ongoing', timestampMs);
  }

  public cancel(timestampMs: number): void {
    this.value = zeroInputValue(this.definition);
    if (this.startedAt !== undefined) this.emit('canceled', timestampMs);
    this.resetSequence();
  }

  private applyDoubleTapTransition(
    trigger: DoubleTapInputTrigger,
    isActive: boolean,
    timestampMs: number,
    sourceControl?: string,
    deviceKind?: InputDeviceKind,
  ): void {
    if (isActive) {
      if (
        this.doubleTapStage === 'waitingSecond'
        && this.firstTapReleasedAt !== undefined
        && timestampMs - this.firstTapReleasedAt <= trigger.maximumGapMs
      ) {
        this.doubleTapStage = 'secondDown';
        this.sourceControl = sourceControl ?? this.sourceControl;
        this.deviceKind = deviceKind ?? this.deviceKind;
        this.triggerSequence(timestampMs);
        return;
      }

      if (this.startedAt !== undefined) this.finishSequence('canceled', timestampMs);
      this.beginSequence(timestampMs, sourceControl, deviceKind);
      this.doubleTapStage = 'firstDown';
      return;
    }

    if (this.doubleTapStage === 'firstDown') {
      const maximumTapMs = trigger.maximumTapMs ?? DEFAULT_DOUBLE_TAP_DURATION_MS;
      if (this.startedAt !== undefined && timestampMs - this.startedAt <= maximumTapMs) {
        this.doubleTapStage = 'waitingSecond';
        this.firstTapReleasedAt = timestampMs;
      } else {
        this.finishSequence('canceled', timestampMs);
      }
    } else if (this.doubleTapStage === 'secondDown') {
      this.finishSequence('completed', timestampMs);
    }
  }

  private beginSequence(
    timestampMs: number,
    sourceControl?: string,
    deviceKind?: InputDeviceKind,
  ): void {
    this.startedAt = timestampMs;
    this.sourceControl = sourceControl;
    this.deviceKind = deviceKind;
    this.hasTriggered = false;
    this.firstTapReleasedAt = undefined;
    this.emit('started', timestampMs);
  }

  private triggerSequence(timestampMs: number): void {
    this.hasTriggered = true;
    this.emit('triggered', timestampMs);
  }

  private finishSequence(phase: 'completed' | 'canceled', timestampMs: number): void {
    if (this.startedAt !== undefined) this.emit(phase, timestampMs);
    this.resetSequence();
  }

  private resetSequence(): void {
    this.startedAt = undefined;
    this.sourceControl = undefined;
    this.deviceKind = undefined;
    this.hasTriggered = false;
    this.doubleTapStage = 'idle';
    this.firstTapReleasedAt = undefined;
  }

  private emit(phase: InputPhase, timestampMs: number): void {
    this.eventHandler({
      phase,
      value: cloneInputValue(this.value),
      elapsedMs: this.startedAt === undefined ? 0 : Math.max(0, timestampMs - this.startedAt),
      timestampMs,
      sourceControl: this.sourceControl,
      deviceKind: this.deviceKind,
    });
  }
}

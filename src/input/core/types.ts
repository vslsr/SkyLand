import type { Tag, TagLike } from '../../tags/index';

export interface Axis2DValue {
  readonly x: number;
  readonly y: number;
}

export type InputValue = boolean | Axis2DValue;
export type InputValueType = 'digital' | 'axis2D';
export type InputPhase = 'started' | 'ongoing' | 'triggered' | 'completed' | 'canceled';

export interface PressedInputTrigger {
  readonly type: 'pressed';
}

export interface HoldInputTrigger {
  readonly type: 'hold';
  readonly thresholdMs: number;
}

export interface DoubleTapInputTrigger {
  readonly type: 'doubleTap';
  readonly maximumGapMs: number;
  readonly maximumTapMs?: number;
}

export type InputTriggerDefinition =
  | PressedInputTrigger
  | HoldInputTrigger
  | DoubleTapInputTrigger;

export interface InputActionDefinition {
  readonly id: string;
  readonly valueType: InputValueType;
  readonly trigger?: InputTriggerDefinition;
  readonly deadZone?: number;
}

export interface InputConfigBinding {
  readonly tag: TagLike;
  readonly actionId: string;
}

export interface InputConfigDefinition {
  readonly bindings: readonly InputConfigBinding[];
}

export interface InputMappingDefinition {
  readonly control: string;
  readonly actionId: string;
  /** 将 digital 控制映射为 axis2D 时使用的方向。 */
  readonly axis2D?: Axis2DValue;
  /** 对 axis2D 输入进行逐轴缩放。 */
  readonly scale?: Axis2DValue;
  /** 是否阻止更低优先级 Context 使用同一个控制路径，默认为 true。 */
  readonly consume?: boolean;
}

export interface InputMappingContextDefinition {
  readonly id: string;
  readonly priority: number;
  readonly activeByDefault?: boolean;
  readonly mappings: readonly InputMappingDefinition[];
}

export interface InputActionEvent {
  readonly tag: Tag;
  readonly actionId: string;
  readonly phase: InputPhase;
  readonly value: InputValue;
  readonly elapsedMs: number;
  readonly timestampMs: number;
  readonly sourceControl?: string;
}

export type InputActionHandler = (event: InputActionEvent) => void;

export interface InputBindingOptions {
  readonly phases?: readonly InputPhase[];
  /** 允许父标签监听其所有后代标签；默认只做精确匹配。 */
  readonly includeDescendants?: boolean;
}

export interface InputControlEvent {
  readonly control: string;
  readonly value: InputValue;
  readonly timestampMs: number;
}

export interface InputDevice {
  drainEvents(): readonly InputControlEvent[];
  reset(): void;
  onCancel(handler: () => void): () => void;
  dispose?(): void;
}

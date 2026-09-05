import type {
  InputActionDefinition,
  InputConfigDefinition,
  InputDeviceKind,
  InputMappingContextDefinition,
  InputMappingDefinition,
} from '../core/types';

export interface ConfigurableInputMappingDefinition
  extends Omit<InputMappingDefinition, 'id' | 'deviceKind'> {
  readonly id: string;
  readonly deviceKind: InputDeviceKind;
}

export interface ConfigurableInputMappingContextDefinition
  extends Omit<InputMappingContextDefinition, 'mappings'> {
  readonly mappings: readonly ConfigurableInputMappingDefinition[];
}

export interface InputPromptEntryDefinition {
  readonly label: string;
  readonly mappingIds?: readonly string[];
  readonly text?: string;
  readonly joinWith?: string;
}

export interface InputDevicePromptDefinition {
  readonly mode: string;
  readonly deviceKind: InputDeviceKind;
  readonly state?: string;
  readonly text?: string;
  readonly entries?: readonly InputPromptEntryDefinition[];
  readonly separator?: string;
}

export interface InputDevicePromptConfigDefinition {
  readonly controlLabels: Readonly<Record<string, string>>;
  readonly prompts: readonly InputDevicePromptDefinition[];
}

export type VirtualJoystickMode = 'fixed' | 'floating';

export interface VirtualJoystickDefinition {
  readonly control: string;
  readonly mode: VirtualJoystickMode;
  readonly baseRadiusPx: number;
  readonly travelRadiusPx: number;
  readonly knobRadiusPx: number;
  readonly deadZone: number;
  readonly sensitivity: number;
  readonly activationWidthRatio: number;
  readonly activationHeightRatio: number;
}

/**
 * 瞄准摇杆：分两层的那一根（设计稿「工具、武器使用流程」的移动端那一条）。
 *
 * 它不是第二根移动摇杆——内层只管**朝哪儿**，推进外层那一圈才开始蓄力，松手就是
 * 发射。蓄力那一下走的是 `chargeControl` 这个数字控件，也就是主手使用键在触屏上
 * 的来源：这样「按下去、蓄力、松手」在两端是同一条路径，物品栏那圈倒计时不必知道
 * 这一下是从鼠标还是从摇杆来的。
 */
export interface VirtualAimJoystickDefinition {
  readonly control: string;
  /** 推进外层时按下的数字控件。松手（或缩回内层）时抬起。 */
  readonly chargeControl: string;
  readonly baseRadiusPx: number;
  readonly travelRadiusPx: number;
  /** 内层半径，像素。设计稿要求它**大于**外圈那一环的宽度：瞄准是常做的事。 */
  readonly innerRadiusPx: number;
  readonly knobRadiusPx: number;
  readonly deadZone: number;
  readonly sensitivity: number;
  readonly activationWidthRatio: number;
  readonly activationHeightRatio: number;
}

export interface VirtualButtonDefinition {
  readonly id: string;
  readonly control: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly sizePx: number;
  readonly gridColumn: number;
  readonly gridRow: number;
  readonly rowSpan?: number;
}

export interface VirtualControlLayoutDefinition {
  readonly edgeInsetPx: number;
  readonly bottomInsetPx: number;
  readonly buttonGapPx: number;
  readonly scale: number;
}

export interface VirtualControlsDefinition {
  readonly desktopDebugQueryParameter: string;
  readonly joystick: VirtualJoystickDefinition;
  /** 右手边那根瞄准摇杆。没配就没有——键鼠端本来就用指针瞄。 */
  readonly aimJoystick?: VirtualAimJoystickDefinition;
  readonly buttons: readonly VirtualButtonDefinition[];
  readonly layouts: {
    readonly landscape: VirtualControlLayoutDefinition;
    readonly portrait: VirtualControlLayoutDefinition;
  };
}

export interface InputSchemeDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly inputActions: readonly InputActionDefinition[];
  readonly inputConfig: InputConfigDefinition;
  readonly inputMappingContexts: readonly ConfigurableInputMappingContextDefinition[];
  readonly devicePrompts: InputDevicePromptConfigDefinition;
  readonly virtualControls: VirtualControlsDefinition;
}

export type InputRebindConflictPolicy = 'swap' | 'reject' | 'allow';

export interface InputRebindOptions {
  readonly conflict?: InputRebindConflictPolicy;
}

export type InputBindingChangeReason = 'rebind' | 'reset' | 'resetAll' | 'restore';

export interface InputBindingsChangedEvent {
  readonly reason: InputBindingChangeReason;
  readonly mappingIds: readonly string[];
}

export interface StoredInputBindingOverrides {
  readonly schemaVersion: 1;
  readonly schemeId: string;
  readonly bindings: Readonly<Record<string, string>>;
}

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

export interface InputSchemeDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly inputActions: readonly InputActionDefinition[];
  readonly inputConfig: InputConfigDefinition;
  readonly inputMappingContexts: readonly ConfigurableInputMappingContextDefinition[];
  readonly devicePrompts: InputDevicePromptConfigDefinition;
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


import type { InputDeviceKind, InputMappingContextDefinition } from '../core/types';
import {
  createBrowserInputBindingStorage,
  type InputBindingStorage,
} from './InputBindingStorage';
import { inferInputDeviceKind } from './InputSchemeParser';
import type {
  ConfigurableInputMappingContextDefinition,
  ConfigurableInputMappingDefinition,
  InputBindingsChangedEvent,
  InputBindingChangeReason,
  InputDevicePromptDefinition,
  InputRebindOptions,
  InputSchemeDefinition,
  StoredInputBindingOverrides,
} from './InputSchemeTypes';

export interface InputSchemeRuntimeOptions {
  /** undefined 使用浏览器 localStorage；null 明确关闭持久化。 */
  readonly storage?: InputBindingStorage | null;
  readonly loadPersisted?: boolean;
}

type BindingChangeListener = (event: InputBindingsChangedEvent) => void;

interface MappingLocation {
  readonly contextIndex: number;
  readonly mappingIndex: number;
  readonly mapping: ConfigurableInputMappingDefinition;
}

/**
 * JSON 输入方案的可变运行时层。
 * Action、标签关系保持不可变，仅允许按稳定 Mapping id 重绑定 control。
 */
export class InputSchemeRuntime {
  public readonly id: string;
  public readonly actions: InputSchemeDefinition['inputActions'];
  public readonly config: InputSchemeDefinition['inputConfig'];
  public readonly virtualControls: InputSchemeDefinition['virtualControls'];

  private readonly defaults = new Map<string, string>();
  private readonly promptDefinitions: readonly InputDevicePromptDefinition[];
  private readonly controlLabels: Readonly<Record<string, string>>;
  private readonly storage?: InputBindingStorage;
  private readonly listeners = new Set<BindingChangeListener>();
  private mutableContexts: ConfigurableInputMappingContextDefinition[];

  public constructor(
    definition: InputSchemeDefinition,
    options: InputSchemeRuntimeOptions = {},
  ) {
    this.id = definition.id;
    this.actions = definition.inputActions;
    this.config = definition.inputConfig;
    this.virtualControls = definition.virtualControls;
    this.promptDefinitions = definition.devicePrompts.prompts;
    this.controlLabels = definition.devicePrompts.controlLabels;
    this.mutableContexts = cloneContexts(definition.inputMappingContexts);
    this.storage = options.storage === undefined
      ? createBrowserInputBindingStorage()
      : options.storage ?? undefined;

    for (const context of definition.inputMappingContexts) {
      for (const mapping of context.mappings) this.defaults.set(mapping.id, mapping.control);
    }
    if (options.loadPersisted !== false) this.restorePersistedBindings();
  }

  public get contexts(): readonly InputMappingContextDefinition[] {
    return this.mutableContexts;
  }

  public get configurableContexts(): readonly ConfigurableInputMappingContextDefinition[] {
    return this.mutableContexts;
  }

  public onBindingsChanged(listener: BindingChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getMapping(mappingId: string): ConfigurableInputMappingDefinition {
    return this.findMapping(mappingId).mapping;
  }

  public getMappingsForAction(
    actionId: string,
    deviceKind?: InputDeviceKind,
  ): readonly ConfigurableInputMappingDefinition[] {
    return this.mutableContexts.flatMap((context) => context.mappings.filter((mapping) => (
      mapping.actionId === actionId && (!deviceKind || mapping.deviceKind === deviceKind)
    )));
  }

  public getPreventDefaultControls(): readonly string[] {
    return [...new Set(this.mutableContexts.flatMap((context) => context.mappings
      .filter((mapping) => mapping.deviceKind === 'keyboardMouse' && mapping.control.startsWith('Keyboard.'))
      .map((mapping) => mapping.control)))];
  }

  public rebind(mappingId: string, nextControl: string, options: InputRebindOptions = {}): void {
    const control = this.validateRebindControl(mappingId, nextControl);
    const target = this.findMapping(mappingId);
    if (target.mapping.control === control) return;

    const updates = new Map<string, string>([[mappingId, control]]);
    const conflict = this.mutableContexts[target.contextIndex].mappings.find((mapping) => (
      mapping.id !== mappingId
      && mapping.deviceKind === target.mapping.deviceKind
      && mapping.control === control
    ));
    const policy = options.conflict ?? 'swap';
    if (conflict && policy === 'reject') {
      throw new Error(`${control} 已绑定到 ${conflict.id}`);
    }
    if (conflict && policy === 'swap') updates.set(conflict.id, target.mapping.control);

    this.applyControls(updates);
    this.persistBindings();
    this.emit('rebind', [...updates.keys()]);
  }

  public resetBinding(mappingId: string): void {
    const defaultControl = this.defaults.get(mappingId);
    if (!defaultControl) throw new Error(`不存在 InputMapping：${mappingId}`);
    const target = this.findMapping(mappingId);
    if (target.mapping.control === defaultControl) return;

    const updates = new Map<string, string>([[mappingId, defaultControl]]);
    const conflict = this.mutableContexts[target.contextIndex].mappings.find((mapping) => (
      mapping.id !== mappingId
      && mapping.deviceKind === target.mapping.deviceKind
      && mapping.control === defaultControl
    ));
    if (conflict) updates.set(conflict.id, target.mapping.control);
    this.applyControls(updates);
    this.persistBindings();
    this.emit('reset', [...updates.keys()]);
  }

  public resetAllBindings(): void {
    const updates = new Map(this.defaults);
    const changed = [...updates].filter(([mappingId, control]) => (
      this.findMapping(mappingId).mapping.control !== control
    )).map(([mappingId]) => mappingId);
    if (!changed.length) return;
    this.applyControls(updates);
    this.storage?.clear(this.id);
    this.emit('resetAll', changed);
  }

  public getPrompt(mode: string, deviceKind: InputDeviceKind, state?: string): string {
    const prompt = this.findPrompt(mode, deviceKind, state)
      ?? (deviceKind === 'keyboardMouse' ? undefined : this.findPrompt(mode, 'keyboardMouse', state));
    if (!prompt) return '';
    if (prompt.text) return prompt.text;

    return (prompt.entries ?? []).map((entry) => {
      const bindings = [
        ...(entry.text ? [entry.text] : []),
        ...(entry.mappingIds ?? []).map((mappingId) => (
          this.getControlLabel(this.getMapping(mappingId).control)
        )),
      ];
      const uniqueBindings = [...new Set(bindings)];
      const bindingText = uniqueBindings.join(entry.joinWith ?? '/');
      return entry.label ? `${bindingText} · ${entry.label}` : bindingText;
    }).filter(Boolean).join(prompt.separator ?? '　');
  }

  public getControlLabel(control: string): string {
    return this.controlLabels[control] ?? humanizeControl(control);
  }

  private restorePersistedBindings(): void {
    const stored = this.storage?.load(this.id);
    if (!stored) return;
    const updates = new Map<string, string>();
    for (const [mappingId, control] of Object.entries(stored.bindings)) {
      try {
        updates.set(mappingId, this.validateRebindControl(mappingId, control));
      } catch {
        // 单条损坏的本地覆盖不应导致整份默认输入方案失效。
      }
    }
    if (!updates.size) return;
    this.applyControls(updates);
    this.emit('restore', [...updates.keys()]);
  }

  private validateRebindControl(mappingId: string, nextControl: string): string {
    const control = nextControl.trim();
    if (!control) throw new TypeError('重绑定 control 不能为空');
    const mapping = this.findMapping(mappingId).mapping;
    const deviceKind = inferInputDeviceKind(control);
    if (!deviceKind) throw new TypeError(`无法识别 control 的设备类型：${control}`);
    if (deviceKind !== mapping.deviceKind) {
      throw new TypeError(`${mappingId} 是 ${mapping.deviceKind} 槽位，不能绑定 ${deviceKind} control`);
    }
    return control;
  }

  private findMapping(mappingId: string): MappingLocation {
    for (let contextIndex = 0; contextIndex < this.mutableContexts.length; contextIndex += 1) {
      const context = this.mutableContexts[contextIndex];
      const mappingIndex = context.mappings.findIndex((mapping) => mapping.id === mappingId);
      if (mappingIndex >= 0) {
        return { contextIndex, mappingIndex, mapping: context.mappings[mappingIndex] };
      }
    }
    throw new Error(`不存在 InputMapping：${mappingId}`);
  }

  private applyControls(updates: ReadonlyMap<string, string>): void {
    this.mutableContexts = this.mutableContexts.map((context) => ({
      ...context,
      mappings: context.mappings.map((mapping) => {
        const control = updates.get(mapping.id);
        return control === undefined ? mapping : { ...mapping, control };
      }),
    }));
  }

  private persistBindings(): void {
    if (!this.storage) return;
    const bindings = Object.fromEntries(this.mutableContexts.flatMap((context) => (
      context.mappings
        .filter((mapping) => this.defaults.get(mapping.id) !== mapping.control)
        .map((mapping) => [mapping.id, mapping.control])
    )));
    if (!Object.keys(bindings).length) {
      this.storage.clear(this.id);
      return;
    }
    const value: StoredInputBindingOverrides = {
      schemaVersion: 1,
      schemeId: this.id,
      bindings,
    };
    this.storage.save(value);
  }

  private findPrompt(
    mode: string,
    deviceKind: InputDeviceKind,
    state?: string,
  ): InputDevicePromptDefinition | undefined {
    return this.promptDefinitions.find((prompt) => (
      prompt.mode === mode && prompt.deviceKind === deviceKind && prompt.state === state
    )) ?? this.promptDefinitions.find((prompt) => (
      prompt.mode === mode && prompt.deviceKind === deviceKind && prompt.state === undefined
    ));
  }

  private emit(reason: InputBindingChangeReason, mappingIds: readonly string[]): void {
    const event: InputBindingsChangedEvent = { reason, mappingIds };
    for (const listener of [...this.listeners]) listener(event);
  }
}

function cloneContexts(
  contexts: readonly ConfigurableInputMappingContextDefinition[],
): ConfigurableInputMappingContextDefinition[] {
  return contexts.map((context) => ({
    ...context,
    mappings: context.mappings.map((mapping) => ({
      ...mapping,
      axis2D: mapping.axis2D ? { ...mapping.axis2D } : undefined,
      scale: mapping.scale ? { ...mapping.scale } : undefined,
      modifiers: mapping.modifiers?.map((modifier) => ({ ...modifier })),
    })),
  }));
}

function humanizeControl(control: string): string {
  const [, value = control] = control.split('.', 2);
  if (control.startsWith('Keyboard.Key')) return value.slice(3);
  if (control.startsWith('Keyboard.Digit')) return value.slice(5);
  if (control.startsWith('Keyboard.Arrow')) {
    return ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' })[value] ?? value;
  }
  if (control.startsWith('Keyboard.')) {
    return value.replace('Left', ' L').replace('Right', ' R').trim();
  }
  if (control.startsWith('Mouse.Button')) return `鼠标 ${value.replace('Button', '')}`;
  return value.replace(/([a-z])([A-Z])/g, '$1 $2');
}

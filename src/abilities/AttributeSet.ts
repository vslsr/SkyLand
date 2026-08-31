import type {
  AttributeCalculationBackend,
  AttributeCalculationInput,
  AttributeDefinition,
  AttributeId,
  AttributeSnapshot,
  ModifierOperation,
  ResolvedModifier,
} from './definitions';

const ATTRIBUTE_ID_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

interface AttributeState {
  readonly definition: AttributeDefinition;
  baseValue: number;
  currentValue: number;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} 必须是有限数字`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function applyOperation(value: number, operation: ModifierOperation, magnitude: number): number {
  switch (operation) {
    case 'add': return value + magnitude;
    case 'multiply': return value * magnitude;
    case 'override': return magnitude;
  }
}

export class JavascriptAttributeBackend implements AttributeCalculationBackend {
  public calculate(inputs: readonly AttributeCalculationInput[]): ReadonlyMap<AttributeId, number> {
    const output = new Map<AttributeId, number>();
    for (const input of inputs) {
      let value = input.baseValue;
      const modifiers = [...input.modifiers].sort((left, right) => (
        left.priority - right.priority || left.order - right.order
      ));
      for (const modifier of modifiers) {
        value = applyOperation(value, modifier.operation, modifier.magnitude);
      }
      output.set(input.attributeId, clamp(value, input.minimum, input.maximum));
    }
    return output;
  }
}

export interface AttributeSetOptions {
  readonly backend?: AttributeCalculationBackend;
  readonly onChanged?: (
    attributeId: AttributeId,
    previousValue: number,
    currentValue: number,
  ) => void;
}

/** 保存属性的 BaseValue/CurrentValue，并集中处理边界和 Modifier 聚合。 */
export class AttributeSet {
  private readonly states = new Map<AttributeId, AttributeState>();
  private readonly backend: AttributeCalculationBackend;
  private readonly onChanged?: AttributeSetOptions['onChanged'];

  public constructor(
    definitions: readonly AttributeDefinition[] = [],
    options: AttributeSetOptions = {},
  ) {
    this.backend = options.backend ?? new JavascriptAttributeBackend();
    this.onChanged = options.onChanged;
    for (const definition of definitions) this.define(definition);
  }

  public define(definition: AttributeDefinition): void {
    if (!ATTRIBUTE_ID_PATTERN.test(definition.id)) {
      throw new TypeError(`属性 id 格式无效：${definition.id}`);
    }
    if (this.states.has(definition.id)) throw new Error(`属性重复定义：${definition.id}`);
    assertFinite(definition.initialValue, `属性 ${definition.id} 的 initialValue`);
    const minimum = definition.minimum ?? Number.NEGATIVE_INFINITY;
    const maximum = definition.maximum ?? Number.POSITIVE_INFINITY;
    if (minimum > maximum) throw new RangeError(`属性 ${definition.id} 的 minimum 不能大于 maximum`);
    const initialValue = clamp(definition.initialValue, minimum, maximum);
    this.states.set(definition.id, {
      definition: { ...definition, initialValue },
      baseValue: initialValue,
      currentValue: initialValue,
    });
  }

  public has(attributeId: AttributeId): boolean {
    return this.states.has(attributeId);
  }

  public getBaseValue(attributeId: AttributeId): number {
    return this.requireState(attributeId).baseValue;
  }

  public getCurrentValue(attributeId: AttributeId): number {
    return this.requireState(attributeId).currentValue;
  }

  public setBaseValue(attributeId: AttributeId, value: number): void {
    assertFinite(value, `属性 ${attributeId} 的 BaseValue`);
    const state = this.requireState(attributeId);
    const minimum = state.definition.minimum ?? Number.NEGATIVE_INFINITY;
    const maximum = state.definition.maximum ?? Number.POSITIVE_INFINITY;
    state.baseValue = clamp(value, minimum, maximum);
  }

  public modifyBaseValue(
    attributeId: AttributeId,
    operation: ModifierOperation,
    magnitude: number,
  ): void {
    assertFinite(magnitude, `属性 ${attributeId} 的 Modifier magnitude`);
    const state = this.requireState(attributeId);
    this.setBaseValue(attributeId, applyOperation(state.baseValue, operation, magnitude));
  }

  public recalculate(modifiers: readonly ResolvedModifier[]): void {
    const grouped = new Map<AttributeId, ResolvedModifier[]>();
    for (const modifier of modifiers) {
      this.requireState(modifier.attributeId);
      const bucket = grouped.get(modifier.attributeId) ?? [];
      bucket.push(modifier);
      grouped.set(modifier.attributeId, bucket);
    }
    const inputs: AttributeCalculationInput[] = [];
    for (const [attributeId, state] of this.states) {
      inputs.push({
        attributeId,
        baseValue: state.baseValue,
        minimum: state.definition.minimum ?? Number.NEGATIVE_INFINITY,
        maximum: state.definition.maximum ?? Number.POSITIVE_INFINITY,
        modifiers: grouped.get(attributeId) ?? [],
      });
    }
    const values = this.backend.calculate(inputs);
    for (const [attributeId, state] of this.states) {
      const calculatedValue = values.get(attributeId);
      if (calculatedValue === undefined) throw new Error(`属性计算后端遗漏结果：${attributeId}`);
      assertFinite(calculatedValue, `属性 ${attributeId} 的计算结果`);
      const nextValue = clamp(
        calculatedValue,
        state.definition.minimum ?? Number.NEGATIVE_INFINITY,
        state.definition.maximum ?? Number.POSITIVE_INFINITY,
      );
      if (Object.is(nextValue, state.currentValue)) continue;
      const previousValue = state.currentValue;
      state.currentValue = nextValue;
      this.onChanged?.(attributeId, previousValue, nextValue);
    }
  }

  public createSnapshot(): readonly AttributeSnapshot[] {
    return [...this.states].map(([id, state]) => ({
      id,
      baseValue: state.baseValue,
      currentValue: state.currentValue,
    }));
  }

  private requireState(attributeId: AttributeId): AttributeState {
    const state = this.states.get(attributeId);
    if (!state) throw new Error(`未知属性：${attributeId}`);
    return state;
  }
}

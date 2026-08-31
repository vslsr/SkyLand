import type { Axis2DInputModifier, Axis2DValue } from './types';

const AXIS_EPSILON = 1e-8;

/** 按声明顺序应用 axis2D Modifier。 */
export function applyAxis2DModifiers(
  value: Axis2DValue,
  modifiers: readonly Axis2DInputModifier[] = [],
): Axis2DValue {
  let result = { x: value.x, y: value.y };
  for (const modifier of modifiers) {
    if (modifier.type === 'deadZone') {
      result = applyRadialDeadZone(result, modifier.minimum, modifier.maximum ?? 1);
    } else if (modifier.type === 'scale') {
      result = { x: result.x * modifier.x, y: result.y * modifier.y };
    } else if (modifier.type === 'negate') {
      const axes = modifier.axes ?? 'xy';
      result = {
        x: axes.includes('x') ? -result.x : result.x,
        y: axes.includes('y') ? -result.y : result.y,
      };
    } else if (modifier.type === 'normalize') {
      const length = Math.hypot(result.x, result.y);
      if (length > AXIS_EPSILON) result = { x: result.x / length, y: result.y / length };
    } else if (modifier.order === 'yx') {
      result = { x: result.y, y: result.x };
    }
  }
  return result;
}

export function validateAxis2DModifier(modifier: Axis2DInputModifier, label: string): void {
  if (modifier.type === 'deadZone') {
    const maximum = modifier.maximum ?? 1;
    if (
      !Number.isFinite(modifier.minimum)
      || !Number.isFinite(maximum)
      || modifier.minimum < 0
      || maximum > 1
      || maximum <= modifier.minimum
    ) {
      throw new RangeError(`${label} 的 DeadZone 必须满足 0 <= minimum < maximum <= 1`);
    }
  } else if (
    modifier.type === 'scale'
    && (!Number.isFinite(modifier.x) || !Number.isFinite(modifier.y))
  ) {
    throw new TypeError(`${label} 的 Scale 必须使用有限数值`);
  }
}

function applyRadialDeadZone(
  value: Axis2DValue,
  minimum: number,
  maximum: number,
): Axis2DValue {
  const length = Math.hypot(value.x, value.y);
  if (length <= minimum || length <= AXIS_EPSILON) return { x: 0, y: 0 };
  const normalizedLength = Math.min(1, (length - minimum) / (maximum - minimum));
  return {
    x: (value.x / length) * normalizedLength,
    y: (value.y / length) * normalizedLength,
  };
}

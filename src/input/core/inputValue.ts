import type { Axis2DValue, InputActionDefinition, InputValue } from './types';

export function isAxis2DValue(value: InputValue): value is Axis2DValue {
  return typeof value !== 'boolean';
}

export function cloneInputValue(value: InputValue): InputValue {
  return typeof value === 'boolean' ? value : { x: value.x, y: value.y };
}

export function inputValuesEqual(left: InputValue, right: InputValue): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  return left.x === right.x && left.y === right.y;
}

export function zeroInputValue(action: InputActionDefinition): InputValue {
  return action.valueType === 'digital' ? false : { x: 0, y: 0 };
}

export function inputValueIsActive(value: InputValue, deadZone = 0): boolean {
  return typeof value === 'boolean' ? value : Math.hypot(value.x, value.y) > deadZone;
}

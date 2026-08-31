import type { Axis2DValue } from '../core/types';

export interface VirtualJoystickSample {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly value: Axis2DValue;
}

export interface VirtualJoystickCenterBounds {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
}

/** 限制摇杆基座完整落在激活区域中；区域过小时退化到区域中心。 */
export function clampVirtualJoystickCenter(
  x: number,
  y: number,
  bounds: VirtualJoystickCenterBounds,
): { readonly x: number; readonly y: number } {
  const marginX = Math.min(Math.max(0, bounds.margin), Math.max(0, bounds.width / 2));
  const marginY = Math.min(Math.max(0, bounds.margin), Math.max(0, bounds.height / 2));
  return {
    x: clamp(x, marginX, Math.max(marginX, bounds.width - marginX)),
    y: clamp(y, marginY, Math.max(marginY, bounds.height - marginY)),
  };
}

/**
 * 将屏幕坐标差转换成 axis2D：先限制视觉行程，再径向移除死区并应用灵敏度。
 * y 轴在此处翻转，使屏幕向上拖动对应游戏输入正 y。
 */
export function sampleVirtualJoystick(
  deltaX: number,
  deltaY: number,
  travelRadius: number,
  deadZone: number,
  sensitivity: number,
): VirtualJoystickSample {
  const safeRadius = Math.max(1, travelRadius);
  const distance = Math.hypot(deltaX, deltaY);
  const visualScale = distance > safeRadius ? safeRadius / distance : 1;
  const offsetX = deltaX * visualScale;
  const offsetY = deltaY * visualScale;
  const normalizedLength = Math.min(1, Math.hypot(offsetX, offsetY) / safeRadius);
  if (normalizedLength <= deadZone || normalizedLength <= Number.EPSILON) {
    return { offsetX, offsetY, value: { x: 0, y: 0 } };
  }

  const remappedLength = Math.min(
    1,
    ((normalizedLength - deadZone) / Math.max(Number.EPSILON, 1 - deadZone)) * sensitivity,
  );
  const inverseLength = 1 / Math.hypot(offsetX, offsetY);
  const x = offsetX * inverseLength * remappedLength;
  const y = -offsetY * inverseLength * remappedLength;
  return {
    offsetX,
    offsetY,
    value: {
      x: Object.is(x, -0) ? 0 : x,
      y: Object.is(y, -0) ? 0 : y,
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

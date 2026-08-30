import type { Mat4 } from '../math/mat4';
import type { Vec3 } from '../math/vec3';
import {
  calculateCameraAxes,
  createCameraViewMatrix,
  localDirectionToWorld,
  type CameraAxes,
} from './cameraMath';

const EPSILON = 0.000_01;

function transformDirection(matrix: Mat4, direction: Vec3): Vec3 {
  return [
    matrix[0] * direction[0] + matrix[4] * direction[1] + matrix[8] * direction[2],
    matrix[1] * direction[0] + matrix[5] * direction[1] + matrix[9] * direction[2],
    matrix[2] * direction[0] + matrix[6] * direction[1] + matrix[10] * direction[2],
  ];
}

function assertNear(actual: Vec3, expected: Vec3, label: string): void {
  const error = Math.hypot(
    actual[0] - expected[0],
    actual[1] - expected[1],
    actual[2] - expected[2],
  );
  if (error > EPSILON) {
    throw new Error(`${label} 坐标不一致: ${actual.join(', ')}`);
  }
}

export function assertCameraInvariant(axes: CameraAxes, viewMatrix: Mat4): void {
  const worldW = localDirectionToWorld(axes, [0, 0, 1]);
  const worldS = localDirectionToWorld(axes, [0, 0, -1]);

  assertNear(worldW, axes.forward, 'W 与相机 forward');
  assertNear(worldS, [-axes.forward[0], -axes.forward[1], -axes.forward[2]], 'S 与相机 backward');
  assertNear(transformDirection(viewMatrix, worldW), [0, 0, -1], 'W 在相机视图中的方向');
  assertNear(transformDirection(viewMatrix, axes.right), [1, 0, 0], '相机 right');
  assertNear(transformDirection(viewMatrix, axes.up), [0, 1, 0], '相机 up');
}

export function runCameraMathSelfTest(): void {
  const orientations: Array<[number, number]> = [
    [0, 0],
    [0.7, 0.35],
    [-1.2, -0.5],
    [2.4, 1.1],
  ];

  for (const [yaw, pitch] of orientations) {
    const axes = calculateCameraAxes(yaw, pitch);
    const viewMatrix = createCameraViewMatrix([2, 3, 4], axes);
    assertCameraInvariant(axes, viewMatrix);
  }
}

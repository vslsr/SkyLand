import type { Mat4 } from '../math/mat4';
import type { Vec3 } from '../math/vec3';

export interface CameraAxes {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

// Local direction components are [right, up, forward].
export type LocalDirection = Vec3;

export function calculateCameraAxes(yaw: number, pitch: number): CameraAxes {
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);

  return {
    right: [cosYaw, 0, sinYaw],
    up: [-sinYaw * sinPitch, cosPitch, cosYaw * sinPitch],
    forward: [sinYaw * cosPitch, sinPitch, -cosYaw * cosPitch],
  };
}

export function localDirectionToWorld(axes: CameraAxes, local: LocalDirection): Vec3 {
  return [
    axes.right[0] * local[0] + axes.up[0] * local[1] + axes.forward[0] * local[2],
    axes.right[1] * local[0] + axes.up[1] * local[1] + axes.forward[1] * local[2],
    axes.right[2] * local[0] + axes.up[2] * local[1] + axes.forward[2] * local[2],
  ];
}

export function createCameraViewMatrix(position: Vec3, axes: CameraAxes): Mat4 {
  const { right, up, forward } = axes;
  return new Float32Array([
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    -(right[0] * position[0] + right[1] * position[1] + right[2] * position[2]),
    -(up[0] * position[0] + up[1] * position[1] + up[2] * position[2]),
    forward[0] * position[0] + forward[1] * position[1] + forward[2] * position[2],
    1,
  ]);
}

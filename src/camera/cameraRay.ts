import type { RenderCamera } from '../render/RenderCameraBuffer';

/** 视口的投影参数。构造射线只要这两个，不需要一个相机对象。 */
export interface CameraRayViewport {
  readonly fovRadians: number;
  readonly aspect: number;
}

export interface WorldRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * 屏幕上的一个点（NDC）→ 世界射线。
 *
 * 相机基由 forward 与 up 现算：`right = forward × up`，再把 up 正交化回去，
 * 这样即使传进来的 up 不严格垂直也不会歪。NDC 到视锥方向的比例就是
 * `tan(fov / 2)`——透视投影的定义。
 *
 * 不要一个 `THREE.Camera`：机位那段字节主线程本来就有（是它写的），视场角是常量，
 * 宽高比来自画布元素。指针反投影因此不需要跨线程回读渲染世界。
 */
export function computeCameraRay(
  camera: RenderCamera,
  viewport: CameraRayViewport,
  ndcX: number,
  ndcY: number,
): WorldRay | undefined {
  const [fx, fy, fz] = camera.forward;
  const forwardLength = Math.hypot(fx, fy, fz);
  if (forwardLength < 1e-6) return undefined;
  const nfx = fx / forwardLength;
  const nfy = fy / forwardLength;
  const nfz = fz / forwardLength;

  const [ux, uy, uz] = camera.up;
  // right = forward × up
  let rx = nfy * uz - nfz * uy;
  let ry = nfz * ux - nfx * uz;
  let rz = nfx * uy - nfy * ux;
  const rightLength = Math.hypot(rx, ry, rz);
  if (rightLength < 1e-6) return undefined;
  rx /= rightLength;
  ry /= rightLength;
  rz /= rightLength;
  // up = right × forward，保证三轴正交。
  const cux = ry * nfz - rz * nfy;
  const cuy = rz * nfx - rx * nfz;
  const cuz = rx * nfy - ry * nfx;

  const tangent = Math.tan(viewport.fovRadians * 0.5);
  const scaleX = ndcX * tangent * viewport.aspect;
  const scaleY = ndcY * tangent;
  const dirX = nfx + rx * scaleX + cux * scaleY;
  const dirY = nfy + ry * scaleX + cuy * scaleY;
  const dirZ = nfz + rz * scaleX + cuz * scaleY;
  const length = Math.hypot(dirX, dirY, dirZ);
  if (length < 1e-6) return undefined;
  return {
    origin: [camera.position[0], camera.position[1], camera.position[2]],
    direction: [dirX / length, dirY / length, dirZ / length],
  };
}

/** 射线与水平面 y = planeY 的交点。朝上或与平面平行时没有交点。 */
export function intersectRayWithHorizontalPlane(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  planeY: number,
): { x: number; y: number; z: number } | undefined {
  if (Math.abs(direction[1]) < 1e-6) return undefined;
  const distance = (planeY - origin[1]) / direction[1];
  if (distance <= 0) return undefined;
  return {
    x: origin[0] + direction[0] * distance,
    y: planeY,
    z: origin[2] + direction[2] * distance,
  };
}

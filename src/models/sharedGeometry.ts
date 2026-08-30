import type * as THREE from 'three';

/**
 * 共用几何登记表。
 *
 * 草叶、树冠层这类反复出现的形状只需要一份几何，多个物体共用同一个
 * `BufferGeometry`；轮廓线也是同理。共用的代价是所有权变得含糊：
 * 任何单个物体 dispose 掉它，其他还在用的物体就会一起失效。
 * 这里把「共用」显式登记下来，释放资源的一方据此跳过。
 */
const sharedGeometries = new WeakSet<THREE.BufferGeometry>();

export function markSharedGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
  sharedGeometries.add(geometry);
  return geometry;
}

export function isSharedGeometry(geometry: THREE.BufferGeometry): boolean {
  return sharedGeometries.has(geometry);
}

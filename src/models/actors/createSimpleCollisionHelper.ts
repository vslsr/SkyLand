import * as THREE from 'three';
import type { ActorSimpleCollision } from './ActorVisualModel';

/** 开发环境下显示 Actor 本地简易碰撞盒；挂在权威 root 下会自动跟随位置与 yaw。 */
export function createSimpleCollisionHelper(
  collision: ActorSimpleCollision,
): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const minimumX = collision.centerX - collision.halfWidth;
  const maximumX = collision.centerX + collision.halfWidth;
  const minimumZ = collision.centerZ - collision.halfLength;
  const maximumZ = collision.centerZ + collision.halfLength;
  const minimumY = collision.minimumY;
  const maximumY = collision.maximumY;
  const corners = [
    [minimumX, minimumY, minimumZ], [maximumX, minimumY, minimumZ],
    [maximumX, minimumY, maximumZ], [minimumX, minimumY, maximumZ],
    [minimumX, maximumY, minimumZ], [maximumX, maximumY, minimumZ],
    [maximumX, maximumY, maximumZ], [minimumX, maximumY, maximumZ],
  ] as const;
  const edgeIndices = [
    0, 1, 1, 2, 2, 3, 3, 0,
    4, 5, 5, 6, 6, 7, 7, 4,
    0, 4, 1, 5, 2, 6, 3, 7,
  ] as const;
  const positions = edgeIndices.flatMap((index) => [...corners[index]]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const helper = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0xd44f72,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
      depthWrite: false,
    }),
  );
  helper.name = 'actor-simple-collision-helper';
  helper.frustumCulled = false;
  helper.renderOrder = 10_000;
  return helper;
}


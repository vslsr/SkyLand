import * as THREE from 'three';

export interface LineArtLeafGeometry {
  fill: THREE.BufferGeometry;
  outline: THREE.BufferGeometry;
}

/**
 * 低面数纸片叶：填充面和 EdgesGeometry 轮廓分开，供实例化的双 pass 渲染复用。
 */
export function createLineArtLeafGeometry(): LineArtLeafGeometry {
  const fill = new THREE.BufferGeometry();
  const boundary: ReadonlyArray<readonly [number, number, number]> = [
    [0, -0.58, -0.015],
    [-0.08, -0.3, 0],
    [-0.38, -0.08, 0],
    [-0.18, 0.04, 0],
    [-0.28, 0.28, -0.005],
    [0, 0.58, -0.015],
    [0.28, 0.28, -0.005],
    [0.18, 0.04, 0],
    [0.38, -0.08, 0],
    [0.08, -0.3, 0],
  ];
  const positions = [0, 0, 0.045];
  for (const point of boundary) positions.push(...point);
  const indices: number[] = [];
  for (let index = 0; index < boundary.length; index += 1) {
    indices.push(0, index + 1, ((index + 1) % boundary.length) + 1);
  }
  fill.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  fill.setIndex(indices);
  fill.computeVertexNormals();
  const outline = new THREE.EdgesGeometry(fill, 35);
  return { fill, outline };
}

export const LINE_ART_LEAF_GEOMETRY_STATS = {
  vertexCount: 11,
  triangleCount: 10,
} as const;

import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import { createOceanMaterials } from '../../materials/oceanMaterials';
import type { OceanVisualDefinition } from '../../scenes/data/SceneDefinition';
import { sampleOceanFaceTint } from './oceanFaceting';

export interface OceanModel {
  readonly root: THREE.Group;
  readonly animatedMaterials: readonly THREE.ShaderMaterial[];
}

/**
 * 参考 drift-main：水面转为非索引三角面，并给同一三角形的三个顶点设置相同色调。
 * 动画完全留给 Shader；这里的静态网格只负责低多边形拓扑和线稿轮廓。
 */
function createFacetedSurfaceGeometry(
  baseGeometry: THREE.PlaneGeometry,
  definition: OceanVisualDefinition,
): THREE.BufferGeometry {
  const geometry = baseGeometry.toNonIndexed();
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const primary = new THREE.Color(definition.surfaceColor);
  const secondary = new THREE.Color(definition.secondaryColor);
  const tint = new THREE.Color();

  for (let face = 0; face < position.count; face += 3) {
    const x = position.getX(face);
    const z = position.getZ(face);
    sampleOceanFaceTint(primary, secondary, x, z, face, tint);
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = (face + vertex) * 3;
      colors[offset] = tint.r;
      colors[offset + 1] = tint.g;
      colors[offset + 2] = tint.b;
    }
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function createOceanModel(
  definition: OceanVisualDefinition,
  seaLevel: number,
  environment: FillMaterialEnvironment,
): OceanModel {
  const materials = createOceanMaterials(definition, seaLevel, environment);
  const root = new THREE.Group();
  root.name = 'line-art-ocean';

  const baseGeometry = new THREE.PlaneGeometry(
    definition.size,
    definition.size,
    definition.segments,
    definition.segments,
  );
  baseGeometry.rotateX(-Math.PI / 2);

  // 面与线框从同一份索引网格生成，保证 Shader 位移后边线仍贴合三角面。
  const gridGeometry = new THREE.WireframeGeometry(baseGeometry);
  const surfaceGeometry = createFacetedSurfaceGeometry(baseGeometry, definition);
  baseGeometry.dispose();

  const surface = new THREE.Mesh(surfaceGeometry, materials.surface);
  surface.name = 'ocean-surface';
  // 负数把水面排在不透明列表的最前面：固定场景的地面用默认的 0，所以水面之下的
  // 地面片元由 early-z 丢掉，而不是先着色一遍再被覆盖（流式地形的同一条约束写在
  // `TerrainChunkView` 的 TERRAIN_RENDER_ORDER 上）。
  surface.renderOrder = -2;
  root.add(surface);

  const grid = new THREE.LineSegments(gridGeometry, materials.grid);
  grid.name = 'ocean-low-poly-grid';
  grid.renderOrder = -1;
  root.add(grid);

  return {
    root,
    animatedMaterials: [materials.surface, materials.grid],
  };
}

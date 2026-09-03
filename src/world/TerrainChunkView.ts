import * as THREE from 'three';
import type { OceanMaterials } from '../materials/oceanMaterials';
import {
  createTerrainChunkGeometry,
  type TerrainChunkGeometry,
} from '../models/terrain/createTerrainChunkGeometry';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';

export interface TerrainChunkViewOptions {
  worldSeed: number;
  chunkX: number;
  chunkZ: number;
  groundColor: THREE.ColorRepresentation;
  groundFillMaterial: THREE.Material;
  groundGridMaterial: THREE.Material;
  showGround: boolean;
  waterMaterials?: OceanMaterials;
  waterShoreMaterial?: THREE.Material;
  waterSplashMaterial?: THREE.Material;
  oceanDefinition?: OceanVisualDefinition;
  seaLevel?: number;
  cellCodeAt?: (globalCellX: number, globalCellZ: number) => number;
}

/**
 * 地形的绘制顺序。
 *
 * 不透明与半透明是两份独立的列表：three 先画完所有不透明，再画半透明，所以下面
 * 这些数只在各自那一列里比较。
 *
 * **水面必须排在海床前面。** 不透明这一列里 `renderOrder` 压过深度排序
 * （r128 `painterSortStable`：groupOrder → renderOrder → program → material → z），
 * 海床先画就意味着水面之下的每个像素都要完整跑一遍海床的片元着色器——云影的
 * 两层噪声加散射雾——然后立刻被水面覆盖。反过来先写下水面的深度，被淹掉的海床
 * 在 early-z 阶段整片丢掉。两者都不透明且都不 discard，顺序不影响成像，只影响
 * 水域地图的片元开销。
 */
const TERRAIN_RENDER_ORDER = {
  waterSurface: -5,
  groundFill: -4,
  /** 以下都是半透明材质，次序只在半透明列表内部生效。 */
  groundGrid: -3,
  waterGrid: -1,
  waterShore: 0,
  waterSplash: 1,
} as const;

/** 一个 chunk 独占的地形 GPU 资源；共享材质仍由 ChunkStreamer 持有。 */
export class TerrainChunkView {
  public readonly root = new THREE.Group();
  private readonly geometry: TerrainChunkGeometry;

  public constructor(options: TerrainChunkViewOptions) {
    this.root.name = `terrain-chunk-${options.chunkX}:${options.chunkZ}`;
    this.geometry = createTerrainChunkGeometry(options);

    if (options.showGround) {
      const ground = new THREE.Mesh(this.geometry.groundFill, options.groundFillMaterial);
      ground.name = 'terrain-ground';
      ground.renderOrder = TERRAIN_RENDER_ORDER.groundFill;
      const grid = new THREE.LineSegments(this.geometry.groundGrid, options.groundGridMaterial);
      grid.name = 'terrain-grid';
      grid.renderOrder = TERRAIN_RENDER_ORDER.groundGrid;
      this.root.add(ground, grid);
    }

    if (
      options.waterMaterials
      && this.geometry.waterSurface
      && this.geometry.waterGrid
    ) {
      const surface = new THREE.Mesh(
        this.geometry.waterSurface,
        options.waterMaterials.surface,
      );
      surface.name = 'terrain-water-surface';
      surface.renderOrder = TERRAIN_RENDER_ORDER.waterSurface;
      const grid = new THREE.LineSegments(
        this.geometry.waterGrid,
        options.waterMaterials.grid,
      );
      grid.name = 'terrain-water-grid';
      grid.renderOrder = TERRAIN_RENDER_ORDER.waterGrid;
      this.root.add(surface, grid);

      if (options.waterShoreMaterial && this.geometry.waterShore) {
        const shore = new THREE.Mesh(
          this.geometry.waterShore,
          options.waterShoreMaterial,
        );
        shore.name = 'terrain-water-shore';
        shore.renderOrder = TERRAIN_RENDER_ORDER.waterShore;
        this.root.add(shore);
      }
      if (options.waterSplashMaterial && this.geometry.waterSplash) {
        const splash = new THREE.Points(
          this.geometry.waterSplash,
          options.waterSplashMaterial,
        );
        splash.name = 'terrain-water-splash';
        splash.renderOrder = TERRAIN_RENDER_ORDER.waterSplash;
        this.root.add(splash);
      }
    }
  }

  public dispose(): void {
    this.root.parent?.remove(this.root);
    this.root.clear();
    this.geometry.groundFill.dispose();
    this.geometry.groundGrid.dispose();
    this.geometry.waterSurface?.dispose();
    this.geometry.waterGrid?.dispose();
    this.geometry.waterShore?.dispose();
    this.geometry.waterSplash?.dispose();
  }
}

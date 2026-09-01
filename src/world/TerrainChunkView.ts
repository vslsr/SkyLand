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
      ground.renderOrder = -4;
      const grid = new THREE.LineSegments(this.geometry.groundGrid, options.groundGridMaterial);
      grid.name = 'terrain-grid';
      grid.renderOrder = -3;
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
      surface.renderOrder = -2;
      const grid = new THREE.LineSegments(
        this.geometry.waterGrid,
        options.waterMaterials.grid,
      );
      grid.name = 'terrain-water-grid';
      grid.renderOrder = -1;
      this.root.add(surface, grid);

      if (options.waterShoreMaterial && this.geometry.waterShore) {
        const shore = new THREE.Mesh(
          this.geometry.waterShore,
          options.waterShoreMaterial,
        );
        shore.name = 'terrain-water-shore';
        shore.renderOrder = 0;
        this.root.add(shore);
      }
      if (options.waterSplashMaterial && this.geometry.waterSplash) {
        const splash = new THREE.Points(
          this.geometry.waterSplash,
          options.waterSplashMaterial,
        );
        splash.name = 'terrain-water-splash';
        splash.renderOrder = 1;
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

import * as THREE from 'three';
import type { ChunkGeometryData } from '../../shared/world/chunkGenerator.mjs';
import type { OceanMaterials } from '../materials/oceanMaterials';
import { createChunkFillGeometry, createChunkOutlineGeometry } from '../models/chunkMesh';
import type { OceanVisualDefinition } from '../scenes/data/SceneDefinition';
import { TerrainChunkView } from './TerrainChunkView';

export interface ChunkViewMaterials {
  fill: THREE.Material;
  outline: THREE.Material;
  grid: THREE.Material;
  water?: OceanMaterials;
  waterShore?: THREE.Material;
  waterSplash?: THREE.Material;
}

export interface ChunkTerrainOptions {
  worldSeed: number;
  groundColor: THREE.ColorRepresentation;
  showGround: boolean;
  oceanDefinition?: OceanVisualDefinition;
  seaLevel?: number;
  cellCodeAt?: (globalCellX: number, globalCellZ: number) => number;
}

/**
 * 一个已经建好的 chunk。
 *
 * 固定三次 draw call：合批后的填充、合批后的轮廓线，以及同场景全部 chunk
 * 共用的地面网格线。填充与轮廓的顶点已经是世界坐标，所以承载它们的对象留在
 * 原点，只有网格线需要按 chunk 中心偏移。
 */
export class ChunkView {
  public readonly key: string;
  public readonly root = new THREE.Group();
  /** 这个 chunk 的整数放置记录，碰撞、拾取一类逻辑之后可以直接读它。 */
  public readonly props: Int32Array;
  public readonly propCount: number;

  private readonly fillGeometry: THREE.BufferGeometry;
  private readonly outlineGeometry: THREE.BufferGeometry;
  private terrain: TerrainChunkView;
  private readonly chunkX: number;
  private readonly chunkZ: number;
  private readonly materials: ChunkViewMaterials;
  private readonly terrainOptions: ChunkTerrainOptions;

  public constructor(
    key: string,
    chunkX: number,
    chunkZ: number,
    data: ChunkGeometryData,
    materials: ChunkViewMaterials,
    terrainOptions: ChunkTerrainOptions,
  ) {
    this.key = key;
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    this.materials = materials;
    this.terrainOptions = terrainOptions;
    this.props = data.props;
    this.propCount = data.propCount;
    this.root.name = `chunk-${key}`;

    this.fillGeometry = createChunkFillGeometry(data);
    this.outlineGeometry = createChunkOutlineGeometry(data);
    this.root.add(new THREE.Mesh(this.fillGeometry, materials.fill));
    this.root.add(new THREE.LineSegments(this.outlineGeometry, materials.outline));

    this.terrain = this.createTerrain();
    this.root.add(this.terrain.root);
  }

  /** 地形 patch 只替换本 chunk 的地形资源，不重建物件、草或 Actor 身份。 */
  public rebuildTerrain(): void {
    this.terrain.dispose();
    this.terrain = this.createTerrain();
    this.root.add(this.terrain.root);
  }

  /**
   * 释放这个 chunk 独占的显存。
   * 材质与网格线几何体由 ChunkStreamer 按场景持有，卸载单个 chunk 时不能动它们。
   */
  public dispose(): void {
    this.root.parent?.remove(this.root);
    this.root.clear();
    this.fillGeometry.dispose();
    this.outlineGeometry.dispose();
    this.terrain.dispose();
  }

  private createTerrain(): TerrainChunkView {
    return new TerrainChunkView({
      ...this.terrainOptions,
      chunkX: this.chunkX,
      chunkZ: this.chunkZ,
      groundFillMaterial: this.materials.fill,
      groundGridMaterial: this.materials.grid,
      waterMaterials: this.materials.water,
      waterShoreMaterial: this.materials.waterShore,
      waterSplashMaterial: this.materials.waterSplash,
    });
  }
}

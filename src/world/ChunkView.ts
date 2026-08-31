import * as THREE from 'three';
import type { ChunkGeometryData } from '../../shared/world/chunkGenerator.mjs';
import { chunkCenter } from '../../shared/world/chunkKey.mjs';
import {
  CHUNK_FILL_MATERIAL,
  CHUNK_OUTLINE_MATERIAL,
  createChunkFillGeometry,
  createChunkOutlineGeometry,
} from '../models/chunkMesh';
import { CHUNK_GRID_MATERIAL, getChunkGridGeometry } from '../models/ground';

/**
 * 一个已经建好的 chunk。
 *
 * 固定三次 draw call：合批后的填充、合批后的轮廓线，以及所有 chunk 共用的
 * 地面网格线。填充与轮廓的顶点已经是世界坐标，所以承载它们的对象留在原点，
 * 只有网格线需要按 chunk 中心偏移。
 */
export class ChunkView {
  public readonly key: string;
  public readonly root = new THREE.Group();
  /** 这个 chunk 的整数放置记录，碰撞、拾取一类逻辑之后可以直接读它。 */
  public readonly props: Int32Array;
  public readonly propCount: number;

  private readonly fillGeometry: THREE.BufferGeometry;
  private readonly outlineGeometry: THREE.BufferGeometry;

  public constructor(key: string, chunkX: number, chunkZ: number, data: ChunkGeometryData) {
    this.key = key;
    this.props = data.props;
    this.propCount = data.propCount;
    this.root.name = `chunk-${key}`;

    this.fillGeometry = createChunkFillGeometry(data);
    this.outlineGeometry = createChunkOutlineGeometry(data);
    this.root.add(new THREE.Mesh(this.fillGeometry, CHUNK_FILL_MATERIAL));
    this.root.add(new THREE.LineSegments(this.outlineGeometry, CHUNK_OUTLINE_MATERIAL));

    const grid = new THREE.LineSegments(getChunkGridGeometry(), CHUNK_GRID_MATERIAL);
    grid.position.set(chunkCenter(chunkX), 0, chunkCenter(chunkZ));
    this.root.add(grid);
  }

  /**
   * 释放这个 chunk 独占的显存。
   * 材质与网格线几何体是全局共用的，卸载单个 chunk 时不能动它们。
   */
  public dispose(): void {
    this.root.parent?.remove(this.root);
    this.root.clear();
    this.fillGeometry.dispose();
    this.outlineGeometry.dispose();
  }
}

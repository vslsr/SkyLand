import * as THREE from 'three';
import { createRollingGrassFieldGeometry, type GrassFieldGeometry } from '../models/grass';
import type { SceneUpdateContext } from '../scene/SceneVisualSystem';
import {
  GRASS_ROLLING_FILL_VERTEX_SHADER,
  GRASS_ROLLING_OUTLINE_VERTEX_SHADER,
} from '../shaders/grass';
import type { GrassBendFieldView, GrassLayout, GrassLayoutShaders } from './GrassLayout';
import { alignFieldOriginCell, cellToWorld } from './rollingGrassField';

/**
 * 单个格子的边长（米）。每格至多一株草，所以它直接决定密度上限：
 * 0.32 米对应约 9.8 格/㎡，配上密度噪声后近处约 7 株/㎡，
 * 与固定场景的观感接近。格子越小草越密，实例总数按平方增长。
 */
const DEFAULT_CELL_SIZE = 0.32;

/**
 * 每个轴向的格数。乘上格边长就是视野跨度（80 米），半径正好等于草的消隐
 * 距离：草在视野边缘之前刚好淡完，玩家看不见方形边界，也不会有一圈
 * 注定退化、白跑顶点着色器的实例。
 */
const DEFAULT_GRID_SIZE = 250;

/** 这个距离以内保持满密度（米）。 */
const DEFAULT_FULL_DENSITY_RADIUS = 20;

/**
 * 到这个距离草被稀释干净（米）。
 * 取在雾效远端（52 米）之内、视野半径（43 米）之外的位置：
 * 淡出过程被雾遮掉大半，边界也就看不出来。
 */
const DEFAULT_FADE_END_RADIUS = 40;

/** 滚动视野的形变场分辨率。视野比固定场景大得多，分辨率也要跟上。 */
const DEFAULT_BEND_TEXTURE_SIZE = 512;

export interface RollingGrassLayoutOptions {
  cellSize?: number;
  gridSize?: number;
  fullDensityRadius?: number;
  fadeEndRadius?: number;
  bendTextureSize?: number;
}

/**
 * 跟着焦点滚动的草地布局，供大世界使用。
 *
 * 固定布局把每株草的世界坐标烘进实例属性，草叶总数因此正比于活动区面积，
 * 摊到几百米见方的世界上就只能稀疏到看不见。这里换一个思路：实例只是一张
 * 覆盖焦点周围固定范围的网格，每格代表一小块地，草的位置与形态由那块地的
 * 世界格坐标哈希导出。
 *
 * 于是实例缓冲一次上传后永不更新，每帧只改视野原点一个 uniform；而原点始终
 * 对齐到格边长的整数倍，保证同一块地算出的世界格恒定，草长在原地不会漂移。
 */
export class RollingGrassLayout implements GrassLayout {
  public readonly geometry: GrassFieldGeometry;
  public readonly shaders: GrassLayoutShaders = {
    fillVertex: GRASS_ROLLING_FILL_VERTEX_SHADER,
    outlineVertex: GRASS_ROLLING_OUTLINE_VERTEX_SHADER,
  };
  public readonly bendField: GrassBendFieldView;
  public readonly uniforms: Record<string, THREE.IUniform>;

  private readonly cellSize: number;
  private readonly span: number;
  private readonly originCell: THREE.Vector2;

  public constructor(options: RollingGrassLayoutOptions = {}) {
    this.cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
    const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
    this.span = this.cellSize * gridSize;

    this.geometry = createRollingGrassFieldGeometry(gridSize);
    this.bendField = {
      origin: new THREE.Vector2(),
      size: new THREE.Vector2(this.span, this.span),
      wrap: true,
      textureSize: options.bendTextureSize ?? DEFAULT_BEND_TEXTURE_SIZE,
    };
    this.originCell = new THREE.Vector2();
    this.uniforms = {
      uOriginCell: { value: this.originCell },
      uCellSize: { value: this.cellSize },
      uFullDensityRadius: { value: options.fullDensityRadius ?? DEFAULT_FULL_DENSITY_RADIUS },
      uFadeEndRadius: { value: options.fadeEndRadius ?? DEFAULT_FADE_END_RADIUS },
    };
  }

  public update(context?: SceneUpdateContext): void {
    if (!context) return;
    this.originCell.set(
      alignFieldOriginCell(context.focusX, this.span, this.cellSize),
      alignFieldOriginCell(context.focusZ, this.span, this.cellSize),
    );
    this.bendField.origin.set(
      cellToWorld(this.originCell.x, this.cellSize),
      cellToWorld(this.originCell.y, this.cellSize),
    );
  }

  public dispose(): void {
    this.geometry.fill.dispose();
    this.geometry.outline.dispose();
  }
}

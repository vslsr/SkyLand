import * as THREE from 'three';
import {
  createGrassFieldGeometry,
  type GrassFieldBounds,
  type GrassFieldGeometry,
} from '../models/grass';
import {
  GRASS_FIXED_FILL_VERTEX_SHADER,
  GRASS_FIXED_OUTLINE_VERTEX_SHADER,
} from '../shaders/grass';
import type { GrassBendFieldView, GrassLayout, GrassLayoutShaders } from './GrassLayout';

export interface FixedGrassLayoutOptions {
  bounds: GrassFieldBounds;
  bladeCount?: number;
  seed?: number;
}

/**
 * 一次性铺满整块活动区的草地布局。
 *
 * 每株草的世界坐标在构造时就算好并烘进实例属性，之后再也不变，
 * 形变场也就固定覆盖同一块区域。适合尺寸有限的场景；
 * 活动区大到一定程度后草叶总数会先撞上上限，那时需要的是滚动布局。
 */
export class FixedGrassLayout implements GrassLayout {
  public readonly geometry: GrassFieldGeometry;
  public readonly shaders: GrassLayoutShaders = {
    fillVertex: GRASS_FIXED_FILL_VERTEX_SHADER,
    outlineVertex: GRASS_FIXED_OUTLINE_VERTEX_SHADER,
  };
  public readonly uniforms: Record<string, THREE.IUniform> = {};
  public readonly bendField: GrassBendFieldView;

  public constructor(options: FixedGrassLayoutOptions) {
    const { bounds } = options;
    this.geometry = createGrassFieldGeometry({
      bounds,
      bladeCount: options.bladeCount,
      seed: options.seed,
    });
    this.bendField = {
      origin: new THREE.Vector2(bounds.minimumX, bounds.minimumZ),
      size: new THREE.Vector2(
        bounds.maximumX - bounds.minimumX,
        bounds.maximumZ - bounds.minimumZ,
      ),
      wrap: false,
      textureSize: 256,
    };
  }

  /** 固定视野不移动，形变场原点恒定。 */
  public update(): void {}

  public dispose(): void {
    this.geometry.fill.dispose();
    this.geometry.outline.dispose();
  }
}

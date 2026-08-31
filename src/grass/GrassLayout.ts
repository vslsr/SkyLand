import type * as THREE from 'three';
import type { GrassFieldGeometry } from '../models/grass';
import type { SceneUpdateContext } from '../scene/SceneVisualSystem';

/**
 * 踩踏形变场覆盖世界的哪一块。
 *
 * 固定视野的场景里这块区域恒定；跟随玩家的滚动视野会移动 `origin`，
 * 因此它是可变的向量，而不是构造时拍平的常量。
 */
export interface GrassBendFieldView {
  /** 形变场左下角的世界坐标。 */
  readonly origin: THREE.Vector2;
  /** 形变场覆盖的世界尺寸（米）。 */
  readonly size: THREE.Vector2;
  /**
   * 取样越界时的处理方式。
   *
   * `false` 是钳制到边界，适合覆盖整块活动区、草不会长到区外的固定视野。
   * `true` 是环形寻址，滚动视野必须用它：形变场不动、世界在其中回绕。
   */
  readonly wrap: boolean;
}

/**
 * 顶点着色器里「实例长在哪」的那一段。
 *
 * 不同布局的实例属性不同——固定布局把每株草的世界坐标烘在 `aOffset` 里，
 * 滚动布局只存网格下标、由着色器按玩家位置推算——所以着色器随布局走。
 */
export interface GrassLayoutShaders {
  readonly fillVertex: string;
  readonly outlineVertex: string;
}

/**
 * 草叶实例从哪来、长在哪。
 *
 * 把这件事从 GrassFieldSystem 里拆出来，是因为渲染与踩踏交互对所有场景
 * 都一样，真正随场景变的只有实例的分布方式：固定尺寸的场景一次性铺满活动区，
 * 大世界则需要一块跟着玩家滚动的实例网格。
 *
 * 布局的生命周期由 GrassFieldSystem 接管，创建之后不要在外部释放。
 */
export interface GrassLayout {
  readonly geometry: GrassFieldGeometry;
  readonly shaders: GrassLayoutShaders;
  readonly bendField: GrassBendFieldView;
  /** 每帧调用。滚动布局据此移动形变场原点；固定布局什么都不做。 */
  update(context?: SceneUpdateContext): void;
  dispose(): void;
}

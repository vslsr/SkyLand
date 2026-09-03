import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import {
  createGrassFieldGeometry,
  type GrassFieldBounds,
} from '../models/grass';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import type {
  GrassGradientOverrides,
  GrassHeightVariationSettings,
  GrassWindSettings,
} from './GrassAppearance';
import { GrassBendField } from './GrassBendField';
import { GrassInteractionQueue, type GrassInteractionTarget } from './GrassInteraction';
import { GrassMaterials } from './createGrassMaterials';
import { GrassTrailRecorder } from './GrassTrailRecorder';

export interface GrassFieldSystemOptions {
  bounds: GrassFieldBounds;
  color: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
  gradient?: GrassGradientOverrides;
  wind?: Partial<GrassWindSettings>;
  heightVariation?: Partial<GrassHeightVariationSettings>;
}

/**
 * 固定尺寸场景的草地：整块活动区一次铺满，弯曲窗口就是场景边界。
 *
 * 与流式世界的 `StreamingGrassSystem` 共用同一份材质工厂与足迹路径记录，
 * 两条路的观感和交互手感因此一致；差别只在几何体从哪来、窗口要不要滑动。
 */
export class GrassFieldSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly interaction: GrassInteractionTarget;

  private readonly interactionQueue = new GrassInteractionQueue();
  private readonly trails = new GrassTrailRecorder();
  private readonly bendField: GrassBendField;
  private readonly materials: GrassMaterials;
  private readonly fieldBounds: THREE.Vector4;
  private readonly fillGeometry: THREE.InstancedBufferGeometry;
  private readonly outlineGeometry: THREE.InstancedBufferGeometry;
  private pendingDeltaSeconds = 0;

  public constructor(options: GrassFieldSystemOptions) {
    this.root.name = 'grass-field-system';
    this.interaction = this.interactionQueue;
    this.fieldBounds = new THREE.Vector4(
      options.bounds.minimumX,
      options.bounds.minimumZ,
      options.bounds.maximumX,
      options.bounds.maximumZ,
    );
    this.bendField = new GrassBendField(options.bounds);
    this.materials = new GrassMaterials({
      color: options.color,
      environment: options.environment,
      bendTexture: this.bendField.texture,
      fieldBounds: this.fieldBounds,
      gradient: options.gradient,
      wind: options.wind,
      heightVariation: options.heightVariation,
    });

    const field = createGrassFieldGeometry({ bounds: options.bounds });
    this.fillGeometry = field.fill;
    this.outlineGeometry = field.outline;
    const fill = new THREE.Mesh(field.fill, this.materials.fill);
    const outline = new THREE.LineSegments(field.outline, this.materials.outline);
    fill.frustumCulled = false;
    outline.frustumCulled = false;
    fill.renderOrder = 0;
    outline.renderOrder = 1;
    this.root.add(fill, outline);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    if (context) this.trails.setFocus(context.focusX, context.focusZ);
    this.pendingDeltaSeconds += deltaSeconds;
    this.materials.setTime(elapsedSeconds);
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    // 鼠标压草在 renderer 的 beforeRender 监听里写入，排在这一步之前，
    // 所以在这里收口才能让同一帧的输入当帧生效。
    this.trails.ingest(this.interactionQueue.drain());
    this.trails.advance(this.pendingDeltaSeconds);
    this.pendingDeltaSeconds = 0;
    this.bendField.render(renderer, this.trails);
  }

  public dispose(): void {
    this.interactionQueue.clear();
    this.trails.clear();
    this.bendField.dispose();
    this.materials.dispose();
    this.fillGeometry.dispose();
    this.outlineGeometry.dispose();
  }
}

import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import { GRASS_FILL_FRAGMENT_SHADER, GRASS_OUTLINE_FRAGMENT_SHADER } from '../shaders/grass';
import { GrassBendField } from './GrassBendField';
import { GrassInteractionQueue, type GrassInteractionTarget } from './GrassInteraction';
import type { GrassLayout } from './GrassLayout';

export interface GrassFieldSystemOptions {
  /** 实例的分布方式。系统接管它的生命周期。 */
  layout: GrassLayout;
  color: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
}

export class GrassFieldSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly interaction: GrassInteractionTarget;
  private readonly interactionQueue = new GrassInteractionQueue();
  private readonly layout: GrassLayout;
  private readonly bendField: GrassBendField;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private pendingDeltaSeconds = 0;

  public constructor(options: GrassFieldSystemOptions) {
    this.root.name = 'grass-field-system';
    this.interaction = this.interactionQueue;
    this.layout = options.layout;
    this.bendField = new GrassBendField(this.layout.bendField);
    const field = this.layout.geometry;
    this.sharedUniforms = {
      uTime: { value: 0 },
      uBendTexture: { value: this.bendField.texture },
      // 与布局共享同一个原点向量：滚动布局移动它，草叶取样自动跟上。
      uFieldOrigin: { value: this.layout.bendField.origin },
      uFieldSize: { value: this.layout.bendField.size },
      uFieldWrap: { value: this.layout.bendField.wrap ? 1 : 0 },
      uFogColor: { value: new THREE.Color(options.environment.fogColor) },
      uFogNear: { value: options.environment.fogNear },
      uFogFar: { value: options.environment.fogFar },
    };

    const fillMaterial = new THREE.ShaderMaterial({
      vertexShader: this.layout.shaders.fillVertex,
      fragmentShader: GRASS_FILL_FRAGMENT_SHADER,
      uniforms: {
        ...this.sharedUniforms,
        uFillColor: { value: new THREE.Color(options.color) },
      },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const outlineMaterial = new THREE.ShaderMaterial({
      vertexShader: this.layout.shaders.outlineVertex,
      fragmentShader: GRASS_OUTLINE_FRAGMENT_SHADER,
      uniforms: {
        ...this.sharedUniforms,
        uLineColor: { value: new THREE.Color(0x171614) },
      },
      depthWrite: false,
    });

    const fill = new THREE.Mesh(field.fill, fillMaterial);
    const outline = new THREE.LineSegments(field.outline, outlineMaterial);
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
    this.pendingDeltaSeconds += deltaSeconds;
    this.sharedUniforms.uTime.value = elapsedSeconds;
    this.layout.update(context);
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    const impulses = this.interactionQueue.drain();
    if (impulses.length === 0) {
      this.bendField.step(renderer, this.pendingDeltaSeconds);
    } else {
      this.bendField.step(renderer, this.pendingDeltaSeconds, impulses[0]);
      for (let index = 1; index < impulses.length; index += 1) {
        this.bendField.step(renderer, 0, impulses[index]);
      }
    }
    this.pendingDeltaSeconds = 0;
    this.sharedUniforms.uBendTexture.value = this.bendField.texture;
  }

  public dispose(): void {
    this.interactionQueue.clear();
    this.bendField.dispose();
    this.layout.dispose();
  }
}

import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import {
  createGrassFieldGeometry,
  type GrassFieldBounds,
} from '../models/grass';
import type { SceneVisualSystem } from '../scene/SceneVisualSystem';
import {
  GRASS_FILL_FRAGMENT_SHADER,
  GRASS_FILL_VERTEX_SHADER,
  GRASS_OUTLINE_FRAGMENT_SHADER,
  GRASS_OUTLINE_VERTEX_SHADER,
} from '../shaders/grass';
import { GrassBendField } from './GrassBendField';
import { GrassInteractionQueue, type GrassInteractionTarget } from './GrassInteraction';

export interface GrassFieldSystemOptions {
  bounds: GrassFieldBounds;
  color: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
}

export class GrassFieldSystem implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly interaction: GrassInteractionTarget;
  private readonly interactionQueue = new GrassInteractionQueue();
  private readonly bendField: GrassBendField;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private pendingDeltaSeconds = 0;

  public constructor(options: GrassFieldSystemOptions) {
    this.root.name = 'grass-field-system';
    this.interaction = this.interactionQueue;
    this.bendField = new GrassBendField(options.bounds);
    const field = createGrassFieldGeometry({ bounds: options.bounds });
    this.sharedUniforms = {
      uTime: { value: 0 },
      uBendTexture: { value: this.bendField.texture },
      uFieldBounds: {
        value: new THREE.Vector4(
          options.bounds.minimumX,
          options.bounds.minimumZ,
          options.bounds.maximumX,
          options.bounds.maximumZ,
        ),
      },
      uFogColor: { value: new THREE.Color(options.environment.fogColor) },
      uFogNear: { value: options.environment.fogNear },
      uFogFar: { value: options.environment.fogFar },
    };

    const fillMaterial = new THREE.ShaderMaterial({
      vertexShader: GRASS_FILL_VERTEX_SHADER,
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
      vertexShader: GRASS_OUTLINE_VERTEX_SHADER,
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

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.pendingDeltaSeconds += deltaSeconds;
    this.sharedUniforms.uTime.value = elapsedSeconds;
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
  }
}

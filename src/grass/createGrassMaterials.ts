import * as THREE from 'three';
import {
  createEnvironmentUniforms,
  type FillMaterialEnvironment,
} from '../materials/createFillMaterial';
import {
  GRASS_FILL_FRAGMENT_SHADER,
  GRASS_FILL_VERTEX_SHADER,
  GRASS_OUTLINE_FRAGMENT_SHADER,
  GRASS_OUTLINE_VERTEX_SHADER,
} from '../shaders/grass';
import {
  createGrassGradient,
  DEFAULT_GRASS_HEIGHT_VARIATION,
  DEFAULT_GRASS_WIND,
  GRASS_DRY_PATCH_STRENGTH,
  type GrassGradientOverrides,
  type GrassHeightVariationSettings,
  type GrassWindSettings,
} from './GrassAppearance';
import {
  acquireGrassNoiseTexture,
  releaseGrassNoiseTexture,
} from './GrassNoiseTexture';

/** 草叶开始变矮变简的距离，以及完全进入远景 LOD 的距离。 */
export const GRASS_LOD_NEAR_DISTANCE = 10;
export const GRASS_LOD_FAR_DISTANCE = 28;

const DEFAULT_OUTLINE_COLOR = 0x171614;

export interface GrassMaterialOptions {
  color: THREE.ColorRepresentation;
  environment: FillMaterialEnvironment;
  bendTexture: THREE.Texture;
  /** 弯曲窗口的世界范围。传入的对象会被材质持有，移动窗口时就地改写即可。 */
  fieldBounds: THREE.Vector4;
  gradient?: GrassGradientOverrides;
  wind?: Partial<GrassWindSettings>;
  heightVariation?: Partial<GrassHeightVariationSettings>;
  outlineColor?: THREE.ColorRepresentation;
}

/**
 * 草叶的填充与轮廓材质。
 *
 * 抽成工厂而不是让两套草地系统各写一遍：固定场景的 `GrassFieldSystem` 与流式
 * 世界的 `StreamingGrassSystem` 必须长得一模一样，参数在两处各调一遍迟早跑偏。
 */
export class GrassMaterials {
  public readonly uniforms: Record<string, THREE.IUniform>;
  public readonly fill: THREE.ShaderMaterial;
  public readonly outline: THREE.ShaderMaterial;

  private readonly noiseTexture: THREE.DataTexture;

  public constructor(options: GrassMaterialOptions) {
    const wind: GrassWindSettings = { ...DEFAULT_GRASS_WIND, ...options.wind };
    const heightVariation: GrassHeightVariationSettings = {
      ...DEFAULT_GRASS_HEIGHT_VARIATION,
      ...options.heightVariation,
    };
    const gradient = createGrassGradient(options.color, options.gradient);
    this.noiseTexture = acquireGrassNoiseTexture();

    this.uniforms = {
      ...createEnvironmentUniforms(options.environment),
      uTime: { value: 0 },
      uBendTexture: { value: options.bendTexture },
      uNoiseTexture: { value: this.noiseTexture },
      uFieldBounds: { value: options.fieldBounds },
      uWindNoise: {
        value: new THREE.Vector4(
          wind.gustScale,
          wind.gustSpeed,
          wind.flutterScale,
          wind.flutterSpeed,
        ),
      },
      uWindSway: {
        value: new THREE.Vector3(wind.baseSway, wind.gustSway, wind.flutterSway),
      },
      uHeightVariation: {
        value: new THREE.Vector4(
          heightVariation.clumpScale,
          heightVariation.clumpAmount,
          heightVariation.bladeAmount,
          heightVariation.curveAmount,
        ),
      },
      uGrassLodNear: { value: GRASS_LOD_NEAR_DISTANCE },
      uGrassLodFar: { value: GRASS_LOD_FAR_DISTANCE },
    };

    this.fill = new THREE.ShaderMaterial({
      vertexShader: GRASS_FILL_VERTEX_SHADER,
      fragmentShader: GRASS_FILL_FRAGMENT_SHADER,
      uniforms: {
        ...this.uniforms,
        uGrassRootColor: { value: gradient.root },
        uGrassTipColor: { value: gradient.tip },
        uGrassDryColor: { value: gradient.dry },
        uDryPatchStrength: { value: GRASS_DRY_PATCH_STRENGTH },
      },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.outline = new THREE.ShaderMaterial({
      vertexShader: GRASS_OUTLINE_VERTEX_SHADER,
      fragmentShader: GRASS_OUTLINE_FRAGMENT_SHADER,
      uniforms: {
        ...this.uniforms,
        uLineColor: {
          value: new THREE.Color(options.outlineColor ?? DEFAULT_OUTLINE_COLOR),
        },
      },
      // 墨线在叶根淡出，所以要参与混合；深度仍然测试，只是不写。
      transparent: true,
      depthWrite: false,
    });
  }

  public setTime(elapsedSeconds: number): void {
    this.uniforms.uTime.value = elapsedSeconds;
  }

  public dispose(): void {
    this.fill.dispose();
    this.outline.dispose();
    releaseGrassNoiseTexture(this.noiseTexture);
  }
}

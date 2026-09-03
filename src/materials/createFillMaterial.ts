import * as THREE from 'three';
import {
  ENVIRONMENT_LIGHTING_GLSL,
  ENVIRONMENT_UNIFORMS_GLSL,
} from '../shaders/environmentLighting';

export interface FillMaterialEnvironment {
  fogColor: THREE.ColorRepresentation;
  fogNear: number;
  fogFar: number;
  /**
   * 场景级共享 uniform。天气系统只改这一份状态，已创建和后续流式创建的
   * 填充材质、草地与海面会在同一帧得到一致的雾色和室外光照。
   */
  runtime?: SceneEnvironmentRuntime;
}

export interface SceneEnvironmentRuntime {
  readonly fogColor: THREE.IUniform<THREE.Color>;
  readonly fogNear: THREE.IUniform<number>;
  readonly fogFar: THREE.IUniform<number>;
  readonly ambientColor: THREE.IUniform<THREE.Color>;
  readonly daylight: THREE.IUniform<number>;
  readonly sunDirection: THREE.IUniform<THREE.Vector3>;
  /** 天顶方向的染色，已归一化到平均 1；只改色相不改亮度。 */
  readonly skyTint: THREE.IUniform<THREE.Color>;
  /** 地面反弹方向的染色，同样归一化到平均 1。 */
  readonly bounceTint: THREE.IUniform<THREE.Color>;
  /** 朝太阳方向看时雾被染成的颜色。 */
  readonly scatterColor: THREE.IUniform<THREE.Color>;
  /** 方向性散射的强度，0 表示雾恒为天空色。 */
  readonly scatterStrength: THREE.IUniform<number>;
  /** 云影的最深压暗比例，0 表示没有云影。 */
  readonly cloudShadowStrength: THREE.IUniform<number>;
  /** 云影噪声的滚动偏移，跟着风走。 */
  readonly cloudShadowOffset: THREE.IUniform<THREE.Vector2>;
  /** 墨线染色，已归一化到平均 1：夜里偏冷、黄昏偏暖，浓度不变。 */
  readonly inkTint: THREE.IUniform<THREE.Color>;
}

/** 默认主光方向：没有昼夜系统时的固定斜上方来光。 */
export const DEFAULT_SUN_DIRECTION = Object.freeze(
  new THREE.Vector3(-0.55, 0.9, 0.35).normalize(),
);

export function createSceneEnvironment(
  fogColor: THREE.ColorRepresentation,
  fogNear: number,
  fogFar: number,
): FillMaterialEnvironment {
  return {
    fogColor,
    fogNear,
    fogFar,
    runtime: {
      fogColor: { value: new THREE.Color(fogColor) },
      fogNear: { value: fogNear },
      fogFar: { value: fogFar },
      ambientColor: { value: new THREE.Color(0xffffff) },
      daylight: { value: 1 },
      sunDirection: { value: DEFAULT_SUN_DIRECTION.clone() },
      skyTint: { value: new THREE.Color(0xffffff) },
      bounceTint: { value: new THREE.Color(0xffffff) },
      scatterColor: { value: new THREE.Color(0xffffff) },
      scatterStrength: { value: 0 },
      cloudShadowStrength: { value: 0 },
      cloudShadowOffset: { value: new THREE.Vector2() },
      inkTint: { value: new THREE.Color(0xffffff) },
    },
  };
}

/**
 * 环境 uniform 的统一取值入口。
 *
 * 有 runtime 就直接共享同一批对象，天气与昼夜改一次、当帧全场生效；没有
 * runtime（单测、离线预览）时退化成中性白光与无雾无云影的常量。
 */
export function createEnvironmentUniforms(
  environment: FillMaterialEnvironment,
): Record<string, THREE.IUniform> {
  const runtime = environment.runtime;
  return {
    uAmbientColor: runtime?.ambientColor ?? { value: new THREE.Color(0xffffff) },
    uDaylight: runtime?.daylight ?? { value: 1 },
    uSunDirection: runtime?.sunDirection ?? { value: DEFAULT_SUN_DIRECTION.clone() },
    uSkyTint: runtime?.skyTint ?? { value: new THREE.Color(0xffffff) },
    uBounceTint: runtime?.bounceTint ?? { value: new THREE.Color(0xffffff) },
    uScatterColor: runtime?.scatterColor ?? { value: new THREE.Color(0xffffff) },
    uScatterStrength: runtime?.scatterStrength ?? { value: 0 },
    uCloudShadowStrength: runtime?.cloudShadowStrength ?? { value: 0 },
    uCloudShadowOffset: runtime?.cloudShadowOffset ?? { value: new THREE.Vector2() },
    uInkTint: runtime?.inkTint ?? { value: new THREE.Color(0xffffff) },
    uFogColor: runtime?.fogColor ?? { value: new THREE.Color(environment.fogColor) },
    uFogNear: runtime?.fogNear ?? { value: environment.fogNear },
    uFogFar: runtime?.fogFar ?? { value: environment.fogFar },
  };
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  #ifdef USE_VERTEX_TINT
    attribute vec3 tint;
    varying vec3 vTint;
  #endif

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);

    #ifdef USE_VERTEX_TINT
      vTint = tint;
    #endif

    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  uniform vec3 uColor;
  ${ENVIRONMENT_UNIFORMS_GLSL}

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  #ifdef USE_VERTEX_TINT
    varying vec3 vTint;
  #endif

  ${ENVIRONMENT_LIGHTING_GLSL}

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 lightDirection = normalize(uSunDirection);
    float diffuse = max(dot(normal, lightDirection), 0.0);
    // 太阳越低，直射项的对比越强：清晨与黄昏因此有明确的受光面和背光面，
    // 而不是只换一个整体色调。
    float grazing = 1.0 - clamp(lightDirection.y, 0.0, 1.0);
    float directional = (0.14 + uDaylight * 0.30) * (1.0 + grazing * 0.85);
    // 受光面与背光面拉开到近 1.7:1：物件因此有明确的体积，不再是一块与
    // 地面同值的色斑——朝上的地面几乎全在受光端，立着的树、石、菇则读得出侧面。
    float softLight = (0.68 - grazing * 0.06) + diffuse * directional;

    #ifdef USE_VERTEX_TINT
      vec3 baseColor = vTint;
    #else
      vec3 baseColor = uColor;
    #endif

    // 环境光按半球染色，再被飘过的云影压暗。
    vec3 ambient = uAmbientColor * hemisphereTint(normal)
      * cloudShadowAt(vWorldPosition.xz);
    vec3 shadedColor = baseColor * ambient * softLight
      + ambient * 0.025 * (normal.y * 0.5 + 0.5);

    vec3 finalColor = shadedColor;
    #ifdef USE_DISTANCE_FOG
      float cameraDistance = distance(cameraPosition, vWorldPosition);
      // 参考项目的主体填充不混入天气雾。只有流式世界会显式打开这里，
      // 并把雾压到最远 12 米内，既保住近中景颜色，也遮住 chunk 流送边缘。
      float clearFogNear = max(uFogNear, uFogFar - 12.0);
      float fogFactor = smoothstep(clearFogNear, uFogFar, cameraDistance);
      // 雾色仍走方向性散射：朝着太阳的那一侧被日光染暖。
      finalColor = mix(shadedColor, scatteredFogColor(vWorldPosition), fogFactor);
    #endif

    gl_FragColor = vec4(finalColor, 1.0);
    #include <encodings_fragment>
  }
`;

export interface FillMaterialOptions {
  /**
   * 从逐顶点的 tint 属性取色，而不是使用统一的 uColor。
   *
   * chunk 把地面、树、草、岩石合批成一份几何体，颜色只能随顶点走；
   * 否则每换一种颜色就要多一次 draw call，合批也就白做了。
   */
  vertexTint?: boolean;
  /**
   * 是否把场景距离雾混入填充色。参考项目的主体填充不参与 scene.fog，
   * 因此默认关闭；只有流式世界的合批物件需要显式打开来遮住 chunk 边缘。
   */
  fog?: boolean;
}

export function createFillMaterial(
  color: THREE.ColorRepresentation,
  environment: FillMaterialEnvironment = { fogColor: 0xfdfbf6, fogNear: 22, fogFar: 52 },
  options: FillMaterialOptions = {},
): THREE.ShaderMaterial {
  const defines: Record<string, string> = {};
  if (options.vertexTint) defines.USE_VERTEX_TINT = '';
  if (options.fog === true) defines.USE_DISTANCE_FOG = '';
  return new THREE.ShaderMaterial({
    defines,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      ...createEnvironmentUniforms(environment),
      uColor: { value: new THREE.Color(color) },
    },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

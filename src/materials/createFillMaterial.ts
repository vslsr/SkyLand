import * as THREE from 'three';

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
}

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
      sunDirection: {
        value: new THREE.Vector3(-0.55, 0.9, 0.35).normalize(),
      },
    },
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
  uniform vec3 uAmbientColor;
  uniform float uDaylight;
  uniform vec3 uSunDirection;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  #ifdef USE_VERTEX_TINT
    varying vec3 vTint;
  #endif

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float diffuse = max(dot(normal, normalize(uSunDirection)), 0.0);
    float softLight = 0.76 + diffuse * (0.10 + uDaylight * 0.18);
    float upwardFacing = normal.y * 0.5 + 0.5;

    #ifdef USE_VERTEX_TINT
      vec3 baseColor = vTint;
    #else
      vec3 baseColor = uColor;
    #endif

    vec3 shadedColor = baseColor * uAmbientColor * softLight
      + uAmbientColor * 0.025 * upwardFacing;

    vec3 finalColor = shadedColor;
    #ifdef USE_DISTANCE_FOG
      float cameraDistance = distance(cameraPosition, vWorldPosition);
      float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
      finalColor = mix(shadedColor, uFogColor, fogFactor);
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
   * 是否把场景距离雾混入填充色。地表按参考项目保持纸面本色，应传 false；
   * 普通物件默认仍参与远景雾化，用来遮住 chunk 流送边缘。
   */
  fog?: boolean;
}

export function createFillMaterial(
  color: THREE.ColorRepresentation,
  environment: FillMaterialEnvironment = { fogColor: 0xfdfbf6, fogNear: 22, fogFar: 52 },
  options: FillMaterialOptions = {},
): THREE.ShaderMaterial {
  const runtime = environment.runtime;
  const defines: Record<string, string> = {};
  if (options.vertexTint) defines.USE_VERTEX_TINT = '';
  if (options.fog !== false) defines.USE_DISTANCE_FOG = '';
  return new THREE.ShaderMaterial({
    defines,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uAmbientColor: runtime?.ambientColor ?? { value: new THREE.Color(0xffffff) },
      uDaylight: runtime?.daylight ?? { value: 1 },
      uSunDirection: runtime?.sunDirection ?? {
        value: new THREE.Vector3(-0.55, 0.9, 0.35).normalize(),
      },
      uFogColor: runtime?.fogColor ?? { value: new THREE.Color(environment.fogColor) },
      uFogNear: runtime?.fogNear ?? { value: environment.fogNear },
      uFogFar: runtime?.fogFar ?? { value: environment.fogFar },
    },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

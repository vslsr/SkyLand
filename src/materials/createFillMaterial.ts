import * as THREE from 'three';

export interface FillMaterialEnvironment {
  fogColor: THREE.ColorRepresentation;
  fogNear: number;
  fogFar: number;
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
    float softLight = 0.78 + diffuse * 0.22;
    float upwardFacing = normal.y * 0.5 + 0.5;

    #ifdef USE_VERTEX_TINT
      vec3 baseColor = vTint;
    #else
      vec3 baseColor = uColor;
    #endif

    vec3 shadedColor = baseColor * softLight + vec3(0.025) * upwardFacing;

    float cameraDistance = distance(cameraPosition, vWorldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    vec3 finalColor = mix(shadedColor, uFogColor, fogFactor);

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
}

export function createFillMaterial(
  color: THREE.ColorRepresentation,
  environment: FillMaterialEnvironment = { fogColor: 0xfdfbf6, fogNear: 22, fogFar: 52 },
  options: FillMaterialOptions = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: options.vertexTint ? { USE_VERTEX_TINT: '' } : {},
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSunDirection: { value: new THREE.Vector3(-0.55, 0.9, 0.35).normalize() },
      uFogColor: { value: new THREE.Color(environment.fogColor) },
      uFogNear: { value: environment.fogNear },
      uFogFar: { value: environment.fogFar },
    },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

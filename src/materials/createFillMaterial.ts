import * as THREE from 'three';

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
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

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float diffuse = max(dot(normal, normalize(uSunDirection)), 0.0);
    float softLight = 0.78 + diffuse * 0.22;
    float upwardFacing = normal.y * 0.5 + 0.5;
    vec3 shadedColor = uColor * softLight + vec3(0.025) * upwardFacing;

    float cameraDistance = distance(cameraPosition, vWorldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    vec3 finalColor = mix(shadedColor, uFogColor, fogFactor);

    gl_FragColor = vec4(finalColor, 1.0);
    #include <encodings_fragment>
  }
`;

export function createFillMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSunDirection: { value: new THREE.Vector3(-0.55, 0.9, 0.35).normalize() },
      uFogColor: { value: new THREE.Color(0xfdfbf6) },
      uFogNear: { value: 22 },
      uFogFar: { value: 52 },
    },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

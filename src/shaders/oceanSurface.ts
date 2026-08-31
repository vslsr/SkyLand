import { OCEAN_WAVE_TERMS } from '../ocean/oceanWaveMath';

function glslNumber(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

const waveExpression = OCEAN_WAVE_TERMS.map((term) => {
  const phase = [
    `point.x * ${glslNumber(term.xFrequency)}`,
    `point.y * ${glslNumber(term.zFrequency)}`,
    `time * ${glslNumber(term.timeFrequency)}`,
    `noiseWarp * ${glslNumber(term.noisePhase)}`,
  ].join(' + ');
  return `${term.functionName}(${phase}) * ${glslNumber(term.weight)}`;
}).join(' +\n      ');

export const OCEAN_SURFACE_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSeaLevel;
  uniform float uWaveHeight;
  uniform float uWaveSpeed;
  uniform float uNoiseScale;
  uniform float uNoiseStrength;
  uniform float uGridStep;
  uniform float uInterlaceStrength;

  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying float vWaveLight;

  float hashGrid(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float valueNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    vec2 smoothLocal = local * local * (3.0 - 2.0 * local);
    float nearValue = mix(hashGrid(cell), hashGrid(cell + vec2(1.0, 0.0)), smoothLocal.x);
    float farValue = mix(
      hashGrid(cell + vec2(0.0, 1.0)),
      hashGrid(cell + vec2(1.0, 1.0)),
      smoothLocal.x
    );
    return mix(nearValue, farValue, smoothLocal.y);
  }

  float oceanWaveHeight(vec2 point) {
    float time = uTime * uWaveSpeed;
    float primaryNoise = valueNoise(
      point * uNoiseScale + vec2(time * 0.035, -time * 0.028)
    );
    float crossingNoise = valueNoise(vec2(
      (point.x + point.y) * uNoiseScale * 1.7 - time * 0.021,
      (point.y - point.x) * uNoiseScale * 1.3 + time * 0.024
    ));
    float noiseWarp = ((primaryNoise * 0.62 + crossingNoise * 0.38) * 2.0 - 1.0)
      * uNoiseStrength;
    float directionalWave =
      ${waveExpression};
    float checker = cos(3.14159265 * (point.x + point.y) / uGridStep);
    float interlacedWave = checker * sin(time * 1.28 + 0.65);
    return mix(directionalWave, interlacedWave, uInterlaceStrength) * uWaveHeight;
  }

  void main() {
    vec3 transformed = position;
    float waveHeight = oceanWaveHeight(transformed.xz);
    transformed.y = uSeaLevel + waveHeight;

    vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    vColor = color;
    vWorldPosition = worldPosition.xyz;
    vWaveLight = uWaveHeight > 0.0001
      ? clamp(waveHeight / uWaveHeight * 0.5 + 0.5, 0.0, 1.0)
      : 0.5;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const OCEAN_GRID_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSeaLevel;
  uniform float uWaveHeight;
  uniform float uWaveSpeed;
  uniform float uNoiseScale;
  uniform float uNoiseStrength;
  uniform float uGridStep;
  uniform float uInterlaceStrength;

  varying vec3 vWorldPosition;

  float hashGrid(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float valueNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    vec2 smoothLocal = local * local * (3.0 - 2.0 * local);
    float nearValue = mix(hashGrid(cell), hashGrid(cell + vec2(1.0, 0.0)), smoothLocal.x);
    float farValue = mix(
      hashGrid(cell + vec2(0.0, 1.0)),
      hashGrid(cell + vec2(1.0, 1.0)),
      smoothLocal.x
    );
    return mix(nearValue, farValue, smoothLocal.y);
  }

  float oceanWaveHeight(vec2 point) {
    float time = uTime * uWaveSpeed;
    float primaryNoise = valueNoise(
      point * uNoiseScale + vec2(time * 0.035, -time * 0.028)
    );
    float crossingNoise = valueNoise(vec2(
      (point.x + point.y) * uNoiseScale * 1.7 - time * 0.021,
      (point.y - point.x) * uNoiseScale * 1.3 + time * 0.024
    ));
    float noiseWarp = ((primaryNoise * 0.62 + crossingNoise * 0.38) * 2.0 - 1.0)
      * uNoiseStrength;
    float directionalWave =
      ${waveExpression};
    float checker = cos(3.14159265 * (point.x + point.y) / uGridStep);
    float interlacedWave = checker * sin(time * 1.28 + 0.65);
    return mix(directionalWave, interlacedWave, uInterlaceStrength) * uWaveHeight;
  }

  void main() {
    vec3 transformed = position;
    transformed.y = uSeaLevel + oceanWaveHeight(transformed.xz) + 0.008;
    vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const OCEAN_GRID_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLineColor;
  uniform float uOpacity;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorldPosition;

  void main() {
    float cameraDistance = distance(cameraPosition, vWorldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    vec3 finalColor = mix(uLineColor, uFogColor, fogFactor);
    gl_FragColor = vec4(finalColor, uOpacity * (1.0 - fogFactor));
    #include <encodings_fragment>
  }
`;

export const OCEAN_SURFACE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vColor;
  varying vec3 vWorldPosition;
  varying float vWaveLight;

  void main() {
    float waveTone = mix(0.965, 1.035, vWaveLight);
    vec3 surfaceColor = vColor * waveTone;
    float cameraDistance = distance(cameraPosition, vWorldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    vec3 finalColor = mix(surfaceColor, uFogColor, fogFactor);

    gl_FragColor = vec4(finalColor, 1.0);
    #include <encodings_fragment>
  }
`;

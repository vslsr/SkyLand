export const WATER_SPLASH_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSeaLevel;

  attribute float aPhase;
  attribute float aScale;
  attribute vec2 aDirection;

  varying float vOpacity;

  void main() {
    float cycle = fract(uTime * (0.28 + aPhase * 0.09) + aPhase);
    float rise = sin(cycle * 3.14159265);
    vec3 transformed = position;
    transformed.xz += aDirection * (0.025 + cycle * 0.16) * aScale;
    transformed.y = uSeaLevel + 0.035 + rise * 0.22 * aScale;

    vec4 viewPosition = modelViewMatrix * vec4(transformed, 1.0);
    float perspectiveScale = clamp(4.6 / max(-viewPosition.z, 1.0), 0.45, 1.35);
    gl_PointSize = (3.4 + rise * 2.1) * aScale * perspectiveScale;
    gl_Position = projectionMatrix * viewPosition;

    float appear = smoothstep(0.0, 0.12, cycle);
    float disappear = 1.0 - smoothstep(0.58, 1.0, cycle);
    vOpacity = appear * disappear * (0.3 + rise * 0.42);
  }
`;

export const WATER_SPLASH_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;

  varying float vOpacity;

  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float distanceFromCenter = length(centered);
    if (distanceFromCenter > 0.5) discard;
    float softEdge = 1.0 - smoothstep(0.34, 0.5, distanceFromCenter);
    gl_FragColor = vec4(uColor, vOpacity * softEdge);
    #include <encodings_fragment>
  }
`;

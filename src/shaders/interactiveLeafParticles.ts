export const INTERACTIVE_LEAF_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aParticlePosition;
  attribute vec4 aParticleQuaternion;
  attribute float aParticleScale;
  attribute float aParticlePhase;
  attribute float aParticleTone;
  attribute float aParticleAirborne;

  uniform float uTime;

  varying float vParticleTone;
  varying float vFlutterLight;
  varying float vFogDepth;

  vec3 rotateByQuaternion(vec4 quaternion, vec3 value) {
    return value + 2.0 * cross(
      quaternion.xyz,
      cross(quaternion.xyz, value) + quaternion.w * value
    );
  }

  void main() {
    vec3 localPosition = position;
    float flutter = sin(uTime * 4.2 + aParticlePhase + localPosition.y * 3.4);
    localPosition.z += flutter
      * (0.035 + abs(localPosition.x) * 0.075)
      * aParticleAirborne;
    localPosition.x += sin(uTime * 2.3 + aParticlePhase * 1.7)
      * 0.018
      * aParticleAirborne
      * localPosition.y;
    localPosition *= aParticleScale;

    vec3 transformed = rotateByQuaternion(aParticleQuaternion, localPosition);
    vec4 modelPosition = modelMatrix * vec4(transformed + aParticlePosition, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    gl_Position = projectionMatrix * viewPosition;

    vParticleTone = aParticleTone;
    vFlutterLight = flutter * aParticleAirborne;
    vFogDepth = -viewPosition.z;
  }
`;

export const INTERACTIVE_LEAF_FILL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uFillColor;
  uniform vec3 uAccentColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vParticleTone;
  varying float vFlutterLight;
  varying float vFogDepth;

  void main() {
    float colorMix = clamp(vParticleTone * 0.5 + 0.5, 0.0, 1.0);
    vec3 color = mix(uFillColor, uAccentColor, colorMix);
    color *= 0.94 + vFlutterLight * 0.07;
    if (!gl_FrontFacing) color *= 0.72;
    float fogFactor = smoothstep(uFogNear, uFogFar, vFogDepth);
    gl_FragColor = vec4(mix(color, uFogColor, fogFactor), 1.0);
  }
`;

export const INTERACTIVE_LEAF_OUTLINE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLineColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vFogDepth;

  void main() {
    float fogFactor = smoothstep(uFogNear, uFogFar, vFogDepth);
    gl_FragColor = vec4(mix(uLineColor, uFogColor, fogFactor), 1.0);
  }
`;

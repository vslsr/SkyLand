import {
  CLOUD_SHADOW_GLSL,
  ENVIRONMENT_UNIFORMS_GLSL,
  HEMISPHERE_TINT_GLSL,
  SCATTERED_FOG_GLSL,
} from './environmentLighting';

export const INTERACTIVE_LEAF_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aParticlePosition;
  attribute vec4 aParticleQuaternion;
  attribute float aParticleScale;
  attribute float aParticlePhase;
  attribute float aParticleTone;
  attribute float aParticleAirborne;

  uniform float uTime;

  varying vec3 vWorldPosition;
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

    vWorldPosition = modelPosition.xyz;
    vParticleTone = aParticleTone;
    vFlutterLight = flutter * aParticleAirborne;
    vFogDepth = -viewPosition.z;
  }
`;

export const INTERACTIVE_LEAF_FILL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uFillColor;
  uniform vec3 uAccentColor;
  ${ENVIRONMENT_UNIFORMS_GLSL}

  varying vec3 vWorldPosition;
  varying float vParticleTone;
  varying float vFlutterLight;
  varying float vFogDepth;

  ${HEMISPHERE_TINT_GLSL}
  ${CLOUD_SHADOW_GLSL}
  ${SCATTERED_FOG_GLSL}

  void main() {
    float colorMix = clamp(vParticleTone * 0.5 + 0.5, 0.0, 1.0);
    vec3 color = mix(uFillColor, uAccentColor, colorMix);
    // 叶片和其它填充面一样吃场景共享光照，夜里不会留下一片自发光的暖色。
    // 叶面翻飞时朝向不定，半球染色按正面取天空色即可。
    color *= uAmbientColor * hemisphereTint(vec3(0.0, 1.0, 0.0))
      * cloudShadowAt(vWorldPosition.xz);
    color *= 0.94 + vFlutterLight * 0.07;
    if (!gl_FrontFacing) color *= 0.72;
    float fogFactor = smoothstep(uFogNear, uFogFar, vFogDepth);
    gl_FragColor = vec4(mix(color, scatteredFogColor(vWorldPosition), fogFactor), 1.0);
  }
`;

export const INTERACTIVE_LEAF_OUTLINE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLineColor;
  uniform vec3 uInkTint;
  ${ENVIRONMENT_UNIFORMS_GLSL}

  varying vec3 vWorldPosition;
  varying float vFogDepth;

  ${SCATTERED_FOG_GLSL}

  void main() {
    float fogFactor = smoothstep(uFogNear, uFogFar, vFogDepth);
    vec3 inkColor = uLineColor * uInkTint;
    gl_FragColor = vec4(mix(inkColor, scatteredFogColor(vWorldPosition), fogFactor), 1.0);
  }
`;

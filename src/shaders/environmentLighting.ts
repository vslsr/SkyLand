/**
 * 场景环境光照的共用 GLSL 片段。
 *
 * 填充材质、海面、草叶和交互粒子都从同一份 uniform 取值，所以天气与昼夜
 * 只要写一次共享状态，整帧的散射雾、半球染色和云影就是一致的。把这些函数
 * 集中在一处，也避免同一段数学在四个 shader 里各抄一遍、各自跑偏。
 */

/**
 * 光照相关的环境 uniform。
 *
 * 和雾分成两块声明，而不是一股脑写在一起：地表、地面网格和草叶按参考项目
 * 保持纸面本色、不参与距离雾，它们的着色器里就不该出现雾的 uniform。
 */
export const ENVIRONMENT_LIGHT_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3 uAmbientColor;
  uniform float uDaylight;
  uniform vec3 uSunDirection;
  uniform vec3 uSkyTint;
  uniform vec3 uBounceTint;
  uniform float uCloudShadowStrength;
  uniform vec2 uCloudShadowOffset;
`;

/** 距离雾与方向性散射的 uniform。 */
export const SCENE_FOG_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3 uScatterColor;
  uniform float uScatterStrength;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
`;

/** 同时需要光照与雾的着色器一次性引入。 */
export const ENVIRONMENT_UNIFORMS_GLSL = /* glsl */ `
  ${ENVIRONMENT_LIGHT_UNIFORMS_GLSL}
  ${SCENE_FOG_UNIFORMS_GLSL}
`;

/**
 * 半球染色。
 *
 * `uSkyTint` 与 `uBounceTint` 都已经归一化到平均值 1，所以这里只改色相不改
 * 亮度：黄昏时朝天的面偏暖、朝下的面偏冷，正午两者都接近白色，画面和没有
 * 半球光时一致。
 */
export const HEMISPHERE_TINT_GLSL = /* glsl */ `
  vec3 hemisphereTint(vec3 worldNormal) {
    float upward = worldNormal.y * 0.5 + 0.5;
    return mix(uBounceTint, uSkyTint, upward);
  }
`;

/**
 * 云影。
 *
 * 两层滚动的值噪声，强度由天气的云量给出，随风一起漂移。它乘在环境光上，
 * 所以地面、物件和草叶会被同一片阴影扫过，比整体压灰更能说明「多云」。
 */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
  float cloudShadowHash(vec2 cell) {
    return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float cloudShadowNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 offset = fract(point);
    vec2 weight = offset * offset * (3.0 - 2.0 * offset);
    float lowerLeft = cloudShadowHash(cell);
    float lowerRight = cloudShadowHash(cell + vec2(1.0, 0.0));
    float upperLeft = cloudShadowHash(cell + vec2(0.0, 1.0));
    float upperRight = cloudShadowHash(cell + vec2(1.0, 1.0));
    return mix(
      mix(lowerLeft, lowerRight, weight.x),
      mix(upperLeft, upperRight, weight.x),
      weight.y
    );
  }

  float cloudShadowAt(vec2 worldXZ) {
    if (uCloudShadowStrength <= 0.002) return 1.0;
    vec2 point = worldXZ * 0.055 + uCloudShadowOffset;
    float shape = cloudShadowNoise(point) * 0.68 + cloudShadowNoise(point * 2.3 + 4.7) * 0.32;
    return 1.0 - smoothstep(0.44, 0.82, shape) * uCloudShadowStrength;
  }
`;

/**
 * 方向性散射雾。
 *
 * 雾色不再是单一天空色：朝着太阳看会被日光染暖，背对太阳仍是天空的冷色。
 * 没有这一项时，雾一旦铺满画面（大片海面、开阔平原）就会糊成一整块单色，
 * 日落也就只剩「整屏变橙」。
 */
export const SCATTERED_FOG_GLSL = /* glsl */ `
  vec3 scatteredFogColor(vec3 worldPosition) {
    if (uScatterStrength <= 0.002) return uFogColor;
    vec3 viewDirection = normalize(worldPosition - cameraPosition);
    float towardSun = max(dot(viewDirection, uSunDirection), 0.0);
    float inScatter = pow(towardSun, 4.0) * uScatterStrength;
    return mix(uFogColor, uScatterColor, inScatter);
  }

  vec3 applySceneFog(vec3 color, vec3 worldPosition) {
    float cameraDistance = distance(cameraPosition, worldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    return mix(color, scatteredFogColor(worldPosition), fogFactor);
  }
`;

/** 需要完整环境光照的片元着色器一次性引入。 */
export const ENVIRONMENT_LIGHTING_GLSL = /* glsl */ `
  ${HEMISPHERE_TINT_GLSL}
  ${CLOUD_SHADOW_GLSL}
  ${SCATTERED_FOG_GLSL}
`;

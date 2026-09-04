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

/**
 * 同时参与照明的动态点光源上限。
 *
 * 这是一条**大世界约束**而不是性能微调：篝火是可建造的固定物件，玩家想放几个
 * 就有几个，而着色器里的循环次数必须与世界里的火堆数无关。渲染侧每帧只挑离
 * 视点最近的这几盏写进 uniform（见 `ThreePointLightVisual`），其余的既不占
 * uniform 也不进循环。
 */
export const MAX_ENVIRONMENT_POINT_LIGHTS = 4;

/**
 * 动态点光源的 uniform。
 *
 * 和半球染色、云影一样是**全场景一份**的共享状态：填充材质与草叶各自声明一遍，
 * 取的是 `SceneEnvironmentRuntime` 里同一批对象，所以渲染侧写一次、当帧全场生效。
 *
 * `uPointLightFalloff` 打包成 vec2 而不是两个数组：半径与强度总是一起读，
 * 一个 vec2 少一次 uniform 上传，也少一处「改了一个忘了改另一个」。
 */
export const POINT_LIGHT_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3 uPointLightPosition[${MAX_ENVIRONMENT_POINT_LIGHTS}];
  uniform vec3 uPointLightColor[${MAX_ENVIRONMENT_POINT_LIGHTS}];
  uniform vec3 uPointLightEdgeColor[${MAX_ENVIRONMENT_POINT_LIGHTS}];
  /** x = 半径（米），y = 这一帧的强度（已含闪烁与白昼衰减）；y 为 0 表示这一格是空的。 */
  uniform vec2 uPointLightFalloff[${MAX_ENVIRONMENT_POINT_LIGHTS}];
`;

/**
 * 点光源照明，照搬参考项目壁炉那一段的方法（`index.html` 的 FILL 片元着色器）。
 *
 * 三处照抄不是随手写的，它们一起构成那种「火边一切转暖」的线稿观感：
 *
 * - **衰减留一条线性尾巴**（`t*t*0.78 + t*0.22`）。纯平方衰减在半径边缘会切出
 *   一圈可见的硬边；那条尾巴让光晕在草地上化开。
 * - **近暖远深的双色**。近处取 `uPointLightColor`、边缘取 `uPointLightEdgeColor`，
 *   火光因此有炭火的色阶，而不是一团单色的橙。
 * - **直射之外还有一份漫反射兜底**（`bounce`）。背对火的面不该是纯黑——参考项目
 *   靠它让屋里背光的家具也浮出轮廓。
 *
 * 光色是**加上去的，不乘反照率**：参考项目就是这么做的，纸面本色的地面与物件
 * 因此会一起被染暖，这正是线稿风格想要的效果，而不是物理正确的漫反射。
 *
 * 闪烁与白昼衰减不在这里：它们是**逐光源**而不是逐像素的量，渲染侧折进强度里
 * 一次算完（见 `ThreePointLightVisual`），着色器少两个 uniform、少一串 sin。
 */
export const POINT_LIGHT_GLSL = /* glsl */ `
  vec3 pointLightRadiance(vec3 worldPosition, vec3 worldNormal) {
    vec3 radiance = vec3(0.0);
    for (int index = 0; index < ${MAX_ENVIRONMENT_POINT_LIGHTS}; index += 1) {
      float strength = uPointLightFalloff[index].y;
      // 空槽位与熄灭的火每帧都写 0，所以这一句就够，不需要另给一个 count。
      if (strength <= 0.002) continue;
      vec3 toLight = uPointLightPosition[index] - worldPosition;
      float lightDistance = length(toLight);
      float reach = clamp(1.0 - lightDistance / uPointLightFalloff[index].x, 0.0, 1.0);
      float attenuation = reach * reach * 0.78 + reach * 0.22;
      float facing = dot(worldNormal, toLight / max(lightDistance, 0.0001));
      float direct = attenuation * smoothstep(-0.08, 0.45, facing) * 0.55;
      float bounce = attenuation * 0.18 * (0.35 + 0.65 * smoothstep(-0.5, 0.3, facing));
      radiance += mix(uPointLightEdgeColor[index], uPointLightColor[index], reach)
        * strength * (direct + bounce);
    }
    return radiance;
  }
`;

/**
 * 草地着色器。
 *
 * 顶点着色器分成两段：形变与取样对所有布局都一样，放在 GRASS_SHARED；
 * 「这个实例代表哪一株草」随布局而变，由各自的 instance 段提供
 * resolveGrassInstance()。固定布局把世界坐标烘在实例属性里，滚动布局只存
 * 网格下标，由着色器按视野原点推算——两者共用同一份形变实现。
 */

const GRASS_SHARED = /* glsl */ `
  struct GrassInstance {
    vec3 offset;
    vec2 scale;
    float rotation;
    float phase;
    float tone;
  };

  uniform float uTime;
  uniform sampler2D uBendTexture;
  uniform vec2 uFieldOrigin;
  uniform vec2 uFieldSize;
  uniform float uFieldWrap;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vHeightRatio;
  varying float vTone;
  varying float vBendStrength;

  float hash21(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  /** 一次取四个互不相关的随机数，省下多次 sin 哈希。 */
  vec4 hash42(vec2 point) {
    vec4 scattered = fract(point.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099));
    scattered += dot(scattered, scattered.wzxy + 33.33);
    return fract((scattered.xxyz + scattered.yzzw) * scattered.zywx);
  }

  float valueNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    vec2 smoothLocal = local * local * (3.0 - 2.0 * local);
    float nearValue = mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), smoothLocal.x);
    float farValue = mix(
      hash21(cell + vec2(0.0, 1.0)),
      hash21(cell + vec2(1.0, 1.0)),
      smoothLocal.x
    );
    return mix(nearValue, farValue, smoothLocal.y);
  }

  vec2 rotate2D(vec2 point, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return mat2(cosine, -sine, sine, cosine) * point;
  }

  /**
   * 踩踏形变场的取样坐标。
   *
   * uFieldWrap 为 0 时按视野线性映射并钳制到边界，适合覆盖整块活动区、
   * 草长不到区外的固定视野。为 1 时按世界坐标环形寻址：同一块地永远落在
   * 同一个纹素上，视野滚动不会让已有的踩踏痕迹跟着漂移。
   */
  vec2 grassBendUv(vec2 bladeXZ) {
    vec2 span = max(uFieldSize, vec2(0.0001));
    vec2 clamped = clamp((bladeXZ - uFieldOrigin) / span, 0.0, 1.0);
    vec2 wrapped = fract(bladeXZ / span);
    return mix(clamped, wrapped, uFieldWrap);
  }

  vec3 deformGrassBlade(vec3 bladePosition, GrassInstance blade) {
    float heightRatio = clamp(bladePosition.y, 0.0, 1.0);
    float heightSquared = heightRatio * heightRatio;
    vec3 transformed = bladePosition;
    transformed.x *= blade.scale.x;
    transformed.y *= blade.scale.y;
    transformed.xz = rotate2D(transformed.xz, blade.rotation);

    float broadWind = valueNoise(
      blade.offset.xz * 0.18 + vec2(uTime * 0.18, -uTime * 0.11)
    ) * 2.0 - 1.0;
    float gust = sin(
      dot(blade.offset.xz, vec2(0.54, 0.31)) + uTime * 1.55 + blade.phase
    );
    vec2 windDirection = normalize(vec2(0.86, 0.36) + vec2(broadWind, -broadWind) * 0.22);
    transformed.xz += windDirection
      * (broadWind * 0.055 + gust * 0.035)
      * blade.scale.y
      * heightSquared;

    vec3 bendSample = texture2D(uBendTexture, grassBendUv(blade.offset.xz)).rgb;
    vec2 bendDirection = bendSample.rg * 2.0 - 1.0;
    float bendStrength = bendSample.b;
    transformed.xz += bendDirection * bendStrength * blade.scale.y * 0.72 * heightSquared;
    transformed.y -= bendStrength * blade.scale.y * 0.18 * heightSquared;
    transformed += blade.offset;

    vHeightRatio = heightRatio;
    vTone = blade.tone;
    vBendStrength = bendStrength;
    return transformed;
  }
`;

/** 固定布局：每株草的位置与形态在构造时算好，烘进实例属性。 */
const GRASS_FIXED_INSTANCE = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec2 aScale;
  attribute float aRotation;
  attribute float aPhase;
  attribute float aTone;

  GrassInstance resolveGrassInstance() {
    GrassInstance blade;
    blade.offset = aOffset;
    blade.scale = aScale;
    blade.rotation = aRotation;
    blade.phase = aPhase;
    blade.tone = aTone;
    return blade;
  }
`;

/**
 * 滚动布局：实例只存自己在网格里的下标，位置与形态由「世界格坐标」哈希导出。
 *
 * 视野原点始终对齐到格边长的整数倍，所以同一块地算出的 worldCell 恒定，
 * 玩家移动时草长在原地，不会跟着镜头游动——这是整个方案成立的前提。
 * 因此实例属性一次上传后永不更新，每帧只改 uFieldOrigin 一个 uniform。
 */
const GRASS_ROLLING_INSTANCE = /* glsl */ `
  attribute vec2 aCell;

  uniform vec2 uOriginCell;
  uniform float uCellSize;
  uniform float uFullDensityRadius;
  uniform float uFadeEndRadius;

  GrassInstance resolveGrassInstance() {
    // 格下标全程走整数加法：f32 在 2²⁴ 以内精确，同一块地无论视野在哪
    // 都得到逐位相同的 cellIndex，哈希出来的草才不会随镜头闪烁。
    // 换成 uFieldOrigin + aCell * uCellSize 这种浮点累加就守不住这一点。
    vec2 cellIndex = uOriginCell + aCell;
    vec2 worldCell = cellIndex * uCellSize;
    vec4 placement = hash42(cellIndex);
    vec4 shape = hash42(cellIndex + 71.7);
    vec2 bladeXZ = worldCell + (0.12 + placement.xy * 0.76) * uCellSize;

    // 远处的草既看不清也不值得画：按到视野中心（即焦点）的距离连续稀释，
    // 被稀释掉的实例缩放为零，退化成不占光栅化的三角形。
    vec2 center = uFieldOrigin + uFieldSize * 0.5;
    float falloff = 1.0 - smoothstep(uFullDensityRadius, uFadeEndRadius, distance(bladeXZ, center));
    float density = mix(0.5, 1.0, valueNoise(worldCell * 0.045)) * falloff;
    float alive = step(placement.z, density);

    float height = 0.34 + pow(shape.x, 0.7) * 0.38;
    GrassInstance blade;
    blade.offset = vec3(bladeXZ.x, 0.018, bladeXZ.y);
    blade.scale = vec2((0.045 + shape.y * 0.035) * (0.82 + height * 0.28), height) * alive;
    blade.rotation = placement.w * 6.2831853;
    blade.phase = shape.z * 6.2831853;
    blade.tone = shape.w * 2.0 - 1.0;
    return blade;
  }
`;

const GRASS_FILL_MAIN = /* glsl */ `
  void main() {
    GrassInstance blade = resolveGrassInstance();
    vec3 transformed = deformGrassBlade(position, blade);
    vec2 rotatedNormalXZ = rotate2D(normal.xz, blade.rotation);
    vWorldNormal = normalize(vec3(rotatedNormalXZ.x, normal.y, rotatedNormalXZ.y));
    vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

const GRASS_OUTLINE_MAIN = /* glsl */ `
  void main() {
    GrassInstance blade = resolveGrassInstance();
    vec3 transformed = deformGrassBlade(position, blade);
    vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vWorldNormal = vec3(0.0, 1.0, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

function createGrassVertexShader(instanceChunk: string, mainChunk: string): string {
  return `${GRASS_SHARED}\n${instanceChunk}\n${mainChunk}`;
}

export const GRASS_FIXED_FILL_VERTEX_SHADER = createGrassVertexShader(
  GRASS_FIXED_INSTANCE,
  GRASS_FILL_MAIN,
);
export const GRASS_FIXED_OUTLINE_VERTEX_SHADER = createGrassVertexShader(
  GRASS_FIXED_INSTANCE,
  GRASS_OUTLINE_MAIN,
);
export const GRASS_ROLLING_FILL_VERTEX_SHADER = createGrassVertexShader(
  GRASS_ROLLING_INSTANCE,
  GRASS_FILL_MAIN,
);
export const GRASS_ROLLING_OUTLINE_VERTEX_SHADER = createGrassVertexShader(
  GRASS_ROLLING_INSTANCE,
  GRASS_OUTLINE_MAIN,
);

export const GRASS_FILL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uFillColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vHeightRatio;
  varying float vTone;
  varying float vBendStrength;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float diffuse = dot(normal, normalize(vec3(-0.55, 0.9, 0.35))) * 0.5 + 0.5;
    float paperVariation = 0.91 + vHeightRatio * 0.08 + vTone * 0.035;
    float touchHighlight = vBendStrength * vHeightRatio * 0.045;
    vec3 color = uFillColor * (paperVariation + diffuse * 0.06) + touchHighlight;

    float cameraDistance = distance(cameraPosition, vWorldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    gl_FragColor = vec4(mix(color, uFogColor, fogFactor), 1.0);
    #include <encodings_fragment>
  }
`;

export const GRASS_OUTLINE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLineColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorldPosition;

  void main() {
    float cameraDistance = distance(cameraPosition, vWorldPosition);
    float fogFactor = smoothstep(uFogNear, uFogFar, cameraDistance);
    gl_FragColor = vec4(mix(uLineColor, uFogColor, fogFactor), 1.0);
    #include <encodings_fragment>
  }
`;

export const GRASS_BEND_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const GRASS_BEND_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uPreviousTexture;
  uniform vec2 uFieldOrigin;
  uniform vec2 uPreviousOrigin;
  uniform vec2 uFieldSize;
  uniform float uFieldWrap;
  uniform vec2 uImpulsePosition;
  uniform vec2 uImpulseDirection;
  uniform float uImpulseRadius;
  uniform float uImpulseStrength;
  uniform float uDecay;

  varying vec2 vUv;

  /** 给定视野原点，这个纹素代表世界上的哪一点。 */
  vec2 texelWorldPosition(vec2 uv, vec2 origin) {
    vec2 linear = origin + uv * uFieldSize;
    vec2 wrapped = origin + mod(uv * uFieldSize - origin, uFieldSize);
    return mix(linear, wrapped, uFieldWrap);
  }

  void main() {
    vec2 worldPosition = texelWorldPosition(vUv, uFieldOrigin);
    vec2 previousWorld = texelWorldPosition(vUv, uPreviousOrigin);

    // 视野滚动后，这个纹素被重新指派给了另一块地，里面存的踩踏痕迹属于
    // 一个视野之外的位置，必须丢掉；否则玩家往前走会撞见自己一个视野之前
    // 留下的旧脚印。原点不动时这一项恒为 0，固定视野因此完全不受影响。
    vec2 drift = abs(worldPosition - previousWorld);
    float reanchored = step(0.0001, max(drift.x, drift.y));

    vec3 previous = texture2D(uPreviousTexture, vUv).rgb;
    float previousStrength = previous.b * uDecay * (1.0 - reanchored);
    vec2 bendVector = (previous.rg * 2.0 - 1.0) * previousStrength;

    float distanceToImpulse = distance(worldPosition, uImpulsePosition);
    float weight = (1.0 - smoothstep(0.0, uImpulseRadius, distanceToImpulse))
      * uImpulseStrength;
    bendVector += uImpulseDirection * weight;

    float strength = clamp(length(bendVector), 0.0, 1.0);
    vec2 direction = strength > 0.0001 ? bendVector / strength : vec2(0.0);
    gl_FragColor = vec4(direction * 0.5 + 0.5, strength, 1.0);
  }
`;

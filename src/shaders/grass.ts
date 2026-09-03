import {
  CLOUD_SHADOW_GLSL,
  ENVIRONMENT_LIGHT_UNIFORMS_GLSL,
  HEMISPHERE_TINT_GLSL,
} from './environmentLighting';

/**
 * 草叶顶点形变。
 *
 * 四件事叠在同一个函数里，顺序是有讲究的：先按噪声定这一根有多高，再按叶片
 * 自身的弧度弯一点，然后叠上风，最后才叠踩踏。踩踏必须最后来，因为它要压过
 * 风——被踩住的草不应该还在随风摇。
 *
 * 三张采样源都只读一次：静态噪声一次拿到团簇高度与色斑，风噪声两次（阵风与
 * 细颤），踩踏场一次。顶点着色器里每多一次采样就是每片草叶每个顶点多一次，
 * 所以噪声打包成一张贴图的四个通道，而不是四张贴图。
 */
const GRASS_VERTEX_DEFORMATION = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uBendTexture;
  uniform sampler2D uNoiseTexture;
  uniform vec4 uFieldBounds;
  /** 风向 × 风力，由天气系统写进场景共享 uniform。 */
  uniform vec2 uWindVector;
  /** gustScale, gustSpeed, flutterScale, flutterSpeed */
  uniform vec4 uWindNoise;
  /** baseSway, gustSway, flutterSway */
  uniform vec3 uWindSway;
  /** clumpScale, clumpAmount, bladeAmount, curveAmount */
  uniform vec4 uHeightVariation;
  uniform float uGrassLodNear;
  uniform float uGrassLodFar;

  attribute vec3 aOffset;
  attribute vec2 aScale;
  attribute float aRotation;
  attribute float aPhase;
  attribute float aTone;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vHeightRatio;
  varying float vTone;
  varying float vBendStrength;
  varying float vDistanceLod;
  varying float vLodRandom;
  varying float vDryPatch;
  /** 叶片整体的倾倒向量（按叶高归一），片元用它做法线偏折。 */
  varying vec2 vLean;

  float hash21(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  vec2 rotate2D(vec2 point, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return mat2(cosine, -sine, sine, cosine) * point;
  }

  vec3 deformGrassVertex(vec3 bladePosition) {
    float heightRatio = clamp(bladePosition.y, 0.0, 1.0);
    float heightSquared = heightRatio * heightRatio;
    float cameraDistance = distance(cameraPosition, aOffset);
    float distanceLod = smoothstep(uGrassLodNear, uGrassLodFar, cameraDistance);

    // ---- 高低差：一张可平铺噪声按世界坐标决定「这一片长得高还是矮」。
    // 只用逐叶随机的话每根草各长各的，看着是噪点；只用团簇噪声又太规整。
    // 两者相乘才有自然草地那种「一团一团、团内还参差」的错落。
    vec4 staticNoise = texture2D(uNoiseTexture, aOffset.xz * uHeightVariation.x);
    float bladeRandom = hash21(aOffset.xz + vec2(aPhase, aRotation));
    float clumpSigned = staticNoise.r * 2.0 - 1.0;
    float bladeSigned = bladeRandom * 2.0 - 1.0;
    float heightScale = max(
      0.25,
      1.0 + clumpSigned * uHeightVariation.y + bladeSigned * uHeightVariation.z
    );
    float bladeHeight = aScale.y * heightScale * mix(1.0, 0.62, distanceLod);

    vec3 transformed = bladePosition;
    transformed.x *= aScale.x;
    transformed.y *= bladeHeight;
    transformed.xz = rotate2D(transformed.xz, aRotation);

    // ---- 风：滚动的阵风噪声压出前沿，风团因此是「扫过去」而不是整片一起抖。
    float windPower = length(uWindVector);
    vec2 windDirection = windPower > 0.0001
      ? uWindVector / windPower
      : vec2(0.86, 0.51);
    windPower = clamp(windPower, 0.0, 2.0);
    vec2 gustUv = (aOffset.xz - windDirection * (uTime * uWindNoise.y)) * uWindNoise.x;
    float gustFront = smoothstep(0.42, 0.86, texture2D(uNoiseTexture, gustUv).g);
    vec2 flutterUv = (aOffset.xz - windDirection * (uTime * uWindNoise.w)) * uWindNoise.z;
    float flutter = texture2D(uNoiseTexture, flutterUv).b * 2.0 - 1.0;
    float flutterPhase = sin(uTime * 2.6 + aPhase + gustFront * 3.2);
    float swayAlong = (uWindSway.x * (0.65 + 0.35 * flutterPhase)
      + gustFront * uWindSway.y) * windPower;
    float swaySide = uWindSway.z * windPower * flutter * flutterPhase;
    vec2 windLean = windDirection * swayAlong
      + vec2(-windDirection.y, windDirection.x) * swaySide;

    // ---- 叶片自身的弧度：直挺挺的一根是毛不是叶，弯一点才像草。
    vec2 curveAxis = rotate2D(vec2(0.0, 1.0), aRotation);
    vec2 curveLean = curveAxis
      * (uHeightVariation.w * (0.55 + bladeRandom * 0.9) * sign(bladeSigned + 0.0001));

    // ---- 踩踏：局部弯曲窗口之外一律取中性值，不让采样越界渗到别处。
    vec2 fieldSize = max(uFieldBounds.zw - uFieldBounds.xy, vec2(0.0001));
    vec2 rawBendUv = (aOffset.xz - uFieldBounds.xy) / fieldSize;
    vec2 insideMinimum = step(vec2(0.0), rawBendUv);
    vec2 insideMaximum = step(rawBendUv, vec2(1.0));
    float insideBendField = insideMinimum.x * insideMinimum.y
      * insideMaximum.x * insideMaximum.y;
    vec3 bendSample = texture2D(uBendTexture, clamp(rawBendUv, 0.0, 1.0)).rgb;
    vec2 bendDirection = bendSample.rg * 2.0 - 1.0;
    float bendStrength = bendSample.b * insideBendField;

    // 被踩住的草不再随风摇，倾倒方向交给压痕向量场。
    vec2 lean = (windLean + curveLean) * (1.0 - bendStrength * 0.75)
      + bendDirection * bendStrength * 0.95;
    float leanLength = min(length(lean), 0.98);

    transformed.xz += lean * bladeHeight * heightSquared;
    // 弧长补偿：叶片弯下去应该变矮，而不是被拉长成一根横着的针。
    float verticalScale = sqrt(max(0.0, 1.0 - leanLength * leanLength));
    transformed.y *= mix(1.0, verticalScale, heightSquared);
    // 踩踏再额外压扁一档；只有弧长补偿的话踩过的草还是立着的。
    transformed.y *= mix(1.0, 0.32, bendStrength * heightSquared);
    transformed += aOffset;

    vHeightRatio = heightRatio;
    vTone = aTone;
    vBendStrength = bendStrength;
    vDistanceLod = distanceLod;
    vLodRandom = bladeRandom;
    vDryPatch = staticNoise.a;
    vLean = lean;
    return transformed;
  }
`;

export const GRASS_FILL_VERTEX_SHADER = /* glsl */ `
  ${GRASS_VERTEX_DEFORMATION}

  void main() {
    vec3 transformed = deformGrassVertex(position);
    // 叶面法线是纯水平的（叶片是一张竖着的薄片），直接拿来打光只会侧面亮、
    // 正面全黑。混进被倾倒方向偏折过的「叶脊朝上」方向，草才有体积感。
    vec2 rotatedNormalXZ = rotate2D(normal.xz, aRotation);
    vec3 leafNormal = normalize(vec3(rotatedNormalXZ.x, 0.0, rotatedNormalXZ.y));
    vec3 spineNormal = normalize(vec3(-vLean.x, 1.0, -vLean.y));
    vWorldNormal = normalize(mix(leafNormal, spineNormal, 0.55));
    vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

export const GRASS_FILL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uGrassRootColor;
  uniform vec3 uGrassTipColor;
  uniform vec3 uGrassDryColor;
  uniform float uDryPatchStrength;
  ${ENVIRONMENT_LIGHT_UNIFORMS_GLSL}

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vHeightRatio;
  varying float vTone;
  varying float vBendStrength;
  varying float vDryPatch;

  ${HEMISPHERE_TINT_GLSL}
  ${CLOUD_SHADOW_GLSL}

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 lightDirection = normalize(uSunDirection);
    float diffuse = max(dot(normal, lightDirection), 0.0);

    // 根深尖浅是这片草最主要的信息量：单一色的密集细叶只会糊成一团。
    // 指数大于 1，让叶片下半截更长时间停在根色上，渐变不会一上来就冲到叶尖色。
    float gradient = pow(vHeightRatio, 1.35);
    vec3 baseColor = mix(uGrassRootColor, uGrassTipColor, gradient);
    // 极低频色斑推出偏枯的地块，草地因此不是一整片同色。
    baseColor = mix(baseColor, uGrassDryColor, vDryPatch * uDryPatchStrength);
    baseColor *= 1.0 + vTone * 0.055;

    // 根部环境遮蔽。缺了它草像是浮在地面上，而不是从土里长出来。
    float rootOcclusion = mix(0.72, 1.0, smoothstep(0.0, 0.42, vHeightRatio));

    // 草叶几乎是竖直的，太阳压低时侧面受光最明显。
    float grazing = 1.0 - clamp(lightDirection.y, 0.0, 1.0);
    float softLight = 0.82 + diffuse * (0.04 + uDaylight * 0.10) * (1.0 + grazing * 0.9);

    // 逆光透光：叶尖薄，太阳在草背后时会透出来。
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float backLight = pow(max(dot(viewDirection, -lightDirection), 0.0), 3.0);
    float translucency = backLight * gradient * uDaylight * 0.3;

    float touchHighlight = vBendStrength * vHeightRatio * 0.045;
    vec3 ambient = uAmbientColor * hemisphereTint(normal)
      * cloudShadowAt(vWorldPosition.xz);
    vec3 color = baseColor * ambient * rootOcclusion * softLight
      + ambient * (touchHighlight + translucency);

    // 地面草叶保持参考项目的纸面颜色，不叠加天气距离雾。
    gl_FragColor = vec4(color, 1.0);
    #include <encodings_fragment>
  }
`;

export const GRASS_OUTLINE_VERTEX_SHADER = /* glsl */ `
  ${GRASS_VERTEX_DEFORMATION}

  void main() {
    vec3 transformed = deformGrassVertex(position);
    vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vWorldNormal = vec3(0.0, 1.0, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

export const GRASS_OUTLINE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLineColor;
  uniform vec3 uInkTint;

  varying vec3 vWorldPosition;
  varying float vHeightRatio;
  varying float vDistanceLod;
  varying float vLodRandom;

  void main() {
    float outlineLod = pow(vDistanceLod, 0.45);
    float outlineKeepRate = mix(1.0, 0.035, outlineLod);
    if (vLodRandom > outlineKeepRate) {
      discard;
    }

    // 根部不描边。整根叶子都镶一圈墨线时，密集的草就成了一片黑毛——
    // 线稿的墨应该点在叶尖，让下半截交给填充色的渐变。
    float alpha = smoothstep(0.12, 0.62, vHeightRatio) * mix(1.0, 0.45, outlineLod);
    if (alpha < 0.02) {
      discard;
    }

    gl_FragColor = vec4(uLineColor * uInkTint, alpha);
    #include <encodings_fragment>
  }
`;

export const GRASS_TRAIL_STAMP_VERTEX_SHADER = /* glsl */ `
  uniform vec4 uFieldBounds;

  attribute vec2 aSegmentStart;
  attribute vec2 aSegmentEnd;
  /** radius, startStrength, endStrength */
  attribute vec3 aSegmentShape;

  varying vec2 vWorldPosition;
  varying vec2 vSegmentStart;
  varying vec2 vSegmentEnd;
  varying vec3 vSegmentShape;

  void main() {
    float radius = aSegmentShape.x;
    vec2 axis = aSegmentEnd - aSegmentStart;
    float axisLength = length(axis);
    vec2 forward = axisLength > 0.0001 ? axis / axisLength : vec2(1.0, 0.0);
    vec2 side = vec2(-forward.y, forward.x);
    vec2 center = (aSegmentStart + aSegmentEnd) * 0.5;
    // 源几何是 PlaneBufferGeometry(2, 2)，position 落在 [-1, 1]，
    // 正好当作这段路径有向包围盒的两个半轴。
    vec2 world = center
      + forward * (position.x * (axisLength * 0.5 + radius))
      + side * (position.y * radius);

    vec2 fieldSize = max(uFieldBounds.zw - uFieldBounds.xy, vec2(0.0001));
    vec2 fieldUv = (world - uFieldBounds.xy) / fieldSize;
    vWorldPosition = world;
    vSegmentStart = aSegmentStart;
    vSegmentEnd = aSegmentEnd;
    vSegmentShape = aSegmentShape;
    gl_Position = vec4(fieldUv * 2.0 - 1.0, 0.0, 1.0);
  }
`;

/**
 * 把一段路径盖进弯曲向量场。
 *
 * 输出的 rgb 与旧的累积场保持同一套编码（rg 是 `方向 * 0.5 + 0.5`，b 是强度），
 * 草叶着色器因此不需要知道场是怎么来的。alpha 输出这一段的权重，配合普通
 * 混合就变成「越新越强的一段覆盖旧的一段」，不需要浮点渲染目标做有符号累加。
 */
export const GRASS_TRAIL_STAMP_FRAGMENT_SHADER = /* glsl */ `
  /** 0 = 纯径向推开，1 = 纯沿行进方向推倒。 */
  uniform float uAlongBias;

  varying vec2 vWorldPosition;
  varying vec2 vSegmentStart;
  varying vec2 vSegmentEnd;
  varying vec3 vSegmentShape;

  void main() {
    vec2 axis = vSegmentEnd - vSegmentStart;
    float axisLengthSquared = dot(axis, axis);
    float ratio = axisLengthSquared > 0.000001
      ? clamp(dot(vWorldPosition - vSegmentStart, axis) / axisLengthSquared, 0.0, 1.0)
      : 0.0;
    vec2 closest = vSegmentStart + axis * ratio;
    vec2 radialOffset = vWorldPosition - closest;
    float radialDistance = length(radialOffset);
    float falloff = 1.0 - smoothstep(0.0, vSegmentShape.x, radialDistance);
    // 两端强度线性过渡，路径因此沿着自己从旧到新地淡出。
    float weight = falloff * mix(vSegmentShape.y, vSegmentShape.z, ratio);
    if (weight <= 0.002) {
      discard;
    }

    vec2 forward = axisLengthSquared > 0.000001
      ? axis * inversesqrt(axisLengthSquared)
      : vec2(1.0, 0.0);
    vec2 outward = radialDistance > 0.0001
      ? radialOffset / radialDistance
      : vec2(0.0);
    // 中心线上 outward 为零，加一点 forward 兜住 normalize 的零向量。
    vec2 direction = normalize(mix(outward, forward, uAlongBias) + forward * 0.0001);
    gl_FragColor = vec4(direction * 0.5 + 0.5, 1.0, weight);
  }
`;

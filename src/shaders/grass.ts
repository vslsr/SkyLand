const GRASS_VERTEX_DEFORMATION = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uBendTexture;
  uniform vec4 uFieldBounds;
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

  float hash21(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
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

  vec3 deformGrassVertex(vec3 bladePosition) {
    float heightRatio = clamp(bladePosition.y, 0.0, 1.0);
    float heightSquared = heightRatio * heightRatio;
    float cameraDistance = distance(cameraPosition, aOffset);
    float distanceLod = smoothstep(uGrassLodNear, uGrassLodFar, cameraDistance);
    vec3 transformed = bladePosition;
    transformed.x *= aScale.x;
    transformed.y *= aScale.y * mix(1.0, 0.62, distanceLod);
    transformed.xz = rotate2D(transformed.xz, aRotation);

    float broadWind = valueNoise(
      aOffset.xz * 0.18 + vec2(uTime * 0.18, -uTime * 0.11)
    ) * 2.0 - 1.0;
    float gust = sin(
      dot(aOffset.xz, vec2(0.54, 0.31)) + uTime * 1.55 + aPhase
    );
    vec2 windDirection = normalize(vec2(0.86, 0.36) + vec2(broadWind, -broadWind) * 0.22);
    transformed.xz += windDirection
      * (broadWind * 0.055 + gust * 0.035)
      * aScale.y
      * heightSquared;

    vec2 fieldSize = max(uFieldBounds.zw - uFieldBounds.xy, vec2(0.0001));
    vec2 rawBendUv = (aOffset.xz - uFieldBounds.xy) / fieldSize;
    vec2 insideMinimum = step(vec2(0.0), rawBendUv);
    vec2 insideMaximum = step(rawBendUv, vec2(1.0));
    float insideBendField = insideMinimum.x * insideMinimum.y
      * insideMaximum.x * insideMaximum.y;
    vec3 bendSample = texture2D(uBendTexture, clamp(rawBendUv, 0.0, 1.0)).rgb;
    vec2 bendDirection = bendSample.rg * 2.0 - 1.0;
    float bendStrength = bendSample.b * insideBendField;
    float bendAmount = bendStrength * heightSquared;
    transformed.xz += bendDirection * bendAmount * aScale.y * 0.78;
    transformed.y *= mix(1.0, 0.22, bendAmount);
    transformed += aOffset;

    vHeightRatio = heightRatio;
    vTone = aTone;
    vBendStrength = bendStrength;
    vDistanceLod = distanceLod;
    vLodRandom = hash21(aOffset.xz + vec2(aPhase, aRotation));
    return transformed;
  }
`;

export const GRASS_FILL_VERTEX_SHADER = /* glsl */ `
  ${GRASS_VERTEX_DEFORMATION}

  void main() {
    vec3 transformed = deformGrassVertex(position);
    vec2 rotatedNormalXZ = rotate2D(normal.xz, aRotation);
    vWorldNormal = normalize(vec3(rotatedNormalXZ.x, normal.y, rotatedNormalXZ.y));
    vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

export const GRASS_FILL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uFillColor;
  uniform vec3 uAmbientColor;
  uniform float uDaylight;
  uniform vec3 uSunDirection;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vHeightRatio;
  varying float vTone;
  varying float vBendStrength;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float diffuse = max(dot(normal, normalize(uSunDirection)), 0.0);
    float paperVariation = 0.91 + vHeightRatio * 0.08 + vTone * 0.035;
    float touchHighlight = vBendStrength * vHeightRatio * 0.045;
    float softLight = 0.82 + diffuse * (0.04 + uDaylight * 0.10);
    vec3 color = uFillColor * uAmbientColor * paperVariation * softLight
      + uAmbientColor * touchHighlight;

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

  varying vec3 vWorldPosition;
  varying float vDistanceLod;
  varying float vLodRandom;

  void main() {
    float outlineLod = pow(vDistanceLod, 0.45);
    float outlineKeepRate = mix(1.0, 0.035, outlineLod);
    if (vLodRandom > outlineKeepRate) {
      discard;
    }

    gl_FragColor = vec4(uLineColor, 1.0);
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
  uniform vec4 uPreviousFieldBounds;
  uniform vec4 uFieldBounds;
  uniform vec2 uImpulsePosition;
  uniform vec2 uImpulseStartPosition;
  uniform vec2 uImpulseDirection;
  uniform float uImpulseRadius;
  uniform float uImpulseStrength;
  uniform float uImpulseRadial;
  uniform float uDecay;

  varying vec2 vUv;

  void main() {
    vec2 currentFieldSize = max(uFieldBounds.zw - uFieldBounds.xy, vec2(0.0001));
    vec2 worldPosition = uFieldBounds.xy + vUv * currentFieldSize;
    vec2 previousFieldSize = max(
      uPreviousFieldBounds.zw - uPreviousFieldBounds.xy,
      vec2(0.0001)
    );
    vec2 previousUv = (worldPosition - uPreviousFieldBounds.xy) / previousFieldSize;
    vec2 insidePreviousMinimum = step(vec2(0.0), previousUv);
    vec2 insidePreviousMaximum = step(previousUv, vec2(1.0));
    float insidePreviousField = insidePreviousMinimum.x * insidePreviousMinimum.y
      * insidePreviousMaximum.x * insidePreviousMaximum.y;
    vec3 sampledPrevious = texture2D(
      uPreviousTexture,
      clamp(previousUv, 0.0, 1.0)
    ).rgb;
    vec3 previous = mix(vec3(0.5, 0.5, 0.0), sampledPrevious, insidePreviousField);
    float previousStrength = previous.b * uDecay;
    vec2 bendVector = (previous.rg * 2.0 - 1.0) * previousStrength;

    vec2 sweepSegment = uImpulsePosition - uImpulseStartPosition;
    float sweepLengthSquared = dot(sweepSegment, sweepSegment);
    float sweepRatio = sweepLengthSquared > 0.000001
      ? clamp(
        dot(worldPosition - uImpulseStartPosition, sweepSegment) / sweepLengthSquared,
        0.0,
        1.0
      )
      : 1.0;
    vec2 closestSweepPoint = mix(uImpulseStartPosition, uImpulsePosition, sweepRatio);
    vec2 radialOffset = worldPosition - closestSweepPoint;
    float radialDistance = length(radialOffset);
    float directionalDistance = distance(worldPosition, uImpulsePosition);
    float distanceToImpulse = mix(directionalDistance, radialDistance, uImpulseRadial);
    vec2 radialDirection = radialDistance > 0.0001
      ? radialOffset / max(radialDistance, 0.0001)
      : uImpulseDirection;
    vec2 impulseDirection = mix(uImpulseDirection, radialDirection, uImpulseRadial);
    float weight = (1.0 - smoothstep(0.0, uImpulseRadius, distanceToImpulse))
      * uImpulseStrength;
    bendVector += impulseDirection * weight;

    float strength = clamp(length(bendVector), 0.0, 1.0);
    vec2 direction = strength > 0.0001 ? bendVector / strength : vec2(0.0);
    gl_FragColor = vec4(direction * 0.5 + 0.5, strength, 1.0);
  }
`;

const GRASS_VERTEX_DEFORMATION = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uBendTexture;
  uniform vec4 uFieldBounds;

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
    vec3 transformed = bladePosition;
    transformed.x *= aScale.x;
    transformed.y *= aScale.y;
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
    vec2 bendUv = clamp((aOffset.xz - uFieldBounds.xy) / fieldSize, 0.0, 1.0);
    vec3 bendSample = texture2D(uBendTexture, bendUv).rgb;
    vec2 bendDirection = bendSample.rg * 2.0 - 1.0;
    float bendStrength = bendSample.b;
    transformed.xz += bendDirection * bendStrength * aScale.y * 0.72 * heightSquared;
    transformed.y -= bendStrength * aScale.y * 0.18 * heightSquared;
    transformed += aOffset;

    vHeightRatio = heightRatio;
    vTone = aTone;
    vBendStrength = bendStrength;
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
  uniform vec4 uFieldBounds;
  uniform vec2 uImpulsePosition;
  uniform vec2 uImpulseDirection;
  uniform float uImpulseRadius;
  uniform float uImpulseStrength;
  uniform float uDecay;

  varying vec2 vUv;

  void main() {
    vec3 previous = texture2D(uPreviousTexture, vUv).rgb;
    float previousStrength = previous.b * uDecay;
    vec2 bendVector = (previous.rg * 2.0 - 1.0) * previousStrength;

    vec2 worldPosition = mix(uFieldBounds.xy, uFieldBounds.zw, vUv);
    float distanceToImpulse = distance(worldPosition, uImpulsePosition);
    float weight = (1.0 - smoothstep(0.0, uImpulseRadius, distanceToImpulse))
      * uImpulseStrength;
    bendVector += uImpulseDirection * weight;

    float strength = clamp(length(bendVector), 0.0, 1.0);
    vec2 direction = strength > 0.0001 ? bendVector / strength : vec2(0.0);
    gl_FragColor = vec4(direction * 0.5 + 0.5, strength, 1.0);
  }
`;

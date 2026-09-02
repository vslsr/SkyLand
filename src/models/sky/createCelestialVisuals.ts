import * as THREE from 'three';

/**
 * 天体在客户端里的固定预算。星空是一次 draw call 的 Points，日月各是一组
 * 线稿片元，流星只保留很少的几条；整套资源在场景创建时一次建好，昼夜推进
 * 时只改变换和材质参数。
 */
export const CELESTIAL_VISUAL_CAPACITY = Object.freeze({
  stars: 700,
  milkyWayStars: 1300,
  meteors: 3,
  meteorTrailPoints: 20,
});

/** 天体是无限远元素：每帧跟着相机平移，半径必须留在相机远裁剪面以内。 */
export const CELESTIAL_RADIUS = Object.freeze({
  sun: 78,
  moon: 78,
  stars: 92,
  meteorSpawn: 76,
});

export interface MeteorVisual {
  readonly line: THREE.Line;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.LineBasicMaterial;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
}

export interface CelestialVisuals {
  readonly root: THREE.Group;
  readonly sunRoot: THREE.Group;
  readonly sunFillMaterial: THREE.MeshBasicMaterial;
  readonly sunLineMaterial: THREE.LineBasicMaterial;
  readonly sunGlowNear: THREE.Mesh;
  readonly sunGlowFar: THREE.Mesh;
  readonly sunGlowNearMaterial: THREE.ShaderMaterial;
  readonly sunGlowFarMaterial: THREE.ShaderMaterial;
  readonly moonRoot: THREE.Group;
  readonly moonFillMaterial: THREE.MeshBasicMaterial;
  readonly moonLineMaterial: THREE.LineBasicMaterial;
  readonly moonGlowMaterial: THREE.ShaderMaterial;
  readonly stars: THREE.Points;
  readonly starMaterial: THREE.ShaderMaterial;
  readonly meteors: readonly MeteorVisual[];
  dispose(): void;
}

const GLOW_VERTEX_SHADER = /* glsl */ `
  varying vec2 vGlowUv;
  void main() {
    vGlowUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GLOW_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFalloff;
  varying vec2 vGlowUv;

  void main() {
    float distanceFromCenter = length(vGlowUv - 0.5) * 2.0;
    float falloff = pow(max(0.0, 1.0 - distanceFromCenter), uFalloff);
    gl_FragColor = vec4(uColor, falloff * uOpacity);
  }
`;

const STAR_VERTEX_SHADER = /* glsl */ `
  attribute float aTwinkle;
  attribute float aSpeed;
  attribute float aColorMix;
  attribute float aSize;
  uniform float uTime;
  varying float vTwinkle;
  varying float vColorMix;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float twinkle = 0.45 + 0.55 * abs(sin(uTime * aSpeed * 0.5 + aTwinkle));
    gl_PointSize = aSize * (0.75 + 0.55 * twinkle) * (200.0 / -viewPosition.z);
    vTwinkle = twinkle;
    vColorMix = aColorMix;
  }
`;

// 线稿风格下的星点仍然保留恒星色序：偏蓝、纸白、暖黄到橘红。
const STAR_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying float vTwinkle;
  varying float vColorMix;

  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float distanceFromCenter = length(offset);
    if (distanceFromCenter > 0.5) discard;
    float edge = 1.0 - distanceFromCenter * 2.0;
    float alpha = edge * edge * vTwinkle * uOpacity;
    float mixAmount = clamp(vColorMix, 0.0, 1.0);
    vec3 blueWhite = vec3(0.66, 0.76, 1.00);
    vec3 paperWhite = vec3(0.90, 0.94, 1.00);
    vec3 warmWhite = vec3(1.00, 0.97, 0.88);
    vec3 amber = vec3(1.00, 0.78, 0.56);
    vec3 ember = vec3(1.00, 0.60, 0.48);
    vec3 starColor;
    if (mixAmount < 0.25) starColor = mix(blueWhite, paperWhite, mixAmount / 0.25);
    else if (mixAmount < 0.55) starColor = mix(paperWhite, warmWhite, (mixAmount - 0.25) / 0.30);
    else if (mixAmount < 0.82) starColor = mix(warmWhite, amber, (mixAmount - 0.55) / 0.27);
    else starColor = mix(amber, ember, (mixAmount - 0.82) / 0.18);
    gl_FragColor = vec4(starColor * 1.42, min(alpha, 1.0));
  }
`;

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createGlowMaterial(color: number, falloff: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uFalloff: { value: falloff },
    },
    vertexShader: GLOW_VERTEX_SHADER,
    fragmentShader: GLOW_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

/** 天顶方向上的均匀采样；yMinimum 之下的半球留给地平线以下。 */
function sampleCapDirection(random: () => number, yMinimum: number): THREE.Vector3 {
  const y = yMinimum + random() * (1 - yMinimum);
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = random() * Math.PI * 2;
  return new THREE.Vector3(radius * Math.cos(angle), y, radius * Math.sin(angle));
}

/** 银河带：绕着一条倾斜大圆做高斯散布，密度明显高于普通星点。 */
function sampleMilkyWayDirection(
  random: () => number,
  normal: THREE.Vector3,
  tangentU: THREE.Vector3,
  tangentV: THREE.Vector3,
  yMinimum: number,
): THREE.Vector3 {
  const direction = new THREE.Vector3();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const spread = (random() + random() + random() - 1.5) / 1.5 * 0.3;
    direction
      .copy(tangentU)
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(tangentV, Math.sin(angle))
      .addScaledVector(normal, spread)
      .normalize();
    if (direction.y >= yMinimum) return direction;
  }
  return sampleCapDirection(random, yMinimum);
}

function createStarField(): { points: THREE.Points; material: THREE.ShaderMaterial } {
  const random = createRandom(0x5ee_d571);
  const total = CELESTIAL_VISUAL_CAPACITY.stars + CELESTIAL_VISUAL_CAPACITY.milkyWayStars;
  const positions = new Float32Array(total * 3);
  const twinkle = new Float32Array(total);
  const speed = new Float32Array(total);
  const colorMix = new Float32Array(total);
  const size = new Float32Array(total);

  const normal = new THREE.Vector3(0.58, 0.72, 0.38).normalize();
  const tangentU = new THREE.Vector3(1, 0, 0).addScaledVector(normal, -normal.x).normalize();
  const tangentV = new THREE.Vector3().crossVectors(normal, tangentU);

  for (let index = 0; index < total; index += 1) {
    const milkyWay = index >= CELESTIAL_VISUAL_CAPACITY.stars;
    const direction = milkyWay
      ? sampleMilkyWayDirection(random, normal, tangentU, tangentV, 0.075)
      : sampleCapDirection(random, 0.055);
    positions[index * 3] = direction.x * CELESTIAL_RADIUS.stars;
    positions[index * 3 + 1] = direction.y * CELESTIAL_RADIUS.stars;
    positions[index * 3 + 2] = direction.z * CELESTIAL_RADIUS.stars;
    twinkle[index] = random() * Math.PI * 2;
    if (milkyWay) {
      speed[index] = 0.2 + random() * 0.85;
      colorMix[index] = random() < 0.82 ? random() * 0.32 : random();
      size[index] = random() < 0.05 ? 2.3 + random() * 1.3 : 0.9 + random() * 1.3;
    } else {
      speed[index] = 0.45 + random() * 1.55;
      colorMix[index] = (random() + random()) * 0.5;
      size[index] = random() < 0.07 ? 6.4 + random() * 2.8 : 2.9 + random() * 2.3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute('aColorMix', new THREE.BufferAttribute(colorMix, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'daynight-stars';
  points.frustumCulled = false;
  points.visible = false;
  return { points, material };
}

function createSun(): {
  root: THREE.Group;
  fillMaterial: THREE.MeshBasicMaterial;
  lineMaterial: THREE.LineBasicMaterial;
  glowNear: THREE.Mesh;
  glowFar: THREE.Mesh;
  glowNearMaterial: THREE.ShaderMaterial;
  glowFarMaterial: THREE.ShaderMaterial;
  geometries: THREE.BufferGeometry[];
} {
  const root = new THREE.Group();
  root.name = 'daynight-sun';
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd75e,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xc98a2e,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const discGeometry = new THREE.CircleGeometry(3.2, 28);
  const edgeGeometry = new THREE.EdgesGeometry(discGeometry, 15);
  const rayPositions: number[] = [];
  for (let ray = 0; ray < 12; ray += 1) {
    const angle = ray / 12 * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    rayPositions.push(cosine * 4.0, sine * 4.0, 0, cosine * 5.5, sine * 5.5, 0);
  }
  const rayGeometry = new THREE.BufferGeometry();
  rayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rayPositions, 3));

  const glowNearMaterial = createGlowMaterial(0xffc8a0, 2.4);
  const glowFarMaterial = createGlowMaterial(0xff9760, 1.7);
  const glowNearGeometry = new THREE.PlaneGeometry(30, 30);
  const glowFarGeometry = new THREE.PlaneGeometry(72, 72);
  const glowNear = new THREE.Mesh(glowNearGeometry, glowNearMaterial);
  const glowFar = new THREE.Mesh(glowFarGeometry, glowFarMaterial);
  // 光晕排在圆盘后面，日轮线稿始终压在暖光之上。
  glowNear.position.z = -0.4;
  glowFar.position.z = -0.5;

  root.add(
    glowFar,
    glowNear,
    new THREE.Mesh(discGeometry, fillMaterial),
    new THREE.LineSegments(edgeGeometry, lineMaterial),
    new THREE.LineSegments(rayGeometry, lineMaterial),
  );
  root.visible = false;
  return {
    root,
    fillMaterial,
    lineMaterial,
    glowNear,
    glowFar,
    glowNearMaterial,
    glowFarMaterial,
    geometries: [discGeometry, edgeGeometry, rayGeometry, glowNearGeometry, glowFarGeometry],
  };
}

function createMoon(): {
  root: THREE.Group;
  fillMaterial: THREE.MeshBasicMaterial;
  lineMaterial: THREE.LineBasicMaterial;
  glowMaterial: THREE.ShaderMaterial;
  geometries: THREE.BufferGeometry[];
} {
  const root = new THREE.Group();
  root.name = 'daynight-moon';
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: 0xe8eefb,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x6f7ea8,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const discGeometry = new THREE.CircleGeometry(2.6, 32);
  const edgeGeometry = new THREE.EdgesGeometry(discGeometry, 15);
  const glowMaterial = createGlowMaterial(0x93a8e8, 2.0);
  const glowGeometry = new THREE.PlaneGeometry(26, 26);
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  glow.position.z = -0.4;
  root.add(glow, new THREE.Mesh(discGeometry, fillMaterial), new THREE.LineSegments(edgeGeometry, lineMaterial));

  const geometries = [discGeometry, edgeGeometry, glowGeometry];
  // 环形山只画轮廓线，和整套线稿一样靠边缘描述体积。
  for (const [x, y, radius] of [[0.76, 0.68, 0.56], [-0.72, -0.44, 0.36], [0.1, -1.0, 0.26]]) {
    const craterGeometry = new THREE.CircleGeometry(radius, 12);
    const craterEdges = new THREE.EdgesGeometry(craterGeometry, 15);
    const crater = new THREE.LineSegments(craterEdges, lineMaterial);
    crater.position.set(x, y, 0.02);
    root.add(crater);
    geometries.push(craterGeometry, craterEdges);
  }
  root.visible = false;
  return { root, fillMaterial, lineMaterial, glowMaterial, geometries };
}

function createMeteors(): MeteorVisual[] {
  const meteors: MeteorVisual[] = [];
  for (let index = 0; index < CELESTIAL_VISUAL_CAPACITY.meteors; index += 1) {
    const positions = new Float32Array(CELESTIAL_VISUAL_CAPACITY.meteorTrailPoints * 3);
    const colors = new Float32Array(CELESTIAL_VISUAL_CAPACITY.meteorTrailPoints * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const line = new THREE.Line(geometry, material);
    line.name = `daynight-meteor-${index}`;
    line.frustumCulled = false;
    line.visible = false;
    meteors.push({ line, geometry, material, positions, colors });
  }
  return meteors;
}

/**
 * 昼夜系统的线稿天体资源：日轮、月轮、星空与流星。
 *
 * 这里只负责程序化几何与 GPU 缓冲；时刻推进、可见度和颜色由
 * `src/environment/DayNightSystem` 按房间权威时刻驱动。
 */
export function createCelestialVisuals(): CelestialVisuals {
  const root = new THREE.Group();
  root.name = 'daynight-celestial';

  const sun = createSun();
  const moon = createMoon();
  const starField = createStarField();
  const meteors = createMeteors();

  root.add(starField.points, sun.root, moon.root);
  for (const meteor of meteors) root.add(meteor.line);

  return {
    root,
    sunRoot: sun.root,
    sunFillMaterial: sun.fillMaterial,
    sunLineMaterial: sun.lineMaterial,
    sunGlowNear: sun.glowNear,
    sunGlowFar: sun.glowFar,
    sunGlowNearMaterial: sun.glowNearMaterial,
    sunGlowFarMaterial: sun.glowFarMaterial,
    moonRoot: moon.root,
    moonFillMaterial: moon.fillMaterial,
    moonLineMaterial: moon.lineMaterial,
    moonGlowMaterial: moon.glowMaterial,
    stars: starField.points,
    starMaterial: starField.material,
    meteors,
    dispose() {
      while (root.children.length > 0) root.remove(root.children[0]);
      for (const geometry of [...sun.geometries, ...moon.geometries]) geometry.dispose();
      sun.fillMaterial.dispose();
      sun.lineMaterial.dispose();
      sun.glowNearMaterial.dispose();
      sun.glowFarMaterial.dispose();
      moon.fillMaterial.dispose();
      moon.lineMaterial.dispose();
      moon.glowMaterial.dispose();
      starField.points.geometry.dispose();
      starField.material.dispose();
      for (const meteor of meteors) {
        meteor.geometry.dispose();
        meteor.material.dispose();
      }
    },
  };
}

import * as THREE from 'three';

export const WEATHER_VISUAL_CAPACITY = Object.freeze({
  clouds: 14,
  activeChunks: 9,
  rainDropsPerChunk: 64,
  snowFlakesPerChunk: 50,
  rainDrops: 9 * 64,
  snowFlakes: 9 * 50,
});

export interface WeatherCloudVisual {
  readonly root: THREE.Group;
  readonly speed: number;
  readonly floatPhase: number;
}

export interface WeatherVisuals {
  readonly root: THREE.Group;
  readonly clouds: readonly WeatherCloudVisual[];
  readonly cloudFillMaterial: THREE.MeshBasicMaterial;
  readonly cloudLineMaterial: THREE.LineBasicMaterial;
  readonly rainLines: THREE.LineSegments;
  readonly rainGeometry: THREE.BufferGeometry;
  readonly rainPositions: Float32Array;
  readonly rainMaterial: THREE.LineBasicMaterial;
  readonly snowLines: THREE.LineSegments;
  readonly snowGeometry: THREE.BufferGeometry;
  readonly snowPositions: Float32Array;
  readonly snowMaterial: THREE.LineBasicMaterial;
  readonly lightningLine: THREE.Line;
  readonly lightningGeometry: THREE.BufferGeometry;
  readonly lightningPositions: Float32Array;
  readonly lightningMaterial: THREE.LineBasicMaterial;
  dispose(): void;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * 创建天气系统的固定容量线稿资源。粒子状态与 chunk 激活由 WeatherSystem 管理，
 * 这里仅负责程序化模型和 GPU 缓冲，避免把几何构造塞进场景组合代码。
 *
 * 日轮、月轮与星空属于昼夜系统，见 `src/models/sky/createCelestialVisuals.ts`。
 */
export function createWeatherVisuals(): WeatherVisuals {
  const random = createRandom(0x51ca_b1e7);
  const root = new THREE.Group();
  root.name = 'chunk-weather-system';

  const cloudFillMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });
  const cloudLineMaterial = new THREE.LineBasicMaterial({
    color: 0x65717b,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
  });
  const cloudFillGeometry = new THREE.SphereGeometry(1, 8, 6);
  const cloudLineGeometry = new THREE.EdgesGeometry(cloudFillGeometry, 15);
  const clouds: WeatherCloudVisual[] = [];

  for (let cloudIndex = 0; cloudIndex < WEATHER_VISUAL_CAPACITY.clouds; cloudIndex += 1) {
    const cloudRoot = new THREE.Group();
    cloudRoot.name = `weather-cloud-${cloudIndex}`;
    const lobeCount = 4 + Math.floor(random() * 4);
    let cursorX = 0;
    for (let lobeIndex = 0; lobeIndex < lobeCount; lobeIndex += 1) {
      const width = 1.8 + random() * 2;
      const height = 1.2 + random();
      const depth = 1.8 + random() * 2;
      const lobe = new THREE.Mesh(cloudFillGeometry, cloudFillMaterial);
      const outline = new THREE.LineSegments(cloudLineGeometry, cloudLineMaterial);
      const y = lobeIndex > 0 && random() < 0.4
        ? height * 0.3
        : (random() - 0.3) * 0.2;
      const z = (random() - 0.5) * 1.2;
      lobe.scale.set(width * 0.5, height * 0.5, depth * 0.5);
      lobe.position.set(cursorX, y, z);
      outline.scale.copy(lobe.scale);
      outline.position.copy(lobe.position);
      cloudRoot.add(lobe, outline);
      cursorX += width * 0.3;
    }
    cloudRoot.scale.set(1, 0.68, 1);
    cloudRoot.position.set(
      (random() - 0.5) * 120,
      18 + random() * 8,
      (random() - 0.5) * 90,
    );
    cloudRoot.visible = false;
    root.add(cloudRoot);
    clouds.push({
      root: cloudRoot,
      speed: 0.7 + random() * 0.6,
      floatPhase: random() * Math.PI * 2,
    });
  }

  const rainPositions = new Float32Array(WEATHER_VISUAL_CAPACITY.rainDrops * 6);
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  rainGeometry.setDrawRange(0, 0);
  const rainMaterial = new THREE.LineBasicMaterial({
    color: 0x7d93a8,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const rainLines = new THREE.LineSegments(rainGeometry, rainMaterial);
  rainLines.name = 'chunk-weather-rain';
  rainLines.frustumCulled = false;
  rainLines.visible = false;
  root.add(rainLines);

  // 三条交叉线组成一片低成本线稿雪花：每片 6 个顶点。
  const snowPositions = new Float32Array(WEATHER_VISUAL_CAPACITY.snowFlakes * 18);
  const snowGeometry = new THREE.BufferGeometry();
  snowGeometry.setAttribute('position', new THREE.BufferAttribute(snowPositions, 3));
  snowGeometry.setDrawRange(0, 0);
  const snowMaterial = new THREE.LineBasicMaterial({
    color: 0xa8c0dc,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const snowLines = new THREE.LineSegments(snowGeometry, snowMaterial);
  snowLines.name = 'chunk-weather-snow';
  snowLines.frustumCulled = false;
  snowLines.visible = false;
  root.add(snowLines);

  const lightningPositions = new Float32Array(8 * 3);
  const lightningGeometry = new THREE.BufferGeometry();
  lightningGeometry.setAttribute('position', new THREE.BufferAttribute(lightningPositions, 3));
  const lightningMaterial = new THREE.LineBasicMaterial({
    color: 0xfdfbf6,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const lightningLine = new THREE.Line(lightningGeometry, lightningMaterial);
  lightningLine.name = 'chunk-weather-lightning';
  lightningLine.frustumCulled = false;
  lightningLine.visible = false;
  root.add(lightningLine);

  return {
    root,
    clouds,
    cloudFillMaterial,
    cloudLineMaterial,
    rainLines,
    rainGeometry,
    rainPositions,
    rainMaterial,
    snowLines,
    snowGeometry,
    snowPositions,
    snowMaterial,
    lightningLine,
    lightningGeometry,
    lightningPositions,
    lightningMaterial,
    dispose() {
      while (root.children.length > 0) root.remove(root.children[0]);
      cloudFillGeometry.dispose();
      cloudLineGeometry.dispose();
      cloudFillMaterial.dispose();
      cloudLineMaterial.dispose();
      rainGeometry.dispose();
      rainMaterial.dispose();
      snowGeometry.dispose();
      snowMaterial.dispose();
      lightningGeometry.dispose();
      lightningMaterial.dispose();
    },
  };
}

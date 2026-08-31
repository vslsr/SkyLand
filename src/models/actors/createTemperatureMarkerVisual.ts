import * as THREE from 'three';

export interface TemperatureMarkerVisual {
  readonly root: THREE.Group;
  setTemperature(temperature: number): void;
  dispose(): void;
}

const TEXTURE_WIDTH = 512;
const TEXTURE_HEIGHT = 192;
const PLATE_WIDTH = 1.48;
const PLATE_HEIGHT = 0.5;
const BORDER_INSET = 0.035;

function setOverlayMaterial(material: THREE.Material): void {
  material.depthTest = false;
  material.depthWrite = false;
}

function temperatureColor(temperature: number): string {
  if (temperature < 0) return '#527f91';
  if (temperature < 45) return '#3f6658';
  if (temperature < 75) return '#a96d2d';
  return '#a53e2c';
}

function formatTemperature(temperature: number): string {
  return `${temperature.toFixed(1)} °C`;
}

/**
 * Three.js 世界空间温度牌。每个已加载温度 Actor 最多持有一张固定纹理；
 * 更新只重绘同一块 Canvas，不随快照数量创建新纹理或材质。
 */
export function createTemperatureMarkerVisual(): TemperatureMarkerVisual {
  const root = new THREE.Group();
  root.name = 'actor-temperature-marker';
  root.visible = false;
  root.frustumCulled = false;

  const borderGeometry = new THREE.PlaneGeometry(PLATE_WIDTH, PLATE_HEIGHT);
  const borderMaterial = new THREE.MeshBasicMaterial({ color: 0x29231f, fog: false });
  setOverlayMaterial(borderMaterial);
  const border = new THREE.Mesh(borderGeometry, borderMaterial);
  border.name = 'actor-temperature-marker-border';
  border.renderOrder = 1010;
  root.add(border);

  const plateGeometry = new THREE.PlaneGeometry(
    PLATE_WIDTH - BORDER_INSET * 2,
    PLATE_HEIGHT - BORDER_INSET * 2,
  );
  const plateMaterial = new THREE.MeshBasicMaterial({
    color: 0xf5ecd7,
    transparent: true,
    opacity: 0.96,
    fog: false,
  });
  setOverlayMaterial(plateMaterial);
  const plate = new THREE.Mesh(plateGeometry, plateMaterial);
  plate.name = 'actor-temperature-marker-plate';
  plate.position.z = 0.006;
  plate.renderOrder = 1011;
  root.add(plate);

  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null | undefined;
  let texture: THREE.CanvasTexture | undefined;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = TEXTURE_WIDTH;
    canvas.height = TEXTURE_HEIGHT;
    context = canvas.getContext('2d');
    if (context) {
      texture = new THREE.CanvasTexture(canvas);
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
    }
  }

  const labelGeometry = new THREE.PlaneGeometry(PLATE_WIDTH - 0.1, PLATE_HEIGHT - 0.1);
  const labelMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.02,
    fog: false,
    side: THREE.DoubleSide,
  });
  if (texture) labelMaterial.map = texture;
  setOverlayMaterial(labelMaterial);
  const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial);
  labelMesh.name = 'actor-temperature-marker-label';
  labelMesh.position.z = 0.014;
  labelMesh.renderOrder = 1012;
  labelMesh.visible = Boolean(texture);
  root.add(labelMesh);

  let currentLabel = '';
  const setTemperature = (temperature: number): void => {
    if (!Number.isFinite(temperature)) return;
    const nextLabel = formatTemperature(temperature);
    if (nextLabel === currentLabel) return;
    currentLabel = nextLabel;
    root.userData.temperature = temperature;
    root.userData.temperatureLabel = nextLabel;
    if (!context || !canvas || !texture) return;

    context.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    context.fillStyle = temperatureColor(temperature);
    context.font = '700 96px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(nextLabel, TEXTURE_WIDTH / 2, TEXTURE_HEIGHT / 2 + 4, TEXTURE_WIDTH - 30);
    texture.needsUpdate = true;
  };

  return {
    root,
    setTemperature,
    dispose(): void {
      root.parent?.remove(root);
      texture?.dispose();
      labelGeometry.dispose();
      plateGeometry.dispose();
      borderGeometry.dispose();
      labelMaterial.dispose();
      plateMaterial.dispose();
      borderMaterial.dispose();
    },
  };
}

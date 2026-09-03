import * as THREE from 'three';
import { createDrawingSurface } from '../../platform/index';
import { createSurfaceTexture } from '../../materials/surfaceTexture';

export interface InteractionMarkerVisual {
  readonly root: THREE.Group;
  setLabel(label: string): void;
  /** 整块牌子的淡入淡出；0 是全透明，1 是牌子本来的样子。 */
  setOpacity(opacity: number): void;
  dispose(): void;
}

function setOverlayMaterial(material: THREE.Material): void {
  material.depthTest = false;
  material.depthWrite = false;
}

const MARKER_HEIGHT = 0.56;
const PAPER_INSET = 0.07;
/** 纸面本来就压着一点透明度；淡入淡出是在这个基线上乘出来的。 */
const PLATE_OPACITY = 0.96;
const LABEL_TEXTURE_HEIGHT = 256;
const LABEL_FONT_SIZE = 176;

function createLabelTexture(label: string): THREE.CanvasTexture | undefined {
  // 宽度要先量了才知道，所以开一块最小的、量完再改尺寸——改尺寸会清空画布，
  // 所以字体要在改完之后重新设一遍（下面那一行不是重复代码）。
  const surface = createDrawingSurface(1, 1);
  if (!surface) return undefined;
  const { canvas, context } = surface;

  context.font = `700 ${LABEL_FONT_SIZE}px Arial, sans-serif`;
  const measuredWidth = context.measureText(label).width;
  canvas.width = Math.max(128, Math.min(1024, Math.ceil(measuredWidth + 64)));
  canvas.height = LABEL_TEXTURE_HEIGHT;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#29231f';
  context.font = `700 ${LABEL_FONT_SIZE}px Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, canvas.width / 2, canvas.height / 2 + 4, canvas.width - 32);

  return createSurfaceTexture(surface);
}

/** 线稿风通用输入标记；标签由实时 MappingContext 提供。 */
export function createInteractionMarkerVisual(): InteractionMarkerVisual {
  const root = new THREE.Group();
  root.name = 'actor-interaction-marker';
  root.visible = false;
  root.frustumCulled = false;

  // WebGL 的 LineBasicMaterial 通常只能渲染 1px 线宽，远距离会被抗锯齿吞掉。
  // 边框和字形都使用实心三角形，保证低分辨率下仍然清晰。
  const borderGeometry = new THREE.PlaneGeometry(1, 1);
  // 边框和字形本来是不透明的；淡入淡出要靠 opacity，所以三块材质统一走透明通道。
  // 深度测试与写入本来就是关的，渲染顺序仍由 renderOrder 决定，叠放次序不变。
  const borderMaterial = new THREE.MeshBasicMaterial({
    color: 0x29231f,
    transparent: true,
    fog: false,
  });
  setOverlayMaterial(borderMaterial);
  const border = new THREE.Mesh(borderGeometry, borderMaterial);
  border.name = 'actor-interaction-marker-border';
  border.scale.set(MARKER_HEIGHT, MARKER_HEIGHT, 1);
  border.renderOrder = 1000;
  root.add(border);

  const plateGeometry = new THREE.PlaneGeometry(1, 1);
  const plateMaterial = new THREE.MeshBasicMaterial({
    color: 0xf5ecd7,
    transparent: true,
    opacity: PLATE_OPACITY,
    fog: false,
  });
  setOverlayMaterial(plateMaterial);
  const plate = new THREE.Mesh(plateGeometry, plateMaterial);
  plate.name = 'actor-interaction-marker-plate';
  plate.scale.set(MARKER_HEIGHT - PAPER_INSET, MARKER_HEIGHT - PAPER_INSET, 1);
  plate.position.z = 0.006;
  plate.renderOrder = 1001;
  root.add(plate);

  const glyphGeometry = new THREE.PlaneGeometry(1, 1);
  const glyphMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.02,
    fog: false,
    side: THREE.DoubleSide,
  });
  setOverlayMaterial(glyphMaterial);
  const glyph = new THREE.Mesh(glyphGeometry, glyphMaterial);
  glyph.name = 'actor-interaction-marker-glyph';
  glyph.visible = false;
  glyph.position.z = 0.014;
  glyph.renderOrder = 1002;
  root.add(glyph);

  let currentLabel = '';
  let currentOpacity = 1;
  let labelTexture: THREE.CanvasTexture | undefined;

  const setLabel = (rawLabel: string): void => {
    const label = rawLabel.trim().slice(0, 16);
    if (label === currentLabel) return;
    currentLabel = label;
    root.userData.controlLabel = label;
    labelTexture?.dispose();
    labelTexture = undefined;
    glyphMaterial.map = null;

    const characterCount = Math.max(1, [...label].length);
    const labelWidth = THREE.MathUtils.clamp(0.2 + (characterCount - 1) * 0.13, 0.2, 0.82);
    const markerWidth = Math.max(MARKER_HEIGHT, labelWidth + 0.18);
    border.scale.x = markerWidth;
    plate.scale.x = markerWidth - PAPER_INSET;
    glyph.scale.set(labelWidth, 0.3, 1);

    if (label) labelTexture = createLabelTexture(label);
    glyphMaterial.map = labelTexture ?? null;
    glyphMaterial.needsUpdate = true;
    glyph.visible = Boolean(labelTexture);
  };

  // 淡入淡出每帧都会调一次，值没变就不碰材质。
  const setOpacity = (opacity: number): void => {
    const clamped = THREE.MathUtils.clamp(opacity, 0, 1);
    if (clamped === currentOpacity) return;
    currentOpacity = clamped;
    borderMaterial.opacity = clamped;
    plateMaterial.opacity = PLATE_OPACITY * clamped;
    glyphMaterial.opacity = clamped;
  };

  return {
    root,
    setLabel,
    setOpacity,
    dispose(): void {
      root.parent?.remove(root);
      labelTexture?.dispose();
      glyphGeometry.dispose();
      borderGeometry.dispose();
      plateGeometry.dispose();
      glyphMaterial.dispose();
      borderMaterial.dispose();
      plateMaterial.dispose();
    },
  };
}

import * as THREE from 'three';
import {
  createContactShadowMaterial,
  type ContactShadowMaterial,
} from '../materials/createContactShadowMaterial';
import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';
import type { ActorVisualModel } from './actors/ActorVisualModel';

export type PlayerSlimeRenderDefinition = Extract<
  ActorRenderDefinition,
  { model: 'line-art-player-slime' }
>;

export interface SlimeBubble {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  phase: number;
  angle: number;
  radius: number;
}

export interface PlayerSlimeModel extends ActorVisualModel {
  body: THREE.Group;
  geometry: THREE.SphereGeometry;
  originalPositions: Float32Array;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  bubbles: SlimeBubble[];
  shadow: THREE.Mesh<THREE.CircleGeometry, ContactShadowMaterial>;
  radius: number;
}

export type SlimeColor = THREE.Color | number | string;

export interface SlimePalette {
  membrane: SlimeColor;
  middle: SlimeColor;
  core: SlimeColor;
  bubble: SlimeColor;
  ink: SlimeColor;
  shadow: SlimeColor;
}

/** 本地玩家保持原有的薄荷绿配色。 */
export const LOCAL_SLIME_PALETTE: SlimePalette = {
  membrane: 0x4fd695,
  middle: 0x8ce8b6,
  core: 0x2fbb7c,
  bubble: 0xeafff2,
  ink: 0x173a2b,
  shadow: 0x1e5a40,
};

function createConfiguredPalette(definition: PlayerSlimeRenderDefinition): SlimePalette {
  return {
    membrane: definition.membraneColor,
    middle: definition.middleColor,
    core: definition.coreColor,
    bubble: definition.bubbleColor,
    ink: definition.inkColor,
    shadow: definition.shadowColor,
  };
}

// 避开本地玩家的绿色，让同房间的史莱姆一眼能分开。
const REMOTE_HUES = [0.02, 0.09, 0.14, 0.55, 0.62, 0.72, 0.86] as const;

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hsl(hue: number, saturation: number, lightness: number): THREE.Color {
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

/** 由玩家 id 稳定地派生一套配色，重连之后颜色不会变。 */
export function createSlimePalette(playerId: string): SlimePalette {
  const hue = REMOTE_HUES[hashText(playerId) % REMOTE_HUES.length];
  return {
    membrane: hsl(hue, 0.62, 0.57),
    middle: hsl(hue, 0.62, 0.73),
    core: hsl(hue, 0.6, 0.46),
    bubble: hsl(hue, 0.55, 0.95),
    ink: hsl(hue, 0.4, 0.16),
    shadow: hsl(hue, 0.5, 0.24),
  };
}

const BUBBLE_LAYOUT = [
  { phase: 0.08, angle: 0.3, radius: 0.07, size: 0.023 },
  { phase: 0.31, angle: 2.1, radius: 0.12, size: 0.019 },
  { phase: 0.57, angle: 4.2, radius: 0.09, size: 0.026 },
  { phase: 0.82, angle: 5.5, radius: 0.05, size: 0.017 },
] as const;

function createFace(radius: number, palette: SlimePalette): THREE.Group {
  const face = new THREE.Group();
  // 眼睛是角色识别层，不参与昼夜光照、雾或色调映射；夜晚也必须保持原始墨色。
  const ink = new THREE.MeshBasicMaterial({
    color: palette.ink,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const eyeGeometry = new THREE.SphereGeometry(radius * 0.075, 10, 8);

  for (const [index, x] of [-radius * 0.27, radius * 0.27].entries()) {
    const eye = new THREE.Mesh(eyeGeometry, ink);
    eye.name = `player-slime-eye-${index === 0 ? 'left' : 'right'}`;
    eye.position.set(x, radius * 0.08, radius * 0.92);
    eye.scale.y = 1.25;
    eye.renderOrder = 5;
    face.add(eye);
  }

  const smilePoints = [
    new THREE.Vector3(-radius * 0.14, -radius * 0.09, radius * 0.965),
    new THREE.Vector3(0, -radius * 0.14, radius * 0.985),
    new THREE.Vector3(radius * 0.14, -radius * 0.09, radius * 0.965),
  ];
  const smile = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(smilePoints),
    new THREE.LineBasicMaterial({ color: palette.ink }),
  );
  smile.renderOrder = 5;
  face.add(smile);
  return face;
}

export function createPlayerSlimeModel(
  definition: PlayerSlimeRenderDefinition,
  palette: SlimePalette = createConfiguredPalette(definition),
): PlayerSlimeModel {
  const radius = definition.radius;
  const membraneMaterial = new THREE.MeshBasicMaterial({
    color: palette.membrane,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const middleMaterial = new THREE.MeshBasicMaterial({
    color: palette.middle,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: palette.core,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bubbleMaterial = new THREE.MeshBasicMaterial({
    color: palette.bubble,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  const root = new THREE.Group();
  root.name = 'player-slime';
  const visualRoot = new THREE.Group();
  visualRoot.name = 'player-slime-visual';
  root.add(visualRoot);
  const body = new THREE.Group();
  visualRoot.add(body);

  const geometry = new THREE.SphereGeometry(radius, 26, 18);
  const positionAttribute = geometry.getAttribute('position');
  const originalPositions = Float32Array.from(positionAttribute.array as ArrayLike<number>);

  const membrane = new THREE.Mesh(geometry, membraneMaterial);
  membrane.renderOrder = 3;
  body.add(membrane);

  const middleLayer = new THREE.Mesh(geometry, middleMaterial);
  middleLayer.scale.setScalar(0.86);
  middleLayer.renderOrder = 2;
  body.add(middleLayer);

  const core = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.48, 18, 14), coreMaterial);
  core.renderOrder = 1;
  body.add(core);

  const bubbles = BUBBLE_LAYOUT.map<SlimeBubble>((layout) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(layout.size, 8, 6), bubbleMaterial);
    mesh.renderOrder = 4;
    body.add(mesh);
    return { mesh, phase: layout.phase, angle: layout.angle, radius: layout.radius };
  });

  body.add(createFace(radius, palette));

  // 影子的方向、长度和浓度跟着房间权威时刻走，见 createContactShadowMaterial。
  const shadowMaterial = createContactShadowMaterial(palette.shadow, { opacity: 0.16 });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.8, 24), shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  visualRoot.add(shadow);

  return {
    root,
    visualRoot,
    body,
    geometry,
    originalPositions,
    core,
    bubbles,
    shadow,
    radius,
    length: radius * 2,
    width: radius * 2,
    simpleCollision: {
      shape: 'cylinder',
      centerX: 0,
      centerZ: 0,
      halfWidth: radius,
      halfLength: radius,
      minimumY: 0,
      maximumY: radius * 2,
      supportShape: 'cylinder',
      supportHalfWidth: radius,
      supportHalfLength: radius,
    },
  };
}

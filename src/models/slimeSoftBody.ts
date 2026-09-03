import * as THREE from 'three';

/**
 * `line-art-player-slime` 的软体外壳，从 `playerSlime.ts` 里抽出来。
 *
 * 抽出来是因为它不再只属于玩家史莱姆：长腿的 `line-art-legged-slime` 用的就是
 * 同一个身体——同一套膜/中层/核心/气泡/脸，同一条由 `ThreeSlimeAnimator` 驱动的
 * 挤压与顶点波动。两个模型各自复制一遍会让「软体看起来是什么样」变成两处独立
 * 演化的代码。
 *
 * 这里只负责**身体**：贴地阴影、碰撞尺寸、腿这些「这只史莱姆怎么站在世界里」的
 * 事情留给各自的模型文件。
 */

export type SlimeColor = THREE.Color | number | string;

export interface SlimePalette {
  membrane: SlimeColor;
  middle: SlimeColor;
  core: SlimeColor;
  bubble: SlimeColor;
  ink: SlimeColor;
  shadow: SlimeColor;
}

export interface SlimeBubble {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  phase: number;
  angle: number;
  radius: number;
}

/**
 * `ThreeSlimeAnimator` 驱动的全部节点。
 *
 * 动画器只认识这个接口，不认识任何一个具体模型：给它一个软体身体，它就把挤压、
 * 摇摆和顶点波动写进去。
 */
export interface SlimeSoftBody {
  readonly body: THREE.Group;
  readonly geometry: THREE.SphereGeometry;
  readonly originalPositions: Float32Array;
  readonly core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly bubbles: readonly SlimeBubble[];
  readonly radius: number;
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

export function createSlimeFace(radius: number, palette: SlimePalette): THREE.Group {
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

/**
 * 建一个软体身体，原点在球心。
 *
 * 球心而不是脚底：`ThreeSlimeAnimator` 每帧按当前挤压量决定 `body.position.y`，
 * 贴地的史莱姆把它顶到 `radius * scaleY`，长腿的把它留在髋点上。谁在什么高度
 * 是**调用方**的事，身体本身不该假设自己坐在地上。
 */
export function createSlimeSoftBody(radius: number, palette: SlimePalette): SlimeSoftBody {
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

  const body = new THREE.Group();
  body.name = 'slime-soft-body';

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

  body.add(createSlimeFace(radius, palette));

  return { body, geometry, originalPositions, core, bubbles, radius };
}

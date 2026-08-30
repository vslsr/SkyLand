import * as THREE from 'three';

export interface SlimeBubble {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  phase: number;
  angle: number;
  radius: number;
}

export interface PlayerSlimeModel {
  root: THREE.Group;
  body: THREE.Group;
  geometry: THREE.SphereGeometry;
  originalPositions: Float32Array;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  bubbles: SlimeBubble[];
  shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  radius: number;
}

const BUBBLE_LAYOUT = [
  { phase: 0.08, angle: 0.3, radius: 0.07, size: 0.023 },
  { phase: 0.31, angle: 2.1, radius: 0.12, size: 0.019 },
  { phase: 0.57, angle: 4.2, radius: 0.09, size: 0.026 },
  { phase: 0.82, angle: 5.5, radius: 0.05, size: 0.017 },
] as const;

function createFace(radius: number): THREE.Group {
  const face = new THREE.Group();
  const ink = new THREE.MeshBasicMaterial({ color: 0x173a2b });
  const eyeGeometry = new THREE.SphereGeometry(radius * 0.075, 10, 8);

  for (const x of [-radius * 0.27, radius * 0.27]) {
    const eye = new THREE.Mesh(eyeGeometry, ink);
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
    new THREE.LineBasicMaterial({ color: 0x173a2b }),
  );
  smile.renderOrder = 5;
  face.add(smile);
  return face;
}

export function createPlayerSlimeModel(): PlayerSlimeModel {
  const radius = 0.42;
  const membraneMaterial = new THREE.MeshBasicMaterial({
    color: 0x4fd695,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const middleMaterial = new THREE.MeshBasicMaterial({
    color: 0x8ce8b6,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0x2fbb7c,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bubbleMaterial = new THREE.MeshBasicMaterial({
    color: 0xeafff2,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  const root = new THREE.Group();
  root.name = 'local-player-slime';
  const body = new THREE.Group();
  root.add(body);

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

  body.add(createFace(radius));

  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x1e5a40,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.8, 24), shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  root.add(shadow);

  return { root, body, geometry, originalPositions, core, bubbles, shadow, radius };
}

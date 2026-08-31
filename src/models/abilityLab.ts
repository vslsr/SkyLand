import * as THREE from 'three';
import { createOutlinedObject } from './outlinedObject';

export interface AbilityLabModel {
  readonly root: THREE.Group;
  readonly casterRune: THREE.Group;
  readonly casterCrystal: THREE.Group;
  readonly rageRings: THREE.Group;
  readonly silenceCage: THREE.Group;
  readonly target: THREE.Group;
  readonly targetCore: THREE.Group;
  readonly burningAura: THREE.Group;
  readonly projectileLayer: THREE.Group;
  readonly targetPoint: THREE.Vector3;
  /** 兼容实验室表现控制器的语义锚点。 */
  readonly casterAnchor: THREE.Group;
  readonly targetAnchor: THREE.Group;
  readonly targetBody: THREE.Group;
  readonly burnMarker: THREE.Group;
  readonly rageMarker: THREE.Group;
  readonly silenceMarker: THREE.Group;
}

const INK = 0x26221f;
const PAPER = 0xf7f0df;

function material(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: 1 });
}

function outlined(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  threshold = 12,
): THREE.Group {
  return createOutlinedObject(
    geometry,
    material(color),
    threshold,
    new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.82 }),
  );
}

function runeLoop(radius: number, color: THREE.ColorRepresentation, segments = 40): THREE.LineLoop {
  const points = Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  });
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.65 }),
  );
}

function createCasterRune(): {
  root: THREE.Group;
  casterCrystal: THREE.Group;
  rageRings: THREE.Group;
  silenceCage: THREE.Group;
} {
  const root = new THREE.Group();
  root.name = 'ability-lab-caster-rune';
  for (const radius of [0.7, 0.92]) {
    const loop = runeLoop(radius, 0x7c6a9f, 36);
    loop.position.y = 0.025;
    root.add(loop);
  }
  const crossGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.72, 0.028, 0), new THREE.Vector3(0.72, 0.028, 0),
    new THREE.Vector3(0, 0.028, -0.72), new THREE.Vector3(0, 0.028, 0.72),
  ]);
  root.add(new THREE.LineSegments(
    crossGeometry,
    new THREE.LineBasicMaterial({ color: 0x7c6a9f, transparent: true, opacity: 0.46 }),
  ));

  const casterCrystal = outlined(new THREE.OctahedronGeometry(0.19), 0xc8b8dd, 1);
  casterCrystal.name = 'ability-lab-caster-crystal';
  casterCrystal.position.y = 1.05;
  casterCrystal.scale.set(0.72, 1.5, 0.72);
  root.add(casterCrystal);

  const rageRings = new THREE.Group();
  rageRings.name = 'ability-lab-rage-rings';
  for (const [radius, height] of [[0.58, 0.28], [0.74, 0.52], [0.9, 0.78]] as const) {
    const ring = runeLoop(radius, 0xba6547, 32);
    ring.position.y = height;
    rageRings.add(ring);
  }
  rageRings.visible = false;
  root.add(rageRings);

  const silenceCage = new THREE.Group();
  silenceCage.name = 'ability-lab-silence-cage';
  const cageMaterial = new THREE.LineBasicMaterial({ color: 0x4c596f, transparent: true, opacity: 0.68 });
  const cagePositions: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    const x = Math.cos(angle) * 0.62;
    const z = Math.sin(angle) * 0.62;
    cagePositions.push(x, 0.05, z, x, 1.18, z);
  }
  const cageGeometry = new THREE.BufferGeometry();
  cageGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cagePositions, 3));
  silenceCage.add(new THREE.LineSegments(cageGeometry, cageMaterial));
  const top = runeLoop(0.62, 0x4c596f, 32);
  top.position.y = 1.18;
  silenceCage.add(top);
  silenceCage.visible = false;
  root.add(silenceCage);
  return { root, casterCrystal, rageRings, silenceCage };
}

function createTargetDummy(): {
  target: THREE.Group;
  core: THREE.Group;
  burningAura: THREE.Group;
} {
  const target = new THREE.Group();
  target.name = 'ability-lab-target-dummy';
  target.position.set(0, 0, -1.5);

  const base = outlined(new THREE.CylinderGeometry(0.72, 0.82, 0.24, 12), 0xd9c7a5);
  base.position.y = 0.12;
  target.add(base);
  const post = outlined(new THREE.CylinderGeometry(0.12, 0.16, 1.45, 8), 0xb58c63);
  post.position.y = 0.95;
  target.add(post);
  const shoulder = outlined(new THREE.BoxGeometry(1.35, 0.13, 0.13), 0xb58c63);
  shoulder.position.y = 1.32;
  target.add(shoulder);

  const core = new THREE.Group();
  core.name = 'ability-lab-target-core';
  core.position.set(0, 1.72, 0);
  const coreShell = outlined(new THREE.IcosahedronGeometry(0.5, 1), 0xe0c6a4, 18);
  core.add(coreShell);
  for (const radius of [0.34, 0.48]) {
    const loop = runeLoop(radius, 0x8e5f47, 30);
    loop.rotation.x = Math.PI / 2;
    loop.position.z = 0.51;
    core.add(loop);
  }
  target.add(core);

  for (const side of [-1, 1]) {
    const arm = outlined(new THREE.CylinderGeometry(0.09, 0.09, 0.72, 8), 0xc8a77d);
    arm.position.set(side * 0.62, 0.94, 0);
    arm.rotation.z = side * 0.22;
    target.add(arm);
  }

  const burningAura = new THREE.Group();
  burningAura.name = 'ability-lab-burning-aura';
  const flameMaterial = new THREE.MeshBasicMaterial({
    color: 0xd97843,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  for (let index = 0; index < 9; index += 1) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.34, 6), flameMaterial);
    const angle = index / 9 * Math.PI * 2;
    const baseY = 0.42 + (index % 3) * 0.25;
    flame.position.set(Math.cos(angle) * 0.58, baseY, Math.sin(angle) * 0.58);
    flame.userData.phase = index / 9;
    flame.userData.baseY = baseY;
    burningAura.add(flame);
  }
  burningAura.visible = false;
  target.add(burningAura);
  return { target, core, burningAura };
}

function createLabProps(): THREE.Group {
  const root = new THREE.Group();
  const plaque = outlined(new THREE.BoxGeometry(3.8, 0.12, 1.1), PAPER);
  plaque.position.set(0, 0.07, -3.6);
  root.add(plaque);

  for (const side of [-1, 1]) {
    const obelisk = outlined(new THREE.CylinderGeometry(0.22, 0.36, 1.7, 6), 0xd8cfb9);
    obelisk.position.set(side * 2.1, 0.85, -1.5);
    root.add(obelisk);
    const crystal = outlined(new THREE.OctahedronGeometry(0.3), side < 0 ? 0xc9bad9 : 0xe8b58f, 1);
    crystal.position.set(side * 2.1, 1.92, -1.5);
    crystal.scale.y = 1.35;
    crystal.name = 'ability-lab-floating-crystal';
    root.add(crystal);
  }
  return root;
}

export function createAbilityLabModel(): AbilityLabModel {
  const root = new THREE.Group();
  root.name = 'ability-lab-visual-root';
  root.add(createLabProps());

  const caster = createCasterRune();
  root.add(caster.root);
  const dummy = createTargetDummy();
  root.add(dummy.target);
  const projectileLayer = new THREE.Group();
  projectileLayer.name = 'ability-lab-projectiles';
  root.add(projectileLayer);

  return {
    root,
    casterRune: caster.root,
    casterCrystal: caster.casterCrystal,
    rageRings: caster.rageRings,
    silenceCage: caster.silenceCage,
    target: dummy.target,
    targetCore: dummy.core,
    burningAura: dummy.burningAura,
    projectileLayer,
    targetPoint: new THREE.Vector3(0, 1.72, -1.5),
    casterAnchor: caster.root,
    targetAnchor: dummy.target,
    targetBody: dummy.target,
    burnMarker: dummy.burningAura,
    rageMarker: caster.rageRings,
    silenceMarker: caster.silenceCage,
  };
}

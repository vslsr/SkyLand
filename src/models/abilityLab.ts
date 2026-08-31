import * as THREE from 'three';
import { createOutlinedObject } from './outlinedObject';

export interface AbilityLabModel {
  readonly root: THREE.Group;
  readonly casterRune: THREE.Group;
  readonly casterCrystal: THREE.Group;
  readonly rageRings: THREE.Group;
  readonly silenceCage: THREE.Group;
  readonly projectileLayer: THREE.Group;
}

const INK = 0x26221f;

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

export function createAbilityLabModel(): AbilityLabModel {
  const root = new THREE.Group();
  root.name = 'ability-lab-effects-root';

  const caster = createCasterRune();
  root.add(caster.root);
  const projectileLayer = new THREE.Group();
  projectileLayer.name = 'ability-lab-projectiles';
  root.add(projectileLayer);

  return {
    root,
    casterRune: caster.root,
    casterCrystal: caster.casterCrystal,
    rageRings: caster.rageRings,
    silenceCage: caster.silenceCage,
    projectileLayer,
  };
}

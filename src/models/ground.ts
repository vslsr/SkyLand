import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import { createOutlinedObject } from './outlinedObject';

const GROUND_WIDTH = 34;
const GROUND_DEPTH = 34;
const GROUND_CENTER_Z = -5;

function createGroundGrid(): THREE.LineSegments {
  const positions: number[] = [];
  const halfWidth = GROUND_WIDTH / 2;
  const halfDepth = GROUND_DEPTH / 2;
  const spacing = 2;

  for (let x = -halfWidth + spacing; x < halfWidth; x += spacing) {
    positions.push(x, 0.012, -halfDepth, x, 0.012, halfDepth);
  }
  for (let z = -halfDepth + spacing; z < halfDepth; z += spacing) {
    positions.push(-halfWidth, 0.012, z, halfWidth, 0.012, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, GROUND_GRID_MATERIAL);
}

export function createGroundModel(): THREE.Group {
  const ground = new THREE.Group();
  ground.position.z = GROUND_CENTER_Z;

  const planeGeometry = new THREE.PlaneGeometry(GROUND_WIDTH, GROUND_DEPTH);
  const plane = createOutlinedObject(planeGeometry, createFillMaterial(0xf1eddf));
  plane.rotation.x = -Math.PI / 2;
  ground.add(plane);
  ground.add(createGroundGrid());
  return ground;
}

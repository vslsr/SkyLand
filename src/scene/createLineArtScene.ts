import * as THREE from 'three';
import { createGrassField } from '../models/grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';

const PAPER_COLOR = 0xfdfbf6;

export function createLineArtScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER_COLOR);
  scene.fog = new THREE.Fog(PAPER_COLOR, 22, 52);
  scene.add(createGroundModel());
  scene.add(createTreeField());
  scene.add(createGrassField());
  return scene;
}

import * as THREE from 'three';
import { createGrassField } from '../models/grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';

export function createLineArtScene(definition: SceneDefinition): THREE.Scene {
  const { renderer } = definition;
  const environment = {
    fogColor: renderer.fog.color,
    fogNear: renderer.fog.near,
    fogFar: renderer.fog.far,
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(renderer.background);
  scene.fog = new THREE.Fog(renderer.fog.color, renderer.fog.near, renderer.fog.far);
  if (renderer.content.ground) scene.add(createGroundModel(renderer.palette.ground, environment));
  if (renderer.content.trees) {
    scene.add(createTreeField(
      { trunk: renderer.palette.treeTrunk, needles: renderer.palette.treeNeedles },
      environment,
    ));
  }
  if (renderer.content.grass) scene.add(createGrassField(renderer.palette.grass, environment));
  return scene;
}

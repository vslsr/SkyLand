import * as THREE from 'three';
import { ClientActorSystem } from '../actors/ClientActorSystem';
import { GrassFieldSystem, type GrassInteractionTarget } from '../grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import { OceanSystem } from '../ocean/OceanSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { SceneComposition, SceneVisualSystem } from './SceneVisualSystem';

export function createLineArtScene(definition: SceneDefinition): SceneComposition {
  const { renderer } = definition;
  const environment = {
    fogColor: renderer.fog.color,
    fogNear: renderer.fog.near,
    fogFar: renderer.fog.far,
  };
  const scene = new THREE.Scene();
  const visualSystems: SceneVisualSystem[] = [];
  let grassInteraction: GrassInteractionTarget | undefined;
  let actorSnapshotTarget: ClientActorSystem | undefined;
  scene.background = new THREE.Color(renderer.background);
  scene.fog = new THREE.Fog(renderer.fog.color, renderer.fog.near, renderer.fog.far);
  if (renderer.content.ground) scene.add(createGroundModel(renderer.palette.ground, environment));
  if (renderer.content.trees) {
    scene.add(createTreeField(
      { trunk: renderer.palette.treeTrunk, needles: renderer.palette.treeNeedles },
      environment,
    ));
  }
  if (renderer.content.grass) {
    const grass = new GrassFieldSystem({
      bounds: definition.gameplay.bounds,
      color: renderer.palette.grass,
      environment,
    });
    scene.add(grass.root);
    visualSystems.push(grass);
    grassInteraction = grass.interaction;
  }
  if (renderer.content.ocean) {
    if (!renderer.ocean || !definition.gameplay.water) {
      throw new Error(`水域场景 ${definition.id} 缺少 ocean 或 gameplay.water 配置`);
    }
    const ocean = new OceanSystem({
      definition: renderer.ocean,
      seaLevel: definition.gameplay.water.seaLevel,
      environment,
    });
    scene.add(ocean.root);
    visualSystems.push(ocean);
  }
  if (definition.actors.length > 0) {
    const actors = new ClientActorSystem({ definition, environment });
    scene.add(actors.root);
    visualSystems.push(actors);
    actorSnapshotTarget = actors;
  }
  return { scene, visualSystems, grassInteraction, actorSnapshotTarget };
}

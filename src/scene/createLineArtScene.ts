import * as THREE from 'three';
import { createGrassField } from '../models/grass';
import { createGroundModel } from '../models/ground';
import { createTreeField } from '../models/tree';
import { OceanSystem } from '../ocean/OceanSystem';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { ChunkStreamer } from '../world';
import type { SceneComposition, SceneVisualSystem } from './SceneVisualSystem';

export function createLineArtScene(
  definition: SceneDefinition,
  worldSeed?: number,
): SceneComposition {
  const { renderer } = definition;
  const environment = {
    fogColor: renderer.fog.color,
    fogNear: renderer.fog.near,
    fogFar: renderer.fog.far,
  };
  const scene = new THREE.Scene();
  const visualSystems: SceneVisualSystem[] = [];
  scene.background = new THREE.Color(renderer.background);
  scene.fog = new THREE.Fog(renderer.fog.color, renderer.fog.near, renderer.fog.far);

  if (renderer.world) {
    // 流式世界接管地面、树与草：内容由世界种子推导，随焦点进出，
    // 所以这里不再摆任何固定物件，content 的开关改为决定 chunk 里放什么。
    const streamer = new ChunkStreamer({
      world: renderer.world,
      worldSeed,
      environment,
      templates: {
        content: renderer.content,
        environment,
        palette: {
          ground: renderer.palette.ground,
          grass: renderer.palette.grass,
          treeTrunk: renderer.palette.treeTrunk,
          treeNeedles: renderer.palette.treeNeedles,
          rock: renderer.world.rockColor,
        },
      },
    });
    scene.add(streamer.root);
    visualSystems.push(streamer);
  } else {
    if (renderer.content.ground) scene.add(createGroundModel(renderer.palette.ground, environment));
    if (renderer.content.trees) {
      scene.add(createTreeField(
        { trunk: renderer.palette.treeTrunk, needles: renderer.palette.treeNeedles },
        environment,
      ));
    }
    if (renderer.content.grass) scene.add(createGrassField(renderer.palette.grass, environment));
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

  return { scene, visualSystems };
}

import * as THREE from 'three';
import {
  createContactShadowMaterial,
  type ContactShadowMaterial,
} from '../materials/createContactShadowMaterial';
import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';
import type { ActorVisualModel } from './actors/ActorVisualModel';
import {
  createSlimeSoftBody,
  type SlimePalette,
  type SlimeSoftBody,
} from './slimeSoftBody';

export {
  LOCAL_SLIME_PALETTE,
  createSlimePalette,
  type SlimeBubble,
  type SlimeColor,
  type SlimePalette,
} from './slimeSoftBody';

export type PlayerSlimeRenderDefinition = Extract<
  ActorRenderDefinition,
  { model: 'line-art-player-slime' }
>;

export interface PlayerSlimeModel extends ActorVisualModel, SlimeSoftBody {
  shadow: THREE.Mesh<THREE.CircleGeometry, ContactShadowMaterial>;
}

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

export function createPlayerSlimeModel(
  definition: PlayerSlimeRenderDefinition,
  palette: SlimePalette = createConfiguredPalette(definition),
): PlayerSlimeModel {
  const radius = definition.radius;
  const root = new THREE.Group();
  root.name = 'player-slime';
  const visualRoot = new THREE.Group();
  visualRoot.name = 'player-slime-visual';
  root.add(visualRoot);

  const softBody = createSlimeSoftBody(radius, palette);
  visualRoot.add(softBody.body);

  // 影子的方向、长度和浓度跟着房间权威时刻走，见 createContactShadowMaterial。
  const shadowMaterial = createContactShadowMaterial(palette.shadow, { opacity: 0.16 });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.8, 24), shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  visualRoot.add(shadow);

  return {
    root,
    visualRoot,
    ...softBody,
    shadow,
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

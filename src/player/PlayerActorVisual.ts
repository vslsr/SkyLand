import type * as THREE from 'three';
import { HybridSlimeVisualComponent } from '../actors/components/HybridSlimeVisualComponent';
import type { ActorVisualModel } from '../models/actors/ActorVisualModel';
import { createPbfSlimeModel } from '../models/actors/createPbfSlimeModel';
import {
  createPlayerSlimeModel,
  type SlimePalette,
} from '../models/playerSlime';
import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';
import { SlimeAnimator } from './SlimeAnimator';

export type PlayerActorRenderDefinition = Extract<
  ActorRenderDefinition,
  { model: 'line-art-player-slime' | 'line-art-pbf-slime' }
>;

export interface PlayerActorVisual {
  readonly model: ActorVisualModel;
  readonly radius: number;
  readonly collisionRadius: number;
  readonly collisionHeight: number;
  /** 混合软体仍作为 Actor Component 挂载，玩家与普通 Actor 共用表现实现。 */
  readonly component?: HybridSlimeVisualComponent;
  update(
    deltaSeconds: number,
    elapsedSeconds: number,
    movementSpeed: number,
    authorityYaw?: number,
    motion?: {
      velocityX: number;
      velocityZ: number;
      collisionDisplacement?: { x: number; z: number };
    },
  ): void;
  dispose(): void;
}

export function isPlayerActorRenderDefinition(
  definition: ActorRenderDefinition | undefined,
): definition is PlayerActorRenderDefinition {
  return definition?.model === 'line-art-player-slime'
    || definition?.model === 'line-art-pbf-slime';
}

function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const renderable = object as Partial<THREE.Mesh>;
    renderable.geometry?.dispose();
    const material = renderable.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
}

/** 为本地预测玩家和远端插值玩家创建同一种可配置史莱姆表现。 */
export function createPlayerActorVisual(
  _playerId: string,
  definition: PlayerActorRenderDefinition,
  walkSpeed: number,
  palette?: SlimePalette,
): PlayerActorVisual {
  if (definition.model === 'line-art-player-slime') {
    const model = createPlayerSlimeModel(definition, palette);
    const animator = new SlimeAnimator(model, walkSpeed);
    return {
      model,
      radius: definition.radius,
      collisionRadius: definition.radius,
      collisionHeight: definition.radius * 2,
      update: (deltaSeconds, elapsedSeconds, movementSpeed) => {
        animator.update(deltaSeconds, elapsedSeconds, movementSpeed);
      },
      dispose: () => disposeSubtree(model.root),
    };
  }

  const model = createPbfSlimeModel(definition);
  const rig = model.pbfSlimeVisualRig;
  if (!rig) throw new Error('混合软体玩家史莱姆缺少 VisualRig');
  const component = new HybridSlimeVisualComponent(rig, definition);
  return {
    model,
    radius: definition.radius,
    collisionRadius: definition.collisionRadius,
    collisionHeight: definition.collisionHeight,
    component,
    update: (deltaSeconds, elapsedSeconds, movementSpeed, authorityYaw, motion) => component.update(
      deltaSeconds,
      elapsedSeconds,
      Number.isFinite(authorityYaw)
        ? {
            authorityYaw: authorityYaw as number,
            movementSpeed,
            movementVelocityX: motion?.velocityX,
            movementVelocityZ: motion?.velocityZ,
            collisionDisplacementX: motion?.collisionDisplacement?.x,
            collisionDisplacementZ: motion?.collisionDisplacement?.z,
          }
        : undefined,
    ),
    dispose: () => disposeSubtree(model.root),
  };
}

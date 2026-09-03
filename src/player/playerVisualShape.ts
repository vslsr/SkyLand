import { leggedSlimeTopY } from '../../shared/actor/leggedSlimeShape.mjs';
import { modelHasTrait } from '../../shared/actor/models/index.mjs';
import type { PlayerRenderDefinition } from '../render/RenderScene';
import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';

/**
 * 玩家实体从渲染定义里需要的几个数值。
 *
 * 这里以前是 `createPlayerActorVisual()`——它顺手把模型也建了出来，于是
 * `PlayerEntity` 和 `RemotePlayer` 各自握着一棵 `Object3D` 子树，完全绕开了
 * `ThreeRenderScene`。模型现在由 `RenderScene.createPlayerProxy` 建，
 * 玩法侧只剩下这三个标量：碰撞胶囊尺寸和踩草半径。
 */
export interface PlayerVisualShape {
  readonly radius: number;
  readonly collisionRadius: number;
  readonly collisionHeight: number;
}

export function isPlayerRenderDefinition(
  definition: ActorRenderDefinition | undefined,
): definition is PlayerRenderDefinition {
  return modelHasTrait(definition?.model, 'playerShell');
}

export function resolvePlayerVisualShape(
  definition: PlayerRenderDefinition,
): PlayerVisualShape {
  if (definition.model === 'line-art-player-slime') {
    return {
      radius: definition.radius,
      collisionRadius: definition.radius,
      collisionHeight: definition.radius * 2,
    };
  }
  if (definition.model === 'line-art-legged-slime') {
    return {
      radius: definition.radius,
      // 腿不参与碰撞：权威圆柱从地面一直包到身体顶部，两根细杆只是表现。
      collisionRadius: definition.radius,
      collisionHeight: leggedSlimeTopY(definition.hipHeight, definition.radius),
    };
  }
  return {
    radius: definition.radius,
    collisionRadius: definition.collisionRadius,
    collisionHeight: definition.collisionHeight,
  };
}

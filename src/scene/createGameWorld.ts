import { ClientActorSystem } from '../actors/ClientActorSystem';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { DEFAULT_WORLD_SEED, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkStreamer, TerrainWorld } from '../world';
import type { ChunkViewSink } from '../world/ChunkViewHost';
import type { RenderScene } from '../render/RenderScene';
import type { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import type { SceneComposition, SceneFrameSystem } from './SceneVisualSystem';

/**
 * 渲染世界递过来的三个口子。**只有这三样**跨这条缝，而且都是单向的。
 *
 * 单线程下它们就是 `RenderWorldRuntime` 身上的真东西；渲染循环进 worker 之后
 * 同一组口子由 `RenderCommandQueue` 顶上，下面这个函数一个字都不用改——
 * 这正是第 3 步一路在铺的那条缝。
 */
export interface GameWorldRenderChannels {
  /** proxy 命令口。 */
  readonly scene: RenderScene;
  /** 那段边界字节。玩法侧写，渲染侧读。 */
  readonly transforms: RenderTransformBuffer;
  /** 挂载命令口。流式地图才有。 */
  readonly chunkViews?: ChunkViewSink;
}

/**
 * 一张地图的**玩法那一半**：碰撞世界、物理世界、地形采样、Actor 世界、流送规划。
 *
 * 渲染那一半在 `createRenderWorld` 里建，归 `RenderWorldRuntime`；这里只收它递过来
 * 的三个口子（`GameWorldRenderChannels`）。这个函数里**一个 `THREE` 都没有**，
 * 有棘轮盯着。
 */
export function createGameWorld(
  definition: SceneDefinition,
  worldSeed: number | undefined,
  render: GameWorldRenderChannels,
): SceneComposition {
  const { renderer } = definition;

  // 一个场景一张碰撞网格：流式 chunk 往里放静态物件，Actor 往里放动态盒子，
  // 玩家推出和相机悬臂都只查它，不需要各自再维护一份碰撞体列表。
  const collisionWorld = new CollisionWorld();
  const physicsWorld = new PhysicsWorld(getRapier());
  const terrainWorld = renderer.world
    ? new TerrainWorld(
        toWorldSeed(worldSeed ?? DEFAULT_WORLD_SEED),
        definition.gameplay.water?.seaLevel ?? 0,
      )
    : undefined;

  const gameSystems: SceneFrameSystem[] = [];
  // Actor 世界总是建，哪怕这张地图一个 Actor 都没有：**渲染世界那次翻面归它管**
  // （`RenderTransformSyncSystem` 夹在写入与依赖翻面结果的表现 System 之间），
  // 而本地玩家的 proxy 现在也在同一段 SoA 里。按「有没有 Actor」建它，
  // 会让没有 Actor 的地图上玩家整个不动。空的 ActorWorld 每帧什么都不做。
  const actorSnapshotTarget = new ClientActorSystem({
    definition,
    collision: collisionWorld,
    physics: physicsWorld,
    worldSeed,
    renderScene: render.scene,
    transforms: render.transforms,
    // 长腿 Actor 的落脚采样。没有地形世界的固定地图不传，腿退回自己脚下的平面。
    sampleGroundHeight: terrainWorld
      ? (x, z) => terrainWorld.sampleGroundHeight(x, z)
      : undefined,
  });

  if (renderer.world && render.chunkViews) {
    const streamer = new ChunkStreamer({
      world: renderer.world,
      views: render.chunkViews,
      worldSeed,
      seaLevel: definition.gameplay.water?.seaLevel,
      terrainPatches: terrainWorld?.patches,
      collision: collisionWorld,
      physics: physicsWorld,
      onChunkMounted: (key, chunkX, chunkZ, props, propCount) => {
        actorSnapshotTarget.mountGeneratedPropChunk(key, chunkX, chunkZ, props, propCount);
      },
      onChunkUnmounted: (key) => actorSnapshotTarget.unmountGeneratedPropChunk(key),
    });
    // 服务端说某个物件被砍掉了 → 重建那一块 chunk。两条线都在玩法侧，
    // 只是接头在这里。
    actorSnapshotTarget.setGeneratedPropOverrideTarget(
      (chunkX, chunkZ, propIndex, removed) => {
        streamer.setPropSkipped(chunkX, chunkZ, propIndex, removed);
      },
    );
    gameSystems.push(streamer);
  } else if (renderer.content.ground) {
    // 固定地图的地面在物理世界里是一整块盒子；它的可视几何在渲染那一半。
    const bounds = definition.gameplay.bounds;
    physicsWorld.setActorCollider('__fixed-ground', {
      shape: 'box',
      halfWidth: (bounds.maximumX - bounds.minimumX) * 0.5,
      halfLength: (bounds.maximumZ - bounds.minimumZ) * 0.5,
      minimumY: -0.2,
      maximumY: 0,
      x: (bounds.minimumX + bounds.maximumX) * 0.5,
      y: 0,
      z: (bounds.minimumZ + bounds.maximumZ) * 0.5,
      yaw: 0,
    });
    physicsWorld.step();
  }

  // Actor 世界这一项同时驱动渲染世界的那一帧（翻面、兑现、表现动画）——
  // 见 `ClientActorSystem.dispose` 上的注释。所以它排在最后。
  gameSystems.push(actorSnapshotTarget);

  return {
    visualSystems: gameSystems,
    actorSnapshotTarget,
    renderScene: render.scene,
    renderTransforms: render.transforms,
    // 槽位表由 ClientActorSystem 建（它是唯一知道渲染世界什么时候就位的那一个），
    // 从这里递给玩家实体——两边必须是同一张。
    renderProxyIds: actorSnapshotTarget.renderProxyIds,
    collisionWorld,
    terrainWorld,
    physicsWorld,
  };
}

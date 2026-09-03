import { ClientActorSystem } from '../actors/ClientActorSystem';
import { CollisionWorld } from '../../shared/collision/index.mjs';
import { getRapier, PhysicsWorld } from '../../shared/physics/index.mjs';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { DEFAULT_WORLD_SEED, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkStreamer, TerrainWorld } from '../world';
import { createRenderWorld } from './createRenderWorld';
import type { SceneComposition, SceneFrameSystem } from './SceneVisualSystem';

/**
 * 一张地图的两半，以及把它们接起来的那几根线。
 *
 * 渲染那一半整个在 `createRenderWorld` 里建——它只吃场景定义和世界种子。
 * 这里建的是**玩法那一半**：碰撞世界、物理世界、地形采样、Actor 世界、流送规划。
 *
 * 两半之间只有三样东西过去：`renderScene`（proxy 命令口）、`chunkViews`
 * （挂载命令口）、`transforms`（那段边界字节）。**没有一样是反向的**——
 * 除了签名上写明的那一个 `sampleGroundHeight`（见 `createRenderWorld`）。
 *
 * 这个分法就是第 3 步要的那条缝：把 `createRenderWorld` 换成「在 worker 里建，
 * 回传三个命令口」，这个函数一个字都不用改。
 */
export function createLineArtScene(
  definition: SceneDefinition,
  worldSeed?: number,
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

  // --- 渲染那一半。它只吃场景定义和世界种子；地形它自己按同一个种子建一份 ---
  const render = createRenderWorld(definition, worldSeed);

  // --- 玩法那一半的其余部分 ---
  const gameSystems: SceneFrameSystem[] = [];
  // Actor 世界总是建，哪怕这张地图一个 Actor 都没有：**渲染世界那次翻面归它管**
  // （`RenderTransformSyncSystem` 夹在写入与依赖翻面结果的表现 System 之间），
  // 而本地玩家的 proxy 现在也在同一段 SoA 里。按「有没有 Actor」建它，
  // 会让没有 Actor 的地图上玩家整个不动。空的 ActorWorld 每帧什么都不做。
  const actorSnapshotTarget = new ClientActorSystem({
    definition,
    environment: render.environment,
    collision: collisionWorld,
    physics: physicsWorld,
    worldSeed,
    renderScene: render.renderScene,
    transforms: render.transforms,
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
    scene: render.scene,
    // 顺序照旧：渲染侧的昼夜/天气/地表在前，玩法侧的流送与 Actor 在后。
    visualSystems: [...render.visualSystems, ...gameSystems],
    weatherTarget: render.weatherTarget,
    dayNightTarget: render.dayNightTarget,
    environmentRuntime: render.environment.runtime,
    grassInteraction: render.grassInteraction,
    actorSnapshotTarget,
    renderScene: render.renderScene,
    renderTransforms: render.transforms,
    // 槽位表由 ClientActorSystem 建（它是唯一知道渲染世界什么时候就位的那一个），
    // 从这里递给玩家实体——两边必须是同一张。
    renderProxyIds: actorSnapshotTarget.renderProxyIds,
    collisionWorld,
    terrainWorld,
    physicsWorld,
    // 服务端确认过的地形编辑要写两份：玩法侧那份决定脚下踩到什么，
    // 渲染侧那份决定雨落在多高。
    setRenderTerrainCells: render.setTerrainCells,
    setRenderSceneActive: render.setSceneActive,
  };
}

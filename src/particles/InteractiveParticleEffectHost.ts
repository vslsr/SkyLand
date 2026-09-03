import * as THREE from 'three';
import { ActorWorld } from '../../shared/actor/ActorWorld.mjs';
import { toChunkCoordinate } from '../../shared/world/chunkKey.mjs';
import { planChunkStream } from '../../shared/world/chunkStream.mjs';
import {
  CHUNK_BUILD_BUDGET_PER_FRAME,
  DEFAULT_WORLD_SEED,
  toWorldSeed,
} from '../../shared/world/worldConfig.mjs';
import { InteractiveParticleEffectActor } from '../actors/InteractiveParticleEffectActor';
import { InteractiveParticleEffectSystem } from '../actors/systems/InteractiveParticleEffectSystem';
import { LineArtLeafParticleEffect } from './LineArtLeafParticleEffect';
import { generateInteractiveParticleWorldPoint } from './interactiveParticleWorld';
import type {
  InteractiveParticleSceneComponentDefinition,
} from '../scenes/data/SceneDefinition';
import type { SceneEnvironmentRuntime } from '../materials/createFillMaterial';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { SceneFrameSystem, SceneUpdateContext } from '../scene/SceneVisualSystem';

/**
 * 这个组件在**渲染世界**里跑要的全部东西（引擎迁移路线图 第 3 步）。
 *
 * 它原来吃 `SceneComponentContext`——里面有主线程的渲染器、玩法侧的 `SceneWorld`、
 * 还有玩家实体。落叶是纯表现，那些依赖里没有一样是它真正需要的**身份**，
 * 需要的只是几个数和一块地形。
 */
export interface InteractiveParticleEffectHostOptions {
  readonly sceneDefinition: SceneDefinition;
  readonly worldSeed?: number;
  readonly environmentRuntime?: SceneEnvironmentRuntime;
  /** 挂到渲染世界自己的根下，不再经由 `renderer.addWorldObject`。 */
  readonly root: THREE.Object3D;
  /**
   * 渲染世界自己那一份地形。落叶要贴地、要避开水面，编辑之后要重新贴。
   * 它和玩法侧那一份按同一个种子推，编辑经命令镜像过来。
   */
  readonly terrain?: {
    isWaterAt(x: number, z: number): boolean;
    sampleSurfaceHeight(x: number, z: number): number;
    onTerrainChanged(listener: () => void): () => void;
  };
}

const MIN_INTERACTION_TRAVEL = 0.000_1;
const TELEPORT_DISTANCE_RADIUS_RATIO = 5;
const REFERENCE_MOVE_SPEED = 6;
const FIXED_CLUSTER_KEY = 'fixed';

interface ParticleCluster {
  actor: InteractiveParticleEffectActor;
  centerX: number;
  centerZ: number;
}

interface PendingChunk {
  chunkX: number;
  chunkZ: number;
  key: string;
}

/**
 * 从场景配置创建客户端本地粒子 Actor。固定场景只创建一个；流式世界仅保留
 * keepRadius 内 chunk 的确定性落叶团，因此资源上界不随世界面积增长。
 *
 * **它住在渲染世界里**（引擎迁移路线图 第 3 步）。它曾经是一个主线程场景组件，
 * 靠 `renderer.addWorldObject` 把自己建的 `Object3D` 塞进场景图——渲染循环进线程
 * 之后那条路就断了。落叶是纯表现，它要的只是几个数和一块地形，所以整个搬过来，
 * 由 `createRenderWorld` 建、挂在渲染世界自己的根下。
 */
export class InteractiveParticleEffectHost implements SceneFrameSystem {
  private readonly world = new ActorWorld();
  private readonly clusters = new Map<string, ParticleCluster>();
  private readonly residentChunkKeys = new Set<string>();
  private readonly playerPosition = new THREE.Vector3();
  private readonly previousPlayerPosition = new THREE.Vector3();
  private pendingChunks: PendingChunk[] = [];
  private centerChunkX?: number;
  private centerChunkZ?: number;
  private hasPreviousPlayerPosition = false;
  private active = false;
  private unsubscribeTerrain?: () => void;

  public constructor(
    private readonly definition: InteractiveParticleSceneComponentDefinition,
    private readonly deps: InteractiveParticleEffectHostOptions,
  ) {
    this.world.addSystem(new InteractiveParticleEffectSystem());
    if ('position' in definition && definition.position) {
      this.mountCluster(FIXED_CLUSTER_KEY, definition.position, definition.seed);
    }
  }

  public activate(): void {
    if (this.active) return;
    this.active = true;
    for (const cluster of this.clusters.values()) {
      this.deps.root.add(cluster.actor.object3D);
    }
    // 停用期间的地形改写没有通知到，重新接管时先把常驻落叶团贴回地表。
    this.refreshClusterSurfaces();
    this.unsubscribeTerrain = this.deps.terrain?.onTerrainChanged(
      () => this.refreshClusterSurfaces(),
    );
    this.resetPlayerSweep();
  }

  public deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.unsubscribeTerrain?.();
    this.unsubscribeTerrain = undefined;
    for (const cluster of this.clusters.values()) {
      this.deps.root.remove(cluster.actor.object3D);
    }
    this.hasPreviousPlayerPosition = false;
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    this.updateWorldClusters(context);
    this.applyPlayerInteraction(deltaSeconds, context);
    this.world.update(deltaSeconds, elapsedSeconds);
  }

  public dispose(): void {
    this.deactivate();
    this.pendingChunks = [];
    this.clusters.clear();
    this.residentChunkKeys.clear();
    this.world.dispose();
  }

  private updateWorldClusters(focus?: SceneUpdateContext): void {
    const generation = this.definition.worldGeneration;
    const worldDefinition = this.deps.sceneDefinition.renderer.world;
    if (!generation || !worldDefinition || !focus) return;

    const centerChunkX = toChunkCoordinate(focus.focusX);
    const centerChunkZ = toChunkCoordinate(focus.focusZ);
    if (centerChunkX !== this.centerChunkX || centerChunkZ !== this.centerChunkZ) {
      this.centerChunkX = centerChunkX;
      this.centerChunkZ = centerChunkZ;
      const plan = planChunkStream({
        focusX: focus.focusX,
        focusZ: focus.focusZ,
        loadedKeys: this.residentChunkKeys,
        loadRadius: worldDefinition.loadRadius,
        keepRadius: worldDefinition.keepRadius,
      });
      for (const key of plan.unload) {
        this.residentChunkKeys.delete(key);
        this.unmountCluster(key);
      }
      this.pendingChunks = plan.load;
    }

    let budget = CHUNK_BUILD_BUDGET_PER_FRAME;
    while (budget > 0) {
      const chunk = this.pendingChunks.shift();
      if (!chunk) break;
      if (this.residentChunkKeys.has(chunk.key)) continue;
      this.mountGeneratedChunk(chunk, generation.spawnChance);
      this.residentChunkKeys.add(chunk.key);
      budget -= 1;
    }
  }

  private mountGeneratedChunk(chunk: PendingChunk, spawnChance: number): void {
    const point = generateInteractiveParticleWorldPoint(
      toWorldSeed(this.deps.worldSeed ?? DEFAULT_WORLD_SEED),
      this.definition.seed,
      chunk.chunkX,
      chunk.chunkZ,
      spawnChance,
      this.definition.clusterRadius,
    );
    const terrain = this.deps.terrain;
    if (!point || terrain?.isWaterAt(point.x, point.z)) return;
    this.mountCluster(
      chunk.key,
      [point.x, terrain?.sampleSurfaceHeight(point.x, point.z) ?? 0, point.z],
      point.particleSeed,
    );
  }

  private mountCluster(
    key: string,
    position: readonly [number, number, number],
    particleSeed: number,
  ): void {
    const effect = createEffect(this.definition, this.deps, particleSeed, position);
    effect.root.name = `particle-actor-${this.definition.id}-${key}`;
    const actor = new InteractiveParticleEffectActor(`${this.definition.id}-${key}`, effect);
    this.world.addActor(actor);
    this.clusters.set(key, {
      actor,
      centerX: position[0],
      centerZ: position[2],
    });
    if (this.active) this.deps.root.add(actor.object3D);
  }

  private unmountCluster(key: string): void {
    const cluster = this.clusters.get(key);
    if (!cluster) return;
    this.clusters.delete(key);
    if (this.active) this.deps.root.remove(cluster.actor.object3D);
    this.world.removeActor(cluster.actor.id);
  }

  /**
   * 地形被改写后让常驻落叶团重新贴地。扫的是 keepRadius 窗口里的落叶团，
   * 每团又只有固定数量的叶片，所以代价不随世界面积增长。
   */
  private refreshClusterSurfaces(): void {
    for (const cluster of this.clusters.values()) cluster.actor.refreshSurfaceHeights();
  }

  /**
   * 玩家扫过落叶。
   *
   * 位置从每帧的 `SceneUpdateContext` 来，不再握着玩家实体——它要的只是一个坐标。
   * 用的是**渲染位置**（含插值平滑）而不是权威位置：叶片跟的是眼睛看到的那个身影。
   */
  private applyPlayerInteraction(deltaSeconds: number, context?: SceneUpdateContext): void {
    if (context?.playerRenderX === undefined) return;
    this.playerPosition.set(
      context.playerRenderX,
      context.playerRenderY ?? 0,
      context.playerRenderZ ?? 0,
    );
    if (!this.hasPreviousPlayerPosition) {
      this.previousPlayerPosition.copy(this.playerPosition);
      this.hasPreviousPlayerPosition = true;
      return;
    }

    const travelDistance = this.playerPosition.distanceTo(this.previousPlayerPosition);
    const teleported = travelDistance > (
      this.definition.interactionRadius * TELEPORT_DISTANCE_RADIUS_RATIO
    );
    if (
      !teleported
      && travelDistance > MIN_INTERACTION_TRAVEL
      && Number.isFinite(deltaSeconds)
      && deltaSeconds > 0
    ) {
      const speed = travelDistance / deltaSeconds;
      const speedScale = THREE.MathUtils.clamp(speed / REFERENCE_MOVE_SPEED, 0.25, 1.4);
      for (const cluster of this.clusters.values()) {
        if (!this.sweepCanReachCluster(cluster)) continue;
        cluster.actor.applyWorldImpulse({
          startPosition: this.previousPlayerPosition,
          position: this.playerPosition,
          radius: this.definition.interactionRadius,
          strength: this.definition.impulseStrength * speedScale,
        });
      }
    }
    this.previousPlayerPosition.copy(this.playerPosition);
  }

  private sweepCanReachCluster(cluster: ParticleCluster): boolean {
    const segmentX = this.playerPosition.x - this.previousPlayerPosition.x;
    const segmentZ = this.playerPosition.z - this.previousPlayerPosition.z;
    const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
    const projection = segmentLengthSq > 0
      ? THREE.MathUtils.clamp(
          ((cluster.centerX - this.previousPlayerPosition.x) * segmentX
            + (cluster.centerZ - this.previousPlayerPosition.z) * segmentZ) / segmentLengthSq,
          0,
          1,
        )
      : 0;
    const closestX = this.previousPlayerPosition.x + segmentX * projection;
    const closestZ = this.previousPlayerPosition.z + segmentZ * projection;
    const maximumDistance = this.definition.clusterRadius + this.definition.interactionRadius;
    return (
      (cluster.centerX - closestX) ** 2 + (cluster.centerZ - closestZ) ** 2
      <= maximumDistance * maximumDistance
    );
  }

  private resetPlayerSweep(): void {
    // 重新接管时先忘掉上一次的落点：中间可能传送过，不该按那段位移扫一遍。
    this.hasPreviousPlayerPosition = false;
  }
}

function createEffect(
  definition: InteractiveParticleSceneComponentDefinition,
  deps: InteractiveParticleEffectHostOptions,
  particleSeed: number,
  origin: readonly [number, number, number],
): LineArtLeafParticleEffect {
  switch (definition.preset) {
    case 'line-art-leaves':
      return new LineArtLeafParticleEffect({
        particleCount: definition.particleCount,
        radius: definition.clusterRadius,
        seed: particleSeed,
        origin,
        // 逐叶片采样可见表面，台阶地形上落叶才会落到自己脚下那一格，
        // 而不是整团挂在落点中心的高度上。
        sampleSurfaceHeight: (x, z) => deps.terrain?.sampleSurfaceHeight(x, z) ?? 0,
        fillColor: definition.fillColor,
        accentColor: definition.accentColor,
        lineColor: definition.lineColor,
        environment: {
          fogColor: deps.sceneDefinition.renderer.fog.color,
          fogNear: deps.sceneDefinition.renderer.fog.near,
          fogFar: deps.sceneDefinition.renderer.fog.far,
          runtime: deps.environmentRuntime,
        },
      });
    default: {
      const unsupported: never = definition.preset;
      throw new Error(`未实现的交互粒子 preset：${String(unsupported)}`);
    }
  }
}

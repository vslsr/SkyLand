import * as THREE from 'three';
import { ActorWorld } from '../../../shared/actor/ActorWorld.mjs';
import { toChunkCoordinate } from '../../../shared/world/chunkKey.mjs';
import { planChunkStream } from '../../../shared/world/chunkStream.mjs';
import {
  CHUNK_BUILD_BUDGET_PER_FRAME,
  DEFAULT_WORLD_SEED,
  toWorldSeed,
} from '../../../shared/world/worldConfig.mjs';
import { InteractiveParticleEffectActor } from '../../actors/InteractiveParticleEffectActor';
import { InteractiveParticleEffectSystem } from '../../actors/systems/InteractiveParticleEffectSystem';
import { LineArtLeafParticleEffect } from '../../particles/LineArtLeafParticleEffect';
import { generateInteractiveParticleWorldPoint } from '../../particles/interactiveParticleWorld';
import type {
  InteractiveParticleSceneComponentDefinition,
} from '../../scenes/data/SceneDefinition';
import type { SceneComponentContext, SceneRuntimeComponent } from './SceneComponent';

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
 */
export class InteractiveParticleEffectSceneComponent implements SceneRuntimeComponent {
  public readonly type = 'interactive-particle-effect' as const;
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

  public constructor(
    private readonly definition: InteractiveParticleSceneComponentDefinition,
    private readonly context: SceneComponentContext,
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
      this.context.renderer.addWorldObject(cluster.actor.object3D);
    }
    this.resetPlayerSweep();
  }

  public deactivate(): void {
    if (!this.active) return;
    this.active = false;
    for (const cluster of this.clusters.values()) {
      this.context.renderer.removeWorldObject(cluster.actor.object3D);
    }
    this.hasPreviousPlayerPosition = false;
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.updateWorldClusters();
    this.applyPlayerInteraction(deltaSeconds);
    this.world.update(deltaSeconds, elapsedSeconds);
  }

  public dispose(): void {
    this.deactivate();
    this.pendingChunks = [];
    this.clusters.clear();
    this.residentChunkKeys.clear();
    this.world.dispose();
  }

  private updateWorldClusters(): void {
    const generation = this.definition.worldGeneration;
    const worldDefinition = this.context.definition.renderer.world;
    const focus = this.context.getFocus?.();
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
      toWorldSeed(this.context.worldSeed ?? DEFAULT_WORLD_SEED),
      this.definition.seed,
      chunk.chunkX,
      chunk.chunkZ,
      spawnChance,
      this.definition.clusterRadius,
    );
    if (!point || this.context.renderer.isWaterAt(point.x, point.z)) return;
    this.mountCluster(
      chunk.key,
      [point.x, this.context.renderer.sampleGroundHeight(point.x, point.z), point.z],
      point.particleSeed,
    );
  }

  private mountCluster(
    key: string,
    position: readonly [number, number, number],
    particleSeed: number,
  ): void {
    const effect = createEffect(this.definition, this.context, particleSeed);
    effect.root.position.set(...position);
    effect.root.name = `particle-actor-${this.definition.id}-${key}`;
    const actor = new InteractiveParticleEffectActor(`${this.definition.id}-${key}`, effect);
    this.world.addActor(actor);
    this.clusters.set(key, {
      actor,
      centerX: position[0],
      centerZ: position[2],
    });
    if (this.active) this.context.renderer.addWorldObject(actor.object3D);
  }

  private unmountCluster(key: string): void {
    const cluster = this.clusters.get(key);
    if (!cluster) return;
    this.clusters.delete(key);
    if (this.active) this.context.renderer.removeWorldObject(cluster.actor.object3D);
    this.world.removeActor(cluster.actor.id);
  }

  private applyPlayerInteraction(deltaSeconds: number): void {
    const player = this.context.player;
    if (!player) return;
    const { x, y, z } = player.renderPosition;
    this.playerPosition.set(x, y, z);
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
    const player = this.context.player;
    if (!player) {
      this.hasPreviousPlayerPosition = false;
      return;
    }
    const { x, y, z } = player.renderPosition;
    this.previousPlayerPosition.set(x, y, z);
    this.hasPreviousPlayerPosition = true;
  }
}

function createEffect(
  definition: InteractiveParticleSceneComponentDefinition,
  context: SceneComponentContext,
  particleSeed: number,
): LineArtLeafParticleEffect {
  switch (definition.preset) {
    case 'line-art-leaves':
      return new LineArtLeafParticleEffect({
        particleCount: definition.particleCount,
        radius: definition.clusterRadius,
        seed: particleSeed,
        fillColor: definition.fillColor,
        accentColor: definition.accentColor,
        lineColor: definition.lineColor,
        environment: {
          fogColor: context.definition.renderer.fog.color,
          fogNear: context.definition.renderer.fog.near,
          fogFar: context.definition.renderer.fog.far,
          runtime: context.renderer.environmentRuntime,
        },
      });
    default: {
      const unsupported: never = definition.preset;
      throw new Error(`未实现的交互粒子 preset：${String(unsupported)}`);
    }
  }
}

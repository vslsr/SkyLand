import * as THREE from 'three';
import type { ChunkGenerator } from '../../shared/world/chunkGenerator.mjs';
import { parseChunkKey, toChunkCoordinate, toChunkKey } from '../../shared/world/chunkKey.mjs';
import { planChunkStream } from '../../shared/world/chunkStream.mjs';
import { TerrainPatchStore } from '../../shared/world/terrainPatches.mjs';
import { TerrainEditor } from '../../shared/world/terrainEditing.mjs';
import { frameTimeline } from '../platform/index';
import {
  CHUNK_BUILD_BUDGET_PER_FRAME,
  DEFAULT_WORLD_SEED,
  toWorldSeed,
} from '../../shared/world/worldConfig.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { buildTerrainCollisionMesh } from '../../shared/world/terrainCollisionMesh.mjs';
import { TERRAIN_GRID } from '../../shared/world/terrainConfig.mjs';
import {
  createTerrainCollisionRunner,
  type TerrainCollisionResult,
} from './terrainCollisionJob';
import { simpleCollisionGroupToPhysicsDefinitions } from '../../shared/physics/simpleCollisionToPhysics.mjs';
import { readChunkColliders } from '../../shared/world/chunkColliders.mjs';
import {
  isPropSkipped,
  setPropSkipped as updatePropSkipMask,
} from '../../shared/world/generatedProp.mjs';
import { StreamingGrassSystem, type GrassInteractionTarget } from '../grass';
import type { FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createOceanMaterials, type OceanMaterials } from '../materials/oceanMaterials';
import { createWaterSplashMaterial } from '../materials/createWaterSplashMaterial';
import { OUTLINE_MATERIAL, GROUND_GRID_MATERIAL } from '../materials/lineMaterials';
import {
  createChunkFillMaterial,
  createChunkGroundFillMaterial,
} from '../models/chunkMesh';

/**
 * 同时在途的地形网格请求数。
 *
 * 挂载预算是每帧一个，所以只要在途的比它多几个，一趟往返的延迟就被排队掩掉了；
 * 再多只是让工作线程提前算好一堆随时可能被重新规划掉的 chunk。
 */
const TERRAIN_REQUESTS_IN_FLIGHT = 4;
import { registerChunkTemplates, type ChunkTemplateOptions } from '../models/chunkTemplates';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
import type {
  OceanVisualDefinition,
  WorldStreamingDefinition,
} from '../scenes/data/SceneDefinition';
import { ChunkView } from './ChunkView';
import { createChunkGenerator } from './loadChunkGenerator';

interface PendingChunk {
  chunkX: number;
  chunkZ: number;
  key: string;
}

export interface ChunkStreamerOptions {
  world: WorldStreamingDefinition;
  templates: ChunkTemplateOptions;
  environment: FillMaterialEnvironment;
  ocean?: OceanVisualDefinition;
  seaLevel?: number;
  terrainPatches?: TerrainPatchStore;
  /** 房间分配的世界种子。种子决定这一局的世界，缺省时退回默认种子。 */
  worldSeed?: number;
  /**
   * 场景的碰撞世界。chunk 装载时把它的静态碰撞体整组交进去，卸载时整组撤走，
   * 所以参与碰撞的物件数量跟着 keepRadius 走，不跟世界面积走。
   */
  collision?: CollisionWorld;
  physics?: PhysicsWorld;
  onChunkMounted?: (
    key: string,
    chunkX: number,
    chunkZ: number,
    props: Int32Array,
    propCount: number,
  ) => void;
  onChunkUnmounted?: (key: string) => void;
}

interface PropSkipMask {
  low: number;
  high: number;
}

/**
 * 按焦点位置流式加载 chunk 的场景系统。
 *
 * 两条纪律决定了它能不能扛住大世界：
 *
 * 1. **只在跨过 chunk 边界时重新规划。** 在同一个 chunk 里走动不需要做任何
 *    集合运算，避免每帧都产生一批临时对象。
 * 2. **每帧只建有限个 chunk。** 玩家高速穿越时一次要补十几个 chunk，
 *    不限额就是一次明显的卡顿；限额之后补齐会晚几帧，但雾效盖住了这段延迟。
 */
export class ChunkStreamer implements SceneVisualSystem {
  public readonly root = new THREE.Group();
  public readonly grassInteraction?: GrassInteractionTarget;
  public readonly terrainPatches: TerrainPatchStore;
  public readonly terrainEditor: TerrainEditor;

  private readonly world: WorldStreamingDefinition;
  private readonly views = new Map<string, ChunkView>();
  private readonly fillMaterial: THREE.Material;
  private readonly groundFillMaterial: THREE.Material;
  private readonly waterMaterials?: OceanMaterials;
  private readonly waterShoreMaterial?: THREE.ShaderMaterial;
  private readonly waterSplashMaterial?: THREE.ShaderMaterial;
  private readonly ocean?: OceanVisualDefinition;
  private readonly templates: ChunkTemplateOptions;
  private readonly grass?: StreamingGrassSystem;
  private readonly collision?: CollisionWorld;
  private readonly physics?: PhysicsWorld;
  private readonly onChunkMounted?: ChunkStreamerOptions['onChunkMounted'];
  private readonly onChunkUnmounted?: ChunkStreamerOptions['onChunkUnmounted'];
  /** 只保存被动过的 chunk，默认世界仍不占状态内存。 */
  private readonly skipMasks = new Map<string, PropSkipMask>();
  /** 已规划、还没往工作线程送的。 */
  private pending: PendingChunk[] = [];
  /**
   * 在途的地形网格请求：key → requestId。
   *
   * 记 id 而不是只记「在途」，是因为地形可以在请求飞在半空时被编辑；
   * 回来的那份就过期了，得能认出来丢掉。
   */
  private readonly requestedTerrain = new Map<string, number>();
  /** 地形网格已经回来、等着建视图的。挂载预算作用在这一队上。 */
  private readonly readyChunks: { chunk: PendingChunk; mesh: TerrainCollisionResult }[] = [];
  private nextTerrainRequestId = 1;
  private readonly terrainRunner = createTerrainCollisionRunner();
  private generator?: ChunkGenerator;
  private readonly worldSeed: number;
  private readonly cellCodeAt: (globalCellX: number, globalCellZ: number) => number;
  private readonly unsubscribeTerrainPatches: () => void;
  private centerX?: number;
  private centerZ?: number;
  private disposed = false;

  public constructor(options: ChunkStreamerOptions) {
    this.root.name = 'chunk-streamer';
    this.world = options.world;
    this.collision = options.collision;
    this.physics = options.physics;
    this.onChunkMounted = options.onChunkMounted;
    this.onChunkUnmounted = options.onChunkUnmounted;
    this.templates = options.templates;
    this.ocean = options.ocean;
    this.worldSeed = toWorldSeed(options.worldSeed ?? DEFAULT_WORLD_SEED);
    this.terrainPatches = options.terrainPatches ?? new TerrainPatchStore(this.worldSeed);
    if (this.terrainPatches.worldSeed !== this.worldSeed) {
      throw new Error('ChunkStreamer 与 TerrainPatchStore 必须使用同一 worldSeed');
    }
    const seaLevel = options.seaLevel ?? 0;
    this.terrainEditor = new TerrainEditor(this.terrainPatches, { seaLevel });
    this.cellCodeAt = (globalCellX, globalCellZ) => (
      this.terrainPatches.cellCodeAt(globalCellX, globalCellZ)
    );
    this.unsubscribeTerrainPatches = this.terrainPatches.subscribe((change: {
      affectedChunks: readonly { key: string }[];
    }) => {
      for (const chunk of change.affectedChunks) {
        if (this.views.has(chunk.key)) this.rebuild(chunk.key);
      }
    });
    this.fillMaterial = createChunkFillMaterial(options.environment);
    this.groundFillMaterial = createChunkGroundFillMaterial(options.environment);
    if (options.ocean) {
      this.waterMaterials = createOceanMaterials(
        options.ocean,
        seaLevel,
        options.environment,
      );
      this.waterShoreMaterial = this.waterMaterials.grid.clone();
      this.waterShoreMaterial.uniforms.uOpacity.value = Math.min(
        0.9,
        options.ocean.gridLineOpacity * 3.2,
      );
      this.waterSplashMaterial = createWaterSplashMaterial(
        options.ocean,
        seaLevel,
      );
    }
    if (options.templates.content.grass) {
      this.grass = new StreamingGrassSystem({
        color: options.templates.palette.grass,
        environment: options.environment,
      });
      this.grassInteraction = this.grass.interaction;
      this.root.add(this.grass.root);
    }

    // 生成后端是异步取回来的；在它就位之前 update 不建任何东西，
    // 世界会晚一两帧出现，这比先用一套参数铺一遍再重铺要划算。
    void createChunkGenerator().then((generator) => {
      if (this.disposed) return;
      // 草继续由生成器产出同一批放置记录，但不再烘进静态 chunk；
      // StreamingGrassSystem 会按这些原坐标生成可交互的实例叶片。
      registerChunkTemplates(generator, {
        ...options.templates,
        content: { ...options.templates.content, grass: false },
      });
      this.setGenerator(generator);
    });
  }

  /** 当前用的是哪个生成后端，用于 HUD 与排查问题。 */
  public get backendKind(): string {
    return this.generator?.kind ?? 'none';
  }

  public get loadedCount(): number {
    return this.views.size;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  public setTerrainCellCode(globalCellX: number, globalCellZ: number, code: number): boolean {
    return this.terrainPatches.setCellCode(globalCellX, globalCellZ, code);
  }

  public resetTerrainCell(globalCellX: number, globalCellZ: number): boolean {
    return this.terrainPatches.resetCell(globalCellX, globalCellZ);
  }

  /** 应用服务端下发的生成物件偏离态；已加载时只重建这一块。 */
  public setPropSkipped(
    chunkX: number,
    chunkZ: number,
    propIndex: number,
    skipped = true,
  ): boolean {
    const key = toChunkKey(chunkX, chunkZ);
    const previous = this.skipMasks.get(key);
    if (isPropSkipped(propIndex, previous) === skipped) return false;
    const next = updatePropSkipMask(previous, propIndex, skipped);
    if (next.low === 0 && next.high === 0) this.skipMasks.delete(key);
    else this.skipMasks.set(key, next);
    if (this.views.has(key)) this.rebuild(key);
    return true;
  }

  /**
   * 每帧调用。焦点通常是玩家位置；还没有玩家时是相机位置，
   * 这样大厅背后看到的也是一片正常的世界。
   */
  public update(deltaSeconds: number, elapsedSeconds: number, context?: SceneUpdateContext): void {
    this.grass?.update(deltaSeconds, elapsedSeconds, context);
    if (this.waterMaterials) {
      this.waterMaterials.surface.uniforms.uTime.value = elapsedSeconds;
      this.waterMaterials.grid.uniforms.uTime.value = elapsedSeconds;
      if (this.waterShoreMaterial) {
        this.waterShoreMaterial.uniforms.uTime.value = elapsedSeconds;
      }
      if (this.waterSplashMaterial) {
        this.waterSplashMaterial.uniforms.uTime.value = elapsedSeconds;
      }
    }
    if (!this.generator || !context) return;

    const centerX = toChunkCoordinate(context.focusX);
    const centerZ = toChunkCoordinate(context.focusZ);
    if (centerX !== this.centerX || centerZ !== this.centerZ) {
      this.centerX = centerX;
      this.centerZ = centerZ;
      const plan = planChunkStream({
        focusX: context.focusX,
        focusZ: context.focusZ,
        loadedKeys: this.views.keys(),
        loadRadius: this.world.loadRadius,
        keepRadius: this.world.keepRadius,
      });
      for (const key of plan.unload) this.unmount(key);
      this.pending = plan.load;
    }

    this.pumpTerrainRequests();
    this.drainBuildBudget();
  }

  public beforeRender(renderer: THREE.WebGLRenderer): void {
    this.grass?.beforeRender(renderer);
  }

  /** 场景卸载时释放这个流式世界独占的显存。 */
  public dispose(): void {
    this.disposed = true;
    this.clearChunks();
    this.grass?.dispose();
    this.waterMaterials?.surface.dispose();
    this.waterMaterials?.grid.dispose();
    this.waterShoreMaterial?.dispose();
    this.waterSplashMaterial?.dispose();
    this.unsubscribeTerrainPatches();
    this.terrainRunner.dispose();
    this.fillMaterial.dispose();
    this.groundFillMaterial.dispose();
    this.skipMasks.clear();
    this.generator = undefined;
  }

  private setGenerator(generator: ChunkGenerator): void {
    this.generator = generator;
    generator.setSeed(this.worldSeed);
    this.clearChunks();
  }

  /**
   * 把规划出来的 chunk 送去工作线程算地形碰撞网格。
   *
   * **网格必须先于视图就位**：那张 trimesh 就是玩家脚下的地面（Rapier 的角色
   * 控制器直接踩它）。先挂视图再等网格回来，流送边缘会出现「看得见但踩不到」
   * 的一格，玩家会掉下去。所以异步的这一段整个排在挂载之前。
   *
   * 同时在途几个：挂载预算本来就是每帧一个，一趟往返的延迟正好被排队掩掉。
   */
  private pumpTerrainRequests(): void {
    while (this.requestedTerrain.size < TERRAIN_REQUESTS_IN_FLIGHT) {
      const next = this.pending.shift();
      if (!next) return;
      if (this.views.has(next.key) || this.requestedTerrain.has(next.key)) continue;
      this.requestTerrain(next);
    }
  }

  private requestTerrain(chunk: PendingChunk): void {
    const requestId = this.nextTerrainRequestId;
    this.nextTerrainRequestId += 1;
    this.requestedTerrain.set(chunk.key, requestId);
    // 只收编辑覆盖：程序化底图由工作线程按同一个种子自己推。
    // 主线程这一步对没编辑过的 chunk 是零成本——绝大多数 chunk 都是。
    const overrides = frameTimeline.measure(
      'chunk-terrain-overrides',
      () => this.collectTerrainOverrides(chunk.chunkX, chunk.chunkZ),
    );
    this.terrainRunner
      .run(
        {
          chunkX: chunk.chunkX,
          chunkZ: chunk.chunkZ,
          worldSeed: this.worldSeed,
          overrides,
        },
        [overrides.buffer],
      )
      .then((mesh) => {
        // 期间地形被编辑过、或者这块已经被卸载：这份结果作废。
        if (this.requestedTerrain.get(chunk.key) !== requestId) return;
        this.requestedTerrain.delete(chunk.key);
        this.readyChunks.push({ chunk, mesh });
      })
      .catch((error: unknown) => {
        if (this.requestedTerrain.get(chunk.key) === requestId) {
          this.requestedTerrain.delete(chunk.key);
        }
        if (this.disposed) return;
        // 单个 chunk 算不出来不该拖垮整个场景：放回待办，下次重新规划时再试。
        console.error(`[world] chunk ${chunk.key} 地形碰撞网格构建失败`, error);
      });
  }

  /**
   * 收集这一窗里的编辑覆盖，摊成 `[globalCellX, globalCellZ, code, ...]`。
   *
   * 窗口比一个 chunk 多一行一列（东、北的崖面归本格所有），所以最多跨四个 chunk。
   * 没被编辑过的 chunk `readChunk` 返回空数组，这条路径因此几乎总是零成本。
   */
  private collectTerrainOverrides(chunkX: number, chunkZ: number): Int32Array {
    const triples: number[] = [];
    for (const [offsetX, offsetZ] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const neighbourX = chunkX + offsetX;
      const neighbourZ = chunkZ + offsetZ;
      const patch = this.terrainPatches.readChunk(neighbourX, neighbourZ);
      for (let index = 0; index + 1 < patch.length; index += 2) {
        const localIndex = patch[index];
        triples.push(
          neighbourX * TERRAIN_GRID + (localIndex % TERRAIN_GRID),
          neighbourZ * TERRAIN_GRID + Math.floor(localIndex / TERRAIN_GRID),
          patch[index + 1],
        );
      }
    }
    return Int32Array.from(triples);
  }

  private drainBuildBudget(): void {
    let budget = CHUNK_BUILD_BUDGET_PER_FRAME;
    while (budget > 0) {
      const next = this.readyChunks.shift();
      if (!next) return;
      if (this.views.has(next.chunk.key)) continue;
      if (this.mount(next.chunk, next.mesh)) budget -= 1;
    }
  }

  /** `terrainMesh` 省略时就地算——编辑路径走这条，见 `rebuild`。 */
  private mount(chunk: PendingChunk, terrainMesh?: TerrainCollisionResult): boolean {
    if (!this.generator) return false;
    try {
      const skipMask = this.skipMasks.get(chunk.key);
      // 这两个阶段分开打点是有目的的：`chunk-gen` 是纯计算（只是便宜到不值得搬）；
      // `chunk-view` 建的是 Three 几何，第 3 步之前只能留在主线程。
      const data = frameTimeline.measure(
        'chunk-gen',
        () => this.generator!.buildChunk(chunk.chunkX, chunk.chunkZ, skipMask),
      );
      return this.mountView(chunk, data, skipMask, terrainMesh);
    } catch (error) {
      // 单个 chunk 建不出来不该拖垮整个场景，跳过它，下次重新规划时再试。
      console.error(`[world] chunk ${chunk.key} 构建失败`, error);
      return false;
    }
  }

  /** `mount` 的后一半：把生成结果变成 Three 几何、碰撞体与草地。 */
  private mountView(
    chunk: PendingChunk,
    data: ReturnType<NonNullable<ChunkStreamer['generator']>['buildChunk']>,
    skipMask: ReturnType<ChunkStreamer['skipMasks']['get']>,
    terrainMesh?: TerrainCollisionResult,
  ): boolean {
    // 三段分开打点：几何体只能留在主线程（Three 对象），碰撞体与草地实例是
    // 纯计算，能不能挪走要先看它们各自值多少。
    const view = frameTimeline.measure('chunk-geometry', () => new ChunkView(
      chunk.key,
      chunk.chunkX,
      chunk.chunkZ,
      data,
      {
        fill: this.fillMaterial,
        groundFill: this.groundFillMaterial,
        outline: OUTLINE_MATERIAL,
        grid: GROUND_GRID_MATERIAL,
        water: this.waterMaterials,
        waterShore: this.waterShoreMaterial,
        waterSplash: this.waterSplashMaterial,
      },
      {
        worldSeed: this.worldSeed,
        groundColor: this.templates.palette.ground,
        showGround: this.templates.content.ground,
        oceanDefinition: this.ocean,
        seaLevel: this.terrainEditor.seaLevel,
        cellCodeAt: this.cellCodeAt,
      },
    ));
    frameTimeline.measure('chunk-grass', () => this.grass?.mountChunk(chunk.key, data));
    // 再分一层：`*-build` 是纯计算（能挪走），`*-register` 是往 Rapier 的 WASM 堆里
    // 塞碰撞体（必须和物理世界同线程）。这两个数决定第 2 步该搬什么。
    frameTimeline.measure('chunk-props-collide', () => {
      // 碰撞体由同一批放置记录派生，和几何体同生共死，不会出现「看得见但撞不到」。
      const chunkColliders = readChunkColliders(data.props, data.propCount, [], {
        skipMask,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
      });
      this.collision?.setStaticGroup(chunk.key, chunkColliders);
      this.physics?.setStaticColliderGroup(
        `props:${chunk.key}`,
        simpleCollisionGroupToPhysicsDefinitions(chunkColliders),
      );
    });
    const mesh = terrainMesh ?? frameTimeline.measure(
      'chunk-terrain-build',
      () => buildTerrainCollisionMesh(chunk.chunkX, chunk.chunkZ, this.cellCodeAt),
    );
    frameTimeline.measure(
      'chunk-terrain-register',
      () => this.physics?.setChunkCollider(chunk.key, mesh),
    );
    this.views.set(chunk.key, view);
    this.root.add(view.root);
    this.onChunkMounted?.(
      chunk.key,
      chunk.chunkX,
      chunk.chunkZ,
      data.props,
      data.propCount,
    );
    return true;
  }

  private unmount(key: string): void {
    // 在途请求与已就绪结果都要作废：槽位随时可能被重新规划，留着就会挂上旧地形。
    this.requestedTerrain.delete(key);
    const readyIndex = this.readyChunks.findIndex((entry) => entry.chunk.key === key);
    if (readyIndex >= 0) this.readyChunks.splice(readyIndex, 1);
    const view = this.views.get(key);
    if (!view) return;
    this.views.delete(key);
    this.onChunkUnmounted?.(key);
    this.grass?.unmountChunk(key);
    this.collision?.removeStaticGroup(key);
    this.physics?.removeStaticColliderGroup(`props:${key}`);
    this.physics?.removeChunkCollider(key);
    view.dispose();
  }

  /**
   * 地形被编辑：就地重建，不走工作线程。
   *
   * 编辑是一次用户动作，等一趟往返会让笔刷有延迟；而流送是后台行为，等得起。
   * 这条分界也让「异步」只影响一条路径，编辑那条仍然是同步的、好推理的。
   */
  private rebuild(key: string): void {
    const coordinate = parseChunkKey(key);
    if (!coordinate || !this.views.has(key)) return;
    this.unmount(key);
    this.mount({ ...coordinate, key });
  }

  /** 清空全部 chunk 并让下一次 update 重新规划。 */
  private clearChunks(): void {
    for (const key of Array.from(this.views.keys())) this.unmount(key);
    this.pending = [];
    this.requestedTerrain.clear();
    this.readyChunks.length = 0;
    this.centerX = undefined;
    this.centerZ = undefined;
  }
}

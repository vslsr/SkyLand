import type { Actor } from '../../shared/actor/Actor.mjs';
import type { BuildSiteIndex } from '../../shared/build/BuildSiteIndex.mjs';
import type { BuildFootprint } from '../../shared/build/buildFootprint.mjs';
import { cellWithinBounds } from '../../shared/build/index.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { sweepProjectileArc } from '../../shared/ballistics/index.mjs';
import { TERRAIN_CELL_SIZE } from '../../shared/world/terrainConfig.mjs';
import { intersectRayWithHorizontalPlane } from '../camera/cameraRay';
import type { ContainerModelLike } from '../inventory/index';
import type { GrassBendImpulse, GrassInteractionTarget } from '../grass';
import type { RenderWorldCommands } from '../render/RenderWorldRuntime';
import type { SnapshotActor, SnapshotPlayer } from '../network/protocol';
import type { SceneBounds } from '../scenes/data/SceneDefinition';
import type { TerrainWorld } from '../world/TerrainWorld';
import type {
  ActorInteractionCandidate,
  ActorSnapshotTarget,
  BuildCellStatus,
  BuildHullCandidate,
  BuildPieceCandidate,
  SceneComposition,
  VesselHudState,
} from './SceneVisualSystem';

/** 这张地图里和建造有关的玩法事实；随场景一起交进来。 */
export interface SceneWorldFacts {
  fixedWaterWorld: boolean;
  fixedWaterLevel: number;
  /** 有没有可以建静态件的地面：流式地形图、固定地面图有，纯海域图没有。 */
  hasLand: boolean;
  /** 活动范围；建造件要整格落在里面。 */
  bounds?: SceneBounds;
}

const NO_HULLS: readonly BuildHullCandidate[] = Object.freeze([]);

/**
 * 当前场景里**不属于渲染**的那一半：地形采样、物理查询、Actor 查询
 * （引擎迁移路线图 第 3 步的前置）。
 *
 * 这些方法此前全都挂在 `SceneRenderer` 上。那个类因此同时是渲染器、场景宿主、
 * 地形查询服务和 Actor 查询服务——四件事。第 3 步要把 canvas 交给渲染线程，
 * 而这四件事里只有第一件该跟着走：**玩法每帧都要问「脚下多高」「前面挡不挡镜头」，
 * 那不能变成一次跨线程往返。**
 *
 * 所以先按这条线拆开。拆完之后 `SceneRenderer` 只剩渲染核心，这一半留在原地。
 *
 * 值得记一笔的是：这一半**完全不碰 Three**——地形是纯数据、物理是 Rapier、
 * Actor 查询走的是 Game World。最后一个例外（`pickActorInteraction` 曾经拿
 * `THREE.Raycaster` 打 proxy 场景图）已经改成解析求交，见那个方法的注释。
 */
export class SceneWorld implements GrassInteractionTarget {
  private terrainWorld?: TerrainWorld;
  private physicsWorld?: PhysicsWorld;
  private actorSnapshotTarget?: ActorSnapshotTarget;
  /**
   * 没有地形世界的固定水面场景（线稿海域）用这两个值代替地形采样。
   * 它们本来就是「这张地图的玩法事实」，不是渲染状态。
   */
  private fixedWaterWorld = false;
  private fixedWaterLevel = 0;
  private landAvailable = false;
  private bounds?: SceneBounds;

  /**
   * 往渲染世界发命令的口子。
   *
   * **不随场景走**：草地脉冲、地形编辑镜像发给的是渲染循环本身，而它从大厅到
   * 房间再回大厅一直是同一个。单线程下是真对象，上 worker 之后是命令队列。
   */
  public constructor(private readonly render: RenderWorldCommands) {}

  /** 换场景：把新组合里属于玩法的那几个句柄接过来。 */
  public adopt(composition: SceneComposition, facts: SceneWorldFacts): void {
    this.terrainWorld = composition.terrainWorld;
    this.physicsWorld = composition.physicsWorld;
    this.actorSnapshotTarget = composition.actorSnapshotTarget;
    this.fixedWaterWorld = facts.fixedWaterWorld;
    this.fixedWaterLevel = facts.fixedWaterLevel;
    this.landAvailable = facts.hasLand;
    this.bounds = facts.bounds;
  }

  public clear(): void {
    this.terrainWorld = undefined;
    this.physicsWorld = undefined;
    this.actorSnapshotTarget = undefined;
    this.fixedWaterWorld = false;
    this.fixedWaterLevel = 0;
    this.landAvailable = false;
    this.bounds = undefined;
  }

  /**
   * 物理调试线框这一帧的顶点与颜色；没有物理世界时是 `undefined`。
   *
   * 画线框的是渲染侧，但**数据源在这一半**——`SceneRenderer` 曾经自己留一份
   * `physicsWorld` 引用来调它，那是同一个世界被两个地方持有。
   */
  public debugRenderPhysics(): { vertices: Float32Array; colors: Float32Array } | undefined {
    return this.physicsWorld?.debugRender();
  }

  // --- 地形 ---------------------------------------------------------------

  public sampleGroundHeight(x: number, z: number): number {
    return this.terrainWorld?.sampleGroundHeight(x, z) ?? 0;
  }

  /**
   * 贴地表现（落叶、地面装饰）该站的可见表面：水域取水面，其余取地面。
   * 固定水面场景没有地形数据，直接退回那张地图的水位或 0。
   */
  public sampleSurfaceHeight(x: number, z: number): number {
    if (this.terrainWorld) return this.terrainWorld.sampleSurfaceHeight(x, z);
    return this.fixedWaterWorld ? this.fixedWaterLevel : 0;
  }

  public samplePlayerHeight(x: number, z: number, buoyancyDraft?: number): number {
    if (this.terrainWorld) return this.terrainWorld.sampleMovementHeight(x, z, buoyancyDraft);
    return this.fixedWaterWorld && Number.isFinite(buoyancyDraft)
      ? this.fixedWaterLevel - Math.max(0, Number(buoyancyDraft))
      : 0;
  }

  public isWaterAt(x: number, z: number): boolean {
    return this.terrainWorld?.isWaterAt(x, z) ?? this.fixedWaterWorld;
  }

  public raycastGround(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number } | undefined {
    return this.terrainWorld?.raycast(origin, direction);
  }

  /** 射线命中的地形格。UI 用它决定高亮哪一格、点下去改哪一格。 */
  public pickTerrainCell(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { cellX: number; cellZ: number } | undefined {
    const hit = this.terrainWorld?.raycast(origin, direction);
    if (!hit) return undefined;
    return {
      cellX: Math.floor(hit.x / TERRAIN_CELL_SIZE),
      cellZ: Math.floor(hit.z / TERRAIN_CELL_SIZE),
    };
  }

  /**
   * 写入服务端确认过的地形覆盖。patch store 的订阅者会据此重建受影响的 chunk。
   * 客户端不做本地预测，所以这是覆盖层唯一的写入口。
   */
  public applyTerrainPatches(
    cells: readonly { cellX: number; cellZ: number; code: number }[],
  ): void {
    const terrain = this.terrainWorld;
    if (!terrain) return;
    for (const cell of cells) terrain.setCellCode(cell.cellX, cell.cellZ, cell.code);
    // 渲染世界按同一个种子自己推地形，编辑是它推不出来的那部分——雨要落在
    // 改过的高度上，就得把同一批格子也发过去。
    this.render.setTerrainCells(cells);
  }

  /** 当前场景任意来源的地形 patch 通知。 */
  public onTerrainChanged(listener: () => void): () => void {
    return this.terrainWorld?.subscribe(listener) ?? (() => undefined);
  }

  // --- 建造 ---------------------------------------------------------------

  /**
   * 建造的拾取点：有地形就打地形（水面也算——水上地基要吸附的船就浮在那上面），
   * 没有地形就打这张图的水面或地面平面。只有 x/z 参与吸附，y 只给幽灵兜底。
   */
  public pickBuildPoint(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): { x: number; y: number; z: number } | undefined {
    if (this.terrainWorld) {
      const hit = this.terrainWorld.raycast(origin, direction);
      return hit ? { x: hit.x, y: hit.y, z: hit.z } : undefined;
    }
    return intersectRayWithHorizontalPlane(
      origin,
      direction,
      this.fixedWaterWorld ? this.fixedWaterLevel : 0,
    );
  }

  /** 有没有可以建静态件的地面。 */
  public hasLand(): boolean {
    return this.landAvailable;
  }

  /** 这张图的水面高度；立起来的新船就浮在这个高度上。 */
  public seaLevel(): number {
    if (this.terrainWorld) return this.terrainWorld.seaLevel;
    return this.fixedWaterWorld ? this.fixedWaterLevel : 0;
  }

  /**
   * 一个世界格是什么：出了活动范围 → bounds；水域格（或整张图都是海）→ water；
   * 其余 → land。和服务端 `ServerScene.buildCellStatus` 是同一套判断。
   */
  public buildCellStatus(cellX: number, cellZ: number): BuildCellStatus {
    if (!cellWithinBounds(cellX, cellZ, this.bounds)) return 'bounds';
    if (this.terrainWorld) return this.terrainWorld.isWaterCell(cellX, cellZ) ? 'water' : 'land';
    return this.fixedWaterWorld ? 'water' : 'land';
  }

  /**
   * 静态件落在一格上的支撑面：陆地格是最高角点，河床格是水面（码头板浮在水上），
   * 固定地面图上是 0。没有可建的陆地或出了范围就是 undefined。
   */
  public groundTopHeight(cellX: number, cellZ: number): number | undefined {
    if (!this.landAvailable) return undefined;
    const status = this.buildCellStatus(cellX, cellZ);
    if (status === 'bounds') return undefined;
    if (!this.terrainWorld) return 0;
    const top = this.terrainWorld.sampleCellTopHeight(cellX, cellZ);
    return status === 'water' ? Math.max(top, this.terrainWorld.seaLevel) : top;
  }

  public getBuildSites(): BuildSiteIndex | undefined {
    return this.actorSnapshotTarget?.getBuildSites?.();
  }

  public listBuildHulls(): readonly BuildHullCandidate[] {
    return this.actorSnapshotTarget?.listBuildHulls?.() ?? NO_HULLS;
  }

  public findBuildPieceNear(x: number, z: number, radius: number): BuildPieceCandidate | undefined {
    return this.actorSnapshotTarget?.findBuildPieceNear?.(x, z, radius);
  }

  public buildFoundationTop(surfaceKey: string, cellX: number, cellZ: number): number | undefined {
    return this.actorSnapshotTarget?.buildFoundationTop?.(surfaceKey, cellX, cellZ);
  }

  /** 放置位有没有被实体挡住；没有 Actor 世界（大厅背后）就当没挡。 */
  public buildFootprintBlocked(footprint: BuildFootprint, ignoreSurfaceKey?: string): boolean {
    return this.actorSnapshotTarget?.buildFootprintBlocked?.(footprint, ignoreSurfaceKey) ?? false;
  }

  // --- 物理 ---------------------------------------------------------------

  public getPhysicsWorld(): PhysicsWorld | undefined {
    return this.physicsWorld;
  }

  /**
   * 第三人称相机悬臂的探针：从角色到期望机位扫掠一个球，返回最早的命中位置
   * （线段参数 0–1，没挡住就是 1）。查询走 CAMERA 层，所以树冠这类
   * 「不挡走路但挡镜头」的体积也会被算进去。
   */
  public sweepCameraProbe(
    start: readonly [number, number, number],
    end: readonly [number, number, number],
    radius: number,
  ): number {
    return this.physicsWorld?.castCameraSphere(start, end, radius) ?? 1;
  }

  /**
   * 蓄力预览那条弧被挡在哪儿：返回 [0, 1] 的截断比例，一路无阻就是 1。
   *
   * 走的是和服务端**同一份**沿弧扫掠（`sweepProjectileArc`），只是碰撞数据各取
   * 各的：世界几何问本地那个 Rapier 世界，实体问本地 Actor 世界。两边的算法一样，
   * 所以「线停在哪」和「箭停在哪」是同一个答案；只有取法不同，因为客户端手上就是
   * 另一份世界。
   *
   * 排掉的是**本地玩家自己**：出手点在他身体里，不排的话第一段就撞在自己身上，
   * 线永远画不出去。服务端那边由 `ownerActorId` 排同一个人。
   *
   * 只在蓄力那几帧调用，每次的查询数是常数（弧固定切成若干段），与射程和世界大小
   * 都无关。
   */
  public sweepProjectileArc(
    arc: {
      originX: number; originY: number; originZ: number;
      impactX: number; impactY: number; impactZ: number; ratio: number;
    },
    options: { radius: number; shooterActorId?: string },
  ): number {
    const physics = this.physicsWorld;
    const actors = this.actorSnapshotTarget;
    if (!physics && !actors) return 1;
    return sweepProjectileArc(arc, {
      radius: options.radius,
      sweepWorld: physics
        ? (start, end, radius) => physics.castProjectileSphere(
          start,
          end,
          radius,
          options.shooterActorId,
        )
        : undefined,
      sweepTargets: actors
        ? (start, end, radius) => {
          const fraction = actors.sweepProjectileTargets(start, end, radius);
          // 预览只需要「停在哪」，不需要「停在谁身上」——谁挨打是服务端的事。
          return fraction < 1 ? { fraction } : undefined;
        }
        : undefined,
    }).travel;
  }

  // --- 草地 ---------------------------------------------------------------

  /** 玩家、场景组件或玩法效果写入当前场景草地的统一入口。 */
  public applyImpulse(impulse: GrassBendImpulse): void {
    this.render.applyGrassImpulse(impulse);
  }

  // --- Actor --------------------------------------------------------------

  public syncActors(
    snapshots: readonly SnapshotActor[],
    players: readonly SnapshotPlayer[],
    serverTime: number,
  ): void {
    this.actorSnapshotTarget?.syncSnapshots(snapshots, serverTime, undefined, players);
  }

  public getActor(actorId: string): Actor | undefined {
    return this.actorSnapshotTarget?.getActor(actorId);
  }

  public findOwnedActorId(playerId: string): string | undefined {
    return this.actorSnapshotTarget?.findOwnedActorId(playerId);
  }

  public findControllableActorId(): string | undefined {
    return this.actorSnapshotTarget?.findControllableActorId();
  }

  /**
   * 准星指向的可交互 Actor。
   *
   * 已经不碰 Three 了：`ClientActorSystem.pickInteractableActor` 改成拿
   * `SimpleCollision` 解析求交，和相机悬臂共用同一份扫掠实现。理由见那边的注释。
   */
  public pickActorInteraction(frame: {
    position: readonly [number, number, number];
    axes: { forward: readonly [number, number, number] };
  }): ActorInteractionCandidate | undefined {
    return this.actorSnapshotTarget?.pickInteractableActor(
      frame.position,
      frame.axes.forward,
    );
  }

  public findNearbyActorInteraction(
    position: { x: number; z: number },
  ): ActorInteractionCandidate | undefined {
    return this.actorSnapshotTarget?.findNearbyInteractableActor(position);
  }

  public findHeldActorInteraction(playerId: string): ActorInteractionCandidate | undefined {
    return this.actorSnapshotTarget?.findHeldInteractableActor(playerId);
  }

  public getContainer(actorId: string): ContainerModelLike | undefined {
    return this.actorSnapshotTarget?.getContainer?.(actorId);
  }

  public findOpenContainerActorId(): string | undefined {
    return this.actorSnapshotTarget?.findOpenContainerActorId?.();
  }

  public setHoveredActorId(actorId?: string): void {
    this.actorSnapshotTarget?.setHoveredActorId(actorId);
  }

  /** 吃东西那一段：手上那件食物一口口变小，见 `chewAnimation`。 */
  public setChewingItem(actorId: string | undefined, ratio: number): void {
    this.actorSnapshotTarget?.setChewingItem?.(actorId, ratio);
  }

  public setInteractionMarkerActorId(
    actorId?: string,
    inputLabel?: string,
    opacity?: number,
  ): void {
    this.actorSnapshotTarget?.setInteractionMarkerActorId(actorId, inputLabel, opacity);
  }

  public getVesselHudState(playerId: string): VesselHudState | undefined {
    return this.actorSnapshotTarget?.getVesselHudState(playerId);
  }
}

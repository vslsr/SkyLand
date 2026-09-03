import type { Actor } from '../../shared/actor/Actor.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import { TERRAIN_CELL_SIZE } from '../../shared/world/terrainConfig.mjs';
import type { GrassBendImpulse, GrassInteractionTarget } from '../grass';
import type { SnapshotActor, SnapshotPlayer } from '../network/protocol';
import type { TerrainWorld } from '../world/TerrainWorld';
import type {
  ActorInteractionCandidate,
  ActorSnapshotTarget,
  SceneComposition,
  VesselHudState,
} from './SceneVisualSystem';

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
 * 值得记一笔的是：这一半几乎**不碰 Three**——地形是纯数据、物理是 Rapier、
 * Actor 查询走的是 Game World。唯一的例外是 `pickActorInteraction`（见下）。
 */
export class SceneWorld implements GrassInteractionTarget {
  private terrainWorld?: TerrainWorld;
  private physicsWorld?: PhysicsWorld;
  private actorSnapshotTarget?: ActorSnapshotTarget;
  private grassInteraction?: GrassInteractionTarget;
  /**
   * 没有地形世界的固定水面场景（线稿海域）用这两个值代替地形采样。
   * 它们本来就是「这张地图的玩法事实」，不是渲染状态。
   */
  private fixedWaterWorld = false;
  private fixedWaterLevel = 0;

  /** 换场景：把新组合里属于玩法的那几个句柄接过来。 */
  public adopt(composition: SceneComposition, water: {
    fixedWaterWorld: boolean;
    fixedWaterLevel: number;
  }): void {
    this.terrainWorld = composition.terrainWorld;
    this.physicsWorld = composition.physicsWorld;
    this.actorSnapshotTarget = composition.actorSnapshotTarget;
    this.grassInteraction = composition.grassInteraction;
    this.fixedWaterWorld = water.fixedWaterWorld;
    this.fixedWaterLevel = water.fixedWaterLevel;
  }

  public clear(): void {
    this.terrainWorld = undefined;
    this.physicsWorld = undefined;
    this.actorSnapshotTarget = undefined;
    this.grassInteraction = undefined;
    this.fixedWaterWorld = false;
    this.fixedWaterLevel = 0;
  }

  // --- 地形 ---------------------------------------------------------------

  public sampleGroundHeight(x: number, z: number): number {
    return this.terrainWorld?.sampleGroundHeight(x, z) ?? 0;
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
  }

  /** 当前场景任意来源的地形 patch 通知。 */
  public onTerrainChanged(listener: () => void): () => void {
    return this.terrainWorld?.subscribe(listener) ?? (() => undefined);
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

  // --- 草地 ---------------------------------------------------------------

  /** 玩家、场景组件或玩法效果写入当前场景草地的统一入口。 */
  public applyImpulse(impulse: GrassBendImpulse): void {
    this.grassInteraction?.applyImpulse(impulse);
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
   * **这是这一半里唯一真正碰 Three 的查询**：`ClientActorSystem` 内部拿
   * `THREE.Raycaster` 打 proxy 的场景图。第 3 步把渲染世界搬进线程之后它就地做不了，
   * 而它的调用方（交互控制器）是同步的玩法逻辑——要么让渲染线程每帧回送一个
   * 「准星命中了谁」，要么在玩法侧用碰撞体重做一次解析求交。这个选择还没定，
   * 见实现路径文档 §3。
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

  public setHoveredActorId(actorId?: string): void {
    this.actorSnapshotTarget?.setHoveredActorId(actorId);
  }

  public setInteractionMarkerActorId(actorId?: string, inputLabel?: string): void {
    this.actorSnapshotTarget?.setInteractionMarkerActorId(actorId, inputLabel);
  }

  public getVesselHudState(playerId: string): VesselHudState | undefined {
    return this.actorSnapshotTarget?.getVesselHudState(playerId);
  }
}

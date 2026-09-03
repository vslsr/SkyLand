import * as THREE from 'three';
import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { PbfSlimeVisualRig } from '../../models/actors/ActorVisualModel';
import type { SlimeDragState } from '../../network/protocol';
import type { ActorArchetypeDefinition } from '../../scenes/data/SceneDefinition';
import type { HybridSlimeSimulation } from '../../slime/hybrid/HybridSlimeSimulation';

export const SLIME_SURFACE_DRAG_COMPONENT = 'slime-surface-drag';

export type SlimeSurfaceDragDefinition = NonNullable<
  ActorArchetypeDefinition['components']['slimeSurfaceDrag']
>;

/**
 * 客户端兼容默认值：房间可能在配置更新前已经启动并缓存了旧的玩家原型。
 * 比例与 pbf-slime.actor.json 一致，避免仅因旧房间缺少新字段就完全不装配交互。
 */
export function createDefaultSlimeSurfaceDragDefinition(
  radius: number,
): SlimeSurfaceDragDefinition {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0.95;
  return {
    maximumDistance: safeRadius * 1.1,
    pullForce: 120,
    falloffExponent: 1.35,
    influenceRadius: safeRadius * 1.2,
  };
}

export interface SlimeSurfaceDragRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * 客户端蒙皮拖拽组件。它只向 HybridSlimeSimulation 写局部外力，
 * 不移动 Actor 根节点，也不接触权威碰撞或网络状态。
 */
export class SlimeSurfaceDragComponent extends ActorComponent {
  private readonly raycaster = new THREE.Raycaster();
  private readonly dragPlane = new THREE.Plane();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly dragTargetWorld = new THREE.Vector3();
  private readonly dragTargetLocal = new THREE.Vector3();
  private readonly contactLocal = new THREE.Vector3();
  private readonly fallbackVertexWorld = new THREE.Vector3();
  private readonly fallbackBestWorld = new THREE.Vector3();
  private readonly surfaceWorldScale = new THREE.Vector3();
  private readonly pullLocal = new THREE.Vector3();
  private dragging = false;

  public constructor(
    public readonly rig: PbfSlimeVisualRig,
    public readonly simulation: HybridSlimeSimulation,
    private readonly definition: SlimeSurfaceDragDefinition,
  ) {
    super(SLIME_SURFACE_DRAG_COMPONENT);
  }

  public get isDragging(): boolean {
    return this.dragging;
  }

  /**
   * 供网络复制的当前拖拽。命中点与位移都在 Actor 本地空间，因此接收端不需要
   * 知道拖拽者的世界坐标或相机，只要用同一份参数在自己的求解器上重放即可。
   */
  public get replicationState(): SlimeDragState | undefined {
    if (!this.dragging) return undefined;
    return {
      contactX: this.contactLocal.x,
      contactY: this.contactLocal.y,
      contactZ: this.contactLocal.z,
      pullX: this.pullLocal.x,
      pullY: this.pullLocal.y,
      pullZ: this.pullLocal.z,
    };
  }

  /** 鼠标按下时只拾取连续外壳，核心、气泡、脸和阴影都不会抢走命中。 */
  public beginDrag(ray: SlimeSurfaceDragRay): boolean {
    if (!this.setRay(ray)) return false;
    this.rig.root.updateWorldMatrix(true, true);
    // BufferAttribute 会动态改写；只在开始拾取时重建包围球，避免每帧多做一次遍历。
    this.rig.surfaceGeometry.computeBoundingSphere();
    const hit = this.raycaster.intersectObject(this.rig.surface, false)[0];
    const contactWorld = hit?.point ?? this.pickNearestSurfaceVertex();
    if (!contactWorld) return false;

    this.contactLocal.copy(contactWorld);
    this.rig.root.worldToLocal(this.contactLocal);
    if (!this.simulation.beginSurfaceDrag(
      this.contactLocal.x,
      this.contactLocal.y,
      this.contactLocal.z,
      this.definition,
    )) return false;

    // 使用按下时的视线法线建立屏幕平行拖拽平面；向任意屏幕方向拉都连续稳定。
    this.dragPlane.setFromNormalAndCoplanarPoint(this.rayDirection, contactWorld);
    this.dragging = true;
    this.updateDrag(ray);
    return true;
  }

  public updateDrag(ray: SlimeSurfaceDragRay): boolean {
    if (!this.dragging || !this.setRay(ray)) return false;
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragTargetWorld)) return false;
    this.rig.root.updateWorldMatrix(true, false);
    this.dragTargetLocal.copy(this.dragTargetWorld);
    this.rig.root.worldToLocal(this.dragTargetLocal);
    this.pullLocal.subVectors(this.dragTargetLocal, this.contactLocal);
    this.simulation.setSurfaceDragPull(this.pullLocal.x, this.pullLocal.y, this.pullLocal.z);
    return true;
  }

  public endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.pullLocal.set(0, 0, 0);
    this.simulation.endSurfaceDrag();
  }

  public override onDetach(): void {
    this.endDrag();
  }

  private setRay(ray: SlimeSurfaceDragRay): boolean {
    const values = [...ray.origin, ...ray.direction];
    if (!values.every(Number.isFinite)) return false;
    this.rayOrigin.set(...ray.origin);
    this.rayDirection.set(...ray.direction);
    const lengthSquared = this.rayDirection.lengthSq();
    if (lengthSquared <= 1e-12) return false;
    this.rayDirection.multiplyScalar(1 / Math.sqrt(lengthSquared));
    this.raycaster.ray.set(this.rayOrigin, this.rayDirection);
    return true;
  }

  /**
   * 动态 BufferGeometry 在顶点刚被求解器改写、包围体或三角边界更新的瞬间，
   * Raycaster 偶尔可能漏掉肉眼可见的表面。按下只发生一次，因此允许遍历约四百个
   * 蒙皮顶点，选择视线附近最近的顶点作为窄范围容错，不扩大成整块屏幕热区。
   */
  private pickNearestSurfaceVertex(): THREE.Vector3 | undefined {
    const position = this.rig.surfacePosition;
    this.rig.surface.getWorldScale(this.surfaceWorldScale);
    const maximumWorldScale = Math.max(
      Math.abs(this.surfaceWorldScale.x),
      Math.abs(this.surfaceWorldScale.y),
      Math.abs(this.surfaceWorldScale.z),
    );
    const tolerance = this.rig.radius * maximumWorldScale * 0.18;
    const toleranceSquared = tolerance * tolerance;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (let vertex = 0; vertex < position.count; vertex += 1) {
      this.fallbackVertexWorld
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(this.rig.surface.matrixWorld);
      const fromOriginX = this.fallbackVertexWorld.x - this.rayOrigin.x;
      const fromOriginY = this.fallbackVertexWorld.y - this.rayOrigin.y;
      const fromOriginZ = this.fallbackVertexWorld.z - this.rayOrigin.z;
      const distanceAlongRay = (
        fromOriginX * this.rayDirection.x
        + fromOriginY * this.rayDirection.y
        + fromOriginZ * this.rayDirection.z
      );
      if (distanceAlongRay <= 0) continue;
      const closestX = this.rayOrigin.x + this.rayDirection.x * distanceAlongRay;
      const closestY = this.rayOrigin.y + this.rayDirection.y * distanceAlongRay;
      const closestZ = this.rayOrigin.z + this.rayDirection.z * distanceAlongRay;
      const deltaX = this.fallbackVertexWorld.x - closestX;
      const deltaY = this.fallbackVertexWorld.y - closestY;
      const deltaZ = this.fallbackVertexWorld.z - closestZ;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      if (distanceSquared >= bestDistanceSquared) continue;
      bestDistanceSquared = distanceSquared;
      this.fallbackBestWorld.copy(this.fallbackVertexWorld);
    }

    return bestDistanceSquared <= toleranceSquared ? this.fallbackBestWorld : undefined;
  }
}

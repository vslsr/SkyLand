import * as THREE from 'three';
import type { FillMaterialEnvironment } from '../../materials/createFillMaterial';
import { createActorVisualModel } from '../../models/actors/createActorVisualModel';
import type { ActorVisualModel } from '../../models/actors/ActorVisualModel';
import {
  type MeshProxyDesc,
  type MeshProxyInfo,
  type ProxyId,
  type RenderScene,
  toProxyId,
} from '../RenderScene';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';
import { ThreeFireVisual } from './ThreeFireVisual';
import { ThreeMeshProxy } from './ThreeMeshProxy';

/**
 * `RenderScene` 的 Three.js 后端（路线图 第 1 步）。
 *
 * 现有的 Three 代码原样搬进来，帧率不变、画面不变。价值不在这一版实现，在
 * **盒子的接口**——它和以后 C++ 渲染器的接口是同一个。盒子里换成 GL 状态机
 * 那天，`ClientActorSystem` 一行都不用改。
 *
 * 这个类里没有一个 `Actor` 类型；它只认识 `ProxyId`。
 */

function createEmptyModel(name: string): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  root.name = `${name}-root`;
  visualRoot.name = `${name}-visual`;
  root.add(visualRoot);
  return {
    root,
    visualRoot,
    length: 0,
    width: 0,
    simpleCollision: {
      shape: 'box',
      centerX: 0,
      centerZ: 0,
      halfWidth: 0,
      halfLength: 0,
      minimumY: 0,
      maximumY: 0,
      supportShape: 'box',
      supportHalfWidth: 0,
      supportHalfLength: 0,
    },
  };
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export class ThreeRenderScene implements RenderScene {
  /** 槽位即 ProxyId，回收后复用；空洞用 undefined 占位，保持下标稳定。 */
  private readonly proxies: (ThreeMeshProxy | undefined)[] = [];
  private readonly freeSlots: number[] = [];
  private readonly world: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly parentWorld: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };
  private simpleCollisionVisible = false;
  /** 渲染世界自己的表现系统。它们只认识 ProxyId，不认识 Actor。 */
  private readonly fireVisual = new ThreeFireVisual();

  public constructor(
    public readonly root: THREE.Group,
    private readonly environment: FillMaterialEnvironment,
  ) {}

  public createMeshProxy(desc: MeshProxyDesc): MeshProxyInfo {
    const model = desc.render
      ? createActorVisualModel(this.environment, desc.render)
      : createEmptyModel(desc.name);
    if (desc.render) {
      model.root.name = `${desc.name}-root`;
      model.visualRoot.name = `${desc.name}-visual`;
    }
    const slot = this.freeSlots.pop() ?? this.proxies.length;
    const proxy = new ThreeMeshProxy(toProxyId(slot), model);
    this.proxies[slot] = proxy;
    proxy.setSimpleCollisionVisible(this.simpleCollisionVisible);
    this.root.add(proxy.root);
    return {
      id: proxy.id,
      length: proxy.length,
      width: proxy.width,
      interactionAnchorY: proxy.interactionAnchorY,
      simpleCollision: proxy.simpleCollision,
    };
  }

  public destroyMeshProxy(id: ProxyId): void {
    const proxy = this.proxies[id];
    if (!proxy) return;
    this.proxies[id] = undefined;
    this.freeSlots.push(id);
    this.fireVisual.forget(id);
    proxy.dispose();
  }

  /** 渲染侧查找。只有渲染世界内部（表现 System、拾取、调试可视化）能调。 */
  public resolve(id: ProxyId): ThreeMeshProxy | undefined {
    return id >= 0 ? this.proxies[id] : undefined;
  }

  public liveProxies(): readonly ThreeMeshProxy[] {
    return this.proxies.filter((proxy): proxy is ThreeMeshProxy => proxy !== undefined);
  }

  /**
   * 把这一帧的 SoA 兑现到 Three 的场景图。
   *
   * 边界上传的是**世界坐标**；这里从已插值的父/子世界坐标反算渲染局部坐标，
   * 使 Three 层级的最终世界位置严格等于权威插值结果，而不是重新插值局部坐标。
   * 这段数学是 Three 场景图的需求，所以它属于渲染侧，不属于 Game World。
   */
  public submitTransforms(transforms: RenderTransformBuffer): void {
    for (const proxy of this.proxies) {
      if (!proxy) continue;
      transforms.readTransform(proxy.id, this.world);
      const parentId = transforms.readParent(proxy.id);
      const parent = parentId >= 0 ? this.proxies[parentId] : undefined;
      // Actor 根节点只能挂到父 proxy 的权威 root，禁止经过带摇晃/倾斜的 visualRoot。
      const renderParent = parent?.root ?? this.root;
      if (proxy.root.parent !== renderParent) renderParent.add(proxy.root);
      if (!parent) {
        proxy.root.position.set(this.world.x, this.world.y, this.world.z);
        proxy.root.rotation.y = this.world.yaw;
        continue;
      }
      transforms.readTransform(parent.id, this.parentWorld);
      const deltaX = this.world.x - this.parentWorld.x;
      const deltaZ = this.world.z - this.parentWorld.z;
      const sinYaw = Math.sin(this.parentWorld.yaw);
      const cosYaw = Math.cos(this.parentWorld.yaw);
      proxy.root.position.set(
        cosYaw * deltaX - sinYaw * deltaZ,
        this.world.y - this.parentWorld.y,
        sinYaw * deltaX + cosYaw * deltaZ,
      );
      proxy.root.rotation.y = normalizeAngle(this.world.yaw - this.parentWorld.yaw);
    }
  }

  /**
   * 驱动渲染世界自己的表现动画。读的是刚翻面的参数段，写的是自己持有的 rig，
   * 全程不经过任何 Actor。
   */
  public updateVisuals(
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    this.fireVisual.update(this.liveProxies(), transforms, deltaSeconds, elapsedSeconds);
  }

  /** 简易碰撞盒的可视化开关。是渲染世界自己的状态，遍历不经过任何 Actor。 */
  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    for (const proxy of this.proxies) proxy?.setSimpleCollisionVisible(visible);
  }

  public dispose(): void {
    for (const proxy of this.proxies) proxy?.dispose();
    this.proxies.length = 0;
    this.freeSlots.length = 0;
  }
}

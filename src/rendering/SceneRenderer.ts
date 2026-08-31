import * as THREE from 'three';
import type { Actor } from '../../shared/actor/Actor.mjs';
import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { CameraFrame } from '../camera/CameraTransform';
import {
  type GrassBendImpulse,
  type GrassInteractionTarget,
} from '../grass';
import { createLineArtScene } from '../scene/createLineArtScene';
import type {
  ActorInteractionCandidate,
  ActorSnapshotTarget,
  SceneComposition,
  SceneUpdateContext,
  SceneVisualSystem,
  VesselHudState,
} from '../scene/SceneVisualSystem';
import type { SnapshotActor } from '../network/protocol';
import type { SceneBeforeRenderListener } from '../scene/components';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';

const EMPTY_SCENE_COLOR = 0xfdfbf6;

function createEmptyScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(EMPTY_SCENE_COLOR);
  return scene;
}

function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const renderable = object as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    renderable.geometry?.dispose();
    if (Array.isArray(renderable.material)) {
      for (const material of renderable.material) material.dispose();
    } else {
      renderable.material?.dispose();
    }
  });
}

export class SceneRenderer implements GrassInteractionTarget {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private scene = createEmptyScene();
  private visualSystems: SceneVisualSystem[] = [];
  private grassInteraction?: GrassInteractionTarget;
  private actorSnapshotTarget?: ActorSnapshotTarget;
  private collisionWorld?: CollisionWorld;
  private simpleCollisionVisible = false;
  private readonly dynamicWorld = new THREE.Group();
  private readonly lookTarget = new THREE.Vector3();
  private readonly beforeRenderListeners = new Set<SceneBeforeRenderListener>();

  public constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0xfdfbf6, 1);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.scene.add(this.dynamicWorld);
  }

  public render(frame: CameraFrame): void {
    this.resizeToDisplaySize();
    this.camera.position.set(...frame.position);
    this.camera.up.set(...frame.axes.up);
    this.lookTarget.set(
      frame.position[0] + frame.axes.forward[0],
      frame.position[1] + frame.axes.forward[1],
      frame.position[2] + frame.axes.forward[2],
    );
    this.camera.lookAt(this.lookTarget);
    for (const listener of this.beforeRenderListeners) listener(this.camera);
    for (const system of this.visualSystems) {
      system.beforeRender?.(this.renderer, this.camera);
    }
    this.renderer.render(this.scene, this.camera);
  }

  public addWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.add(object);
  }

  public removeWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.remove(object);
  }

  /** 玩家、场景组件或玩法效果写入当前场景草地的统一入口。 */
  public applyImpulse(impulse: GrassBendImpulse): void {
    this.grassInteraction?.applyImpulse(impulse);
  }

  public get grassInteractionTarget(): GrassInteractionTarget | undefined {
    return this.grassInteraction;
  }

  public onBeforeRender(listener: SceneBeforeRenderListener): () => void {
    this.beforeRenderListeners.add(listener);
    return () => this.beforeRenderListeners.delete(listener);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    for (const system of this.visualSystems) system.update(deltaSeconds, elapsedSeconds, context);
  }

  public syncActors(snapshots: readonly SnapshotActor[], serverTime: number): void {
    this.actorSnapshotTarget?.syncSnapshots(snapshots, serverTime);
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

  public pickActorInteraction(frame: CameraFrame): ActorInteractionCandidate | undefined {
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

  public setHoveredActorId(actorId?: string): void {
    this.actorSnapshotTarget?.setHoveredActorId(actorId);
  }

  public setInteractionMarkerActorId(actorId?: string, inputLabel?: string): void {
    this.actorSnapshotTarget?.setInteractionMarkerActorId(actorId, inputLabel);
  }

  public getVesselHudState(playerId: string): VesselHudState | undefined {
    return this.actorSnapshotTarget?.getVesselHudState(playerId);
  }

  /**
   * 圆形移动体的水平推出。候选由场景碰撞网格给出，Actor 与流式 chunk 的
   * 静态物件都在里面，成本只跟身边的碰撞体密度有关。
   */
  public resolveSimpleCollision(
    position: { x: number; z: number },
    radius: number,
  ): { x: number; z: number } {
    // Actor 的盒子每帧刷新一次，先让 Actor System 兑现待登记的变更。
    this.actorSnapshotTarget?.refreshColliders();
    return this.collisionWorld?.resolveCircle(position, radius) ?? position;
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
    return this.collisionWorld?.sweepSphere(start, end, radius) ?? 1;
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    this.simpleCollisionVisible = visible;
    this.actorSnapshotTarget?.setSimpleCollisionVisible(visible);
  }

  public get isSimpleCollisionVisible(): boolean {
    return this.simpleCollisionVisible;
  }

  /**
   * 加载场景。worldSeed 来自房间，决定流式世界长什么样；
   * 不做流式加载的场景会忽略它。
   */
  public loadScene(definition: SceneDefinition, worldSeed?: number): void {
    if (definition.renderer.type !== 'line-art') {
      throw new Error(`不支持的场景渲染器：${definition.renderer.type as string}`);
    }
    this.replaceScene(createLineArtScene(definition, worldSeed));
  }

  public showEmptyScene(): void {
    this.replaceScene({ scene: createEmptyScene(), visualSystems: [] });
  }

  private replaceScene(composition: SceneComposition): void {
    for (const system of this.visualSystems) system.dispose?.();
    this.scene.remove(this.dynamicWorld);
    disposeScene(this.scene);
    // 碰撞世界随场景走：上一张地图的 chunk 与 Actor 碰撞体一起被丢掉，
    // 不会有残留的盒子挡住新地图里的路。
    this.collisionWorld?.clear();
    this.scene = composition.scene;
    this.visualSystems = composition.visualSystems;
    this.grassInteraction = composition.grassInteraction;
    this.actorSnapshotTarget = composition.actorSnapshotTarget;
    this.collisionWorld = composition.collisionWorld;
    this.actorSnapshotTarget?.setSimpleCollisionVisible(this.simpleCollisionVisible);
    this.scene.add(this.dynamicWorld);
  }

  private resizeToDisplaySize(): void {
    const canvas = this.renderer.domElement;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const requiredWidth = Math.floor(width * pixelRatio);
    const requiredHeight = Math.floor(height * pixelRatio);

    if (canvas.width !== requiredWidth || canvas.height !== requiredHeight) {
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
}

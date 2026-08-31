import * as THREE from 'three';
import type { CameraFrame } from '../camera/CameraTransform';
import { createLineArtScene } from '../scene/createLineArtScene';
import type { SceneUpdateContext, SceneVisualSystem } from '../scene/SceneVisualSystem';
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

export class SceneRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private scene = createEmptyScene();
  private visualSystems: SceneVisualSystem[] = [];
  private readonly dynamicWorld = new THREE.Group();
  private readonly lookTarget = new THREE.Vector3();

  public constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(EMPTY_SCENE_COLOR, 1);
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
    this.renderer.render(this.scene, this.camera);
  }

  public addWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.add(object);
  }

  public removeWorldObject(object: THREE.Object3D): void {
    this.dynamicWorld.remove(object);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    context?: SceneUpdateContext,
  ): void {
    for (const system of this.visualSystems) system.update(deltaSeconds, elapsedSeconds, context);
  }

  /**
   * 加载场景。worldSeed 来自房间，决定流式世界长什么样；
   * 不做流式加载的场景会忽略它。
   */
  public loadScene(definition: SceneDefinition, worldSeed?: number): void {
    if (definition.renderer.type !== 'line-art') {
      throw new Error(`不支持的场景渲染器：${definition.renderer.type as string}`);
    }
    const composition = createLineArtScene(definition, worldSeed);
    this.replaceScene(composition.scene, composition.visualSystems);
  }

  public showEmptyScene(): void {
    this.replaceScene(createEmptyScene(), []);
  }

  private replaceScene(nextScene: THREE.Scene, visualSystems: SceneVisualSystem[]): void {
    this.scene.remove(this.dynamicWorld);
    // 先让场景系统释放自己持有的资源（材质、共用几何体），
    // 再走通用的遍历释放，避免把只有系统自己知道的东西漏在显存里。
    for (const system of this.visualSystems) system.dispose?.();
    disposeScene(this.scene);
    this.scene = nextScene;
    this.visualSystems = visualSystems;
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

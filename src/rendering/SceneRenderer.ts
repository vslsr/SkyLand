import * as THREE from 'three';
import type { CameraFrame } from '../camera/CameraTransform';
import { createLineArtScene } from '../scene/createLineArtScene';

export class SceneRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly scene = createLineArtScene();
  private readonly lookTarget = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();

  public constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0xfdfbf6, 1);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
  }

  /**
   * 更新相机与视锥。和 `render` 分开是为了让调用方能在两者之间做自己的可见性
   * 剔除——按包围盒剔除整块地形，比 three 逐物体的包围球判定紧得多。
   */
  public prepare(frame: CameraFrame): void {
    this.resizeToDisplaySize();
    this.camera.position.set(...frame.position);
    this.camera.up.set(...frame.axes.up);
    this.lookTarget.set(
      frame.position[0] + frame.axes.forward[0],
      frame.position[1] + frame.axes.forward[1],
      frame.position[2] + frame.axes.forward[2],
    );
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.viewProjection);
  }

  public isBoxVisible(box: THREE.Box3): boolean {
    return this.frustum.intersectsBox(box);
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  public addWorldObject(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  public removeWorldObject(object: THREE.Object3D): void {
    this.scene.remove(object);
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

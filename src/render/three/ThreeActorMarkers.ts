import * as THREE from 'three';
import {
  createInteractionMarkerVisual,
  type InteractionMarkerVisual,
} from '../../models/actors/createInteractionMarkerVisual';
import {
  createTemperatureMarkerVisual,
  type TemperatureMarkerVisual,
} from '../../models/actors/createTemperatureMarkerVisual';

/**
 * 挂在一个 proxy 权威 root 上的两块世界 UI（引擎迁移路线图 第 1.5 步）。
 *
 * 这两块曾经是 `InteractionMarkerComponent` / `TemperatureMarkerComponent`，
 * 直接把 `THREE.Object3D` 挂在 Actor 上。搬进渲染世界之后 Actor 那侧什么都不剩：
 * 「要不要标记」在 `createMeshProxy` 时一次性说明，温度值走参数段，
 * 选中哪一个由场景级命令指定。
 *
 * **必须挂在权威 root 上，不是 visualRoot**。船体波动写 `visualRoot`、附着写
 * `attachmentVisualRoot`；标记挂到那两处会跟着一起摇。
 */
export class ThreeActorMarkers {
  private interaction?: InteractionMarkerVisual;
  private temperature?: TemperatureMarkerVisual;
  private temperatureValue = 0;
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly parentQuaternion = new THREE.Quaternion();
  private readonly worldPosition = new THREE.Vector3();

  public constructor(private readonly host: THREE.Object3D) {}

  public attachInteraction(anchorY: number): void {
    if (this.interaction) return;
    this.interaction = createInteractionMarkerVisual();
    this.interaction.root.position.y = anchorY;
    this.host.add(this.interaction.root);
  }

  public attachTemperature(anchorX: number, anchorY: number, initialTemperature: number): void {
    if (this.temperature) return;
    this.temperature = createTemperatureMarkerVisual();
    this.temperature.root.position.set(anchorX, anchorY, 0);
    this.temperatureValue = initialTemperature;
    this.host.add(this.temperature.root);
  }

  public get hasInteraction(): boolean {
    return this.interaction !== undefined;
  }

  public get interactionVisible(): boolean {
    return this.interaction?.root.visible === true;
  }

  public get interactionLabel(): string {
    return String(this.interaction?.root.userData.controlLabel ?? '');
  }

  public get temperatureVisible(): boolean {
    return this.temperature?.root.visible === true;
  }

  public get temperatureLabel(): string {
    return String(this.temperature?.root.userData.temperatureLabel ?? '');
  }

  /** 选中态与按键字面量一起给：没选中就是空标签 + 不可见。 */
  public setInteraction(label: string, visible: boolean): void {
    if (!this.interaction) return;
    this.interaction.setLabel(visible ? label : '');
    this.interaction.root.visible = visible;
  }

  /**
   * 温度值每帧从参数段流进来。惰性重绘是有意设计，三层早退都要留着：
   * 不可见时不画、标签没变时不画（工厂内部）、开关没变时不动。
   */
  public setTemperature(temperature: number): void {
    if (!this.temperature || !Number.isFinite(temperature)) return;
    this.temperatureValue = temperature;
    if (this.temperatureVisible) this.temperature.setTemperature(temperature);
  }

  public setTemperatureVisible(visible: boolean): void {
    if (!this.temperature || visible === this.temperatureVisible) return;
    this.temperature.root.visible = visible;
    if (visible) this.temperature.setTemperature(this.temperatureValue);
  }

  /**
   * 让两块牌子正对相机。
   *
   * `host.updateWorldMatrix` 不是保险而是必需：`beforeRender` 跑在
   * `renderer.render` 之前，此时本帧 `submitTransforms` 刚写完局部
   * position / rotation，`matrixWorld` 还停在上一帧。漏掉这行牌子会稳定滞后一帧。
   *
   * 「求逆再乘」化掉父朝向，前提是 `submitTransforms` 只写 `root.rotation.y`、
   * 整条 root 链是纯 yaw。
   */
  public faceCamera(camera: THREE.Camera): void {
    if (!this.interactionVisible && !this.temperatureVisible) return;
    this.host.updateWorldMatrix(true, false);
    camera.getWorldQuaternion(this.cameraQuaternion);
    this.host.getWorldQuaternion(this.parentQuaternion).invert();
    if (this.interactionVisible && this.interaction) {
      this.orient(this.interaction.root, camera, 0.09, 0.88, 1.55);
    }
    if (this.temperatureVisible && this.temperature) {
      this.orient(this.temperature.root, camera, 0.075, 0.72, 1.35);
    }
  }

  public dispose(): void {
    for (const visual of [this.interaction, this.temperature]) {
      if (!visual) continue;
      visual.root.parent?.remove(visual.root);
      visual.dispose();
    }
    this.interaction = undefined;
    this.temperature = undefined;
  }

  private orient(
    root: THREE.Object3D,
    camera: THREE.Camera,
    scalePerMeter: number,
    minimumScale: number,
    maximumScale: number,
  ): void {
    root.quaternion.copy(this.parentQuaternion).multiply(this.cameraQuaternion);
    const distance = camera.position.distanceTo(root.getWorldPosition(this.worldPosition));
    root.scale.setScalar(
      THREE.MathUtils.clamp(distance * scalePerMeter, minimumScale, maximumScale),
    );
  }
}

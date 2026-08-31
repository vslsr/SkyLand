import * as THREE from 'three';
import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import { createTemperatureMarkerVisual } from '../../models/actors/createTemperatureMarkerVisual';

export const TEMPERATURE_MARKER_COMPONENT = 'temperature-marker';

/** 客户端开发用世界温度标签；权威温度仍由 TemperatureComponent 提供。 */
export class TemperatureMarkerComponent extends ActorComponent {
  private readonly visual = createTemperatureMarkerVisual();
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly parentQuaternion = new THREE.Quaternion();
  private temperature: number;

  public constructor(
    private readonly host: THREE.Object3D,
    anchorX: number,
    anchorY: number,
    initialTemperature: number,
  ) {
    super(TEMPERATURE_MARKER_COMPONENT);
    this.temperature = initialTemperature;
    this.visual.root.position.set(anchorX, anchorY, 0);
  }

  public get visible(): boolean {
    return this.visual.root.visible;
  }

  public get label(): string {
    return String(this.visual.root.userData.temperatureLabel ?? '');
  }

  public setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visual.root.visible = visible;
    if (visible) this.visual.setTemperature(this.temperature);
  }

  public setTemperature(temperature: number): void {
    if (!Number.isFinite(temperature)) return;
    this.temperature = temperature;
    if (this.visible) this.visual.setTemperature(temperature);
  }

  public faceCamera(camera: THREE.Camera): void {
    if (!this.visible) return;
    this.host.updateWorldMatrix(true, false);
    camera.getWorldQuaternion(this.cameraQuaternion);
    this.host.getWorldQuaternion(this.parentQuaternion).invert();
    this.visual.root.quaternion.copy(this.parentQuaternion).multiply(this.cameraQuaternion);
    const distance = camera.position.distanceTo(
      this.visual.root.getWorldPosition(_temperatureMarkerWorldPosition),
    );
    const scale = THREE.MathUtils.clamp(distance * 0.075, 0.72, 1.35);
    this.visual.root.scale.setScalar(scale);
  }

  public override onBeginPlay(): void {
    this.host.add(this.visual.root);
  }

  public override onEndPlay(): void {
    this.visual.dispose();
  }
}

const _temperatureMarkerWorldPosition = new THREE.Vector3();

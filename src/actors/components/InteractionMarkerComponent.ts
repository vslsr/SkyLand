import * as THREE from 'three';
import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import { createInteractionMarkerVisual } from '../../models/actors/createInteractionMarkerVisual';

export const INTERACTION_MARKER_COMPONENT = 'interaction-marker';

/** 可挂到任意 Actor 权威根节点上的相机朝向世界 UI。 */
export class InteractionMarkerComponent extends ActorComponent {
  private readonly visual = createInteractionMarkerVisual();
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly parentQuaternion = new THREE.Quaternion();

  public constructor(
    private readonly host: THREE.Object3D,
    anchorY: number,
  ) {
    super(INTERACTION_MARKER_COMPONENT);
    this.visual.root.position.y = anchorY;
  }

  public get visible(): boolean {
    return this.visual.root.visible;
  }

  public setVisible(visible: boolean): void {
    this.visual.root.visible = visible;
  }

  public setLabel(label: string): void {
    this.visual.setLabel(label);
  }

  public faceCamera(camera: THREE.Camera): void {
    if (!this.visible) return;
    this.host.updateWorldMatrix(true, false);
    camera.getWorldQuaternion(this.cameraQuaternion);
    this.host.getWorldQuaternion(this.parentQuaternion).invert();
    this.visual.root.quaternion.copy(this.parentQuaternion).multiply(this.cameraQuaternion);
    const distance = camera.position.distanceTo(this.visual.root.getWorldPosition(_markerWorldPosition));
    const scale = THREE.MathUtils.clamp(distance * 0.09, 0.88, 1.55);
    this.visual.root.scale.setScalar(scale);
  }

  public override onBeginPlay(): void {
    this.host.add(this.visual.root);
  }

  public override onEndPlay(): void {
    this.visual.dispose();
  }
}

const _markerWorldPosition = new THREE.Vector3();

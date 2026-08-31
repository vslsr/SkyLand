import * as THREE from 'three';
import type { GrassInteractionTarget } from './GrassInteraction';

interface PendingPointer {
  clientX: number;
  clientY: number;
}

/** 场景组件使用的适配器：把鼠标移动转换成通用草地冲量。 */
export class MouseGrassInteractor {
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly pointerNdc = new THREE.Vector2();
  private readonly worldPoint = new THREE.Vector3();
  private readonly previousWorldPoint = new THREE.Vector3();
  private pendingPointer?: PendingPointer;
  private hasPreviousWorldPoint = false;

  public constructor(
    private readonly element: HTMLElement,
    private readonly target: GrassInteractionTarget,
  ) {
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerleave', this.handlePointerLeave);
  }

  public update(camera: THREE.Camera): void {
    const pointer = this.pendingPointer;
    if (!pointer) return;
    this.pendingPointer = undefined;
    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    this.pointerNdc.set(
      ((pointer.clientX - rect.left) / rect.width) * 2 - 1,
      -((pointer.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.worldPoint)) {
      this.hasPreviousWorldPoint = false;
      return;
    }

    if (this.hasPreviousWorldPoint) {
      const directionX = this.worldPoint.x - this.previousWorldPoint.x;
      const directionZ = this.worldPoint.z - this.previousWorldPoint.z;
      const distance = Math.hypot(directionX, directionZ);
      if (distance > 0.004) {
        const strength = THREE.MathUtils.clamp(distance / 0.24, 0.12, 1);
        this.target.applyImpulse({
          position: { x: this.worldPoint.x, z: this.worldPoint.z },
          direction: { x: directionX, z: directionZ },
          radius: 0.5 + strength * 0.28,
          strength,
        });
      }
    }

    this.previousWorldPoint.copy(this.worldPoint);
    this.hasPreviousWorldPoint = true;
  }

  public dispose(): void {
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerleave', this.handlePointerLeave);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.pendingPointer = { clientX: event.clientX, clientY: event.clientY };
  };

  private readonly handlePointerLeave = (): void => {
    this.pendingPointer = undefined;
    this.hasPreviousWorldPoint = false;
  };
}

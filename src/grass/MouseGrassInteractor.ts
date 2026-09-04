import type { RenderCamera } from '../render/RenderCameraBuffer';
import { computeCameraRay, intersectRayWithHorizontalPlane } from '../camera/cameraRay';
import type { GrassInteractionTarget } from './GrassInteraction';

interface PendingPointer {
  clientX: number;
  clientY: number;
}

/** 视口的投影参数。构造射线只要这两个，不需要一个相机对象。 */
export interface PointerViewport {
  readonly fovRadians: number;
  readonly aspect: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * 场景组件使用的适配器：把鼠标移动转换成通用草地冲量。
 *
 * 它**是输入，不是渲染**——`getBoundingClientRect` 决定了它得留在主线程
 * （实现路径文档 §3）。但它原来要一个 `THREE.Camera` 才能反投影：
 * `raycaster.setFromCamera(ndc, camera)`。那个相机住在渲染世界里，
 * 于是这个输入适配器每帧都要从渲染侧回调一次。
 *
 * 现在自己算。反投影要的东西主线程本来就有：机位与朝向（那段相机字节正是它写的）、
 * 视场角、视口宽高比。和准星拾取改成解析求交是同一个道理——**需要的是数，
 * 不是那个对象**。
 */
export class MouseGrassInteractor {
  private pendingPointer?: PendingPointer;
  private hasPreviousWorldPoint = false;
  private previousX = 0;
  private previousZ = 0;

  public constructor(
    private readonly element: HTMLElement,
    private readonly target: GrassInteractionTarget,
  ) {
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerleave', this.handlePointerLeave);
  }

  public update(camera: RenderCamera, viewport: PointerViewport): void {
    const pointer = this.pendingPointer;
    if (!pointer) return;
    this.pendingPointer = undefined;
    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const ndcX = ((pointer.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((pointer.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = this.#intersectGround(camera, viewport, ndcX, ndcY);
    if (!hit) {
      this.hasPreviousWorldPoint = false;
      return;
    }

    if (this.hasPreviousWorldPoint) {
      const directionX = hit.x - this.previousX;
      const directionZ = hit.z - this.previousZ;
      const distance = Math.hypot(directionX, directionZ);
      if (distance > 0.004) {
        const strength = clamp(distance / 0.24, 0.12, 1);
        this.target.applyImpulse({
          position: { x: hit.x, z: hit.z },
          direction: { x: directionX, z: directionZ },
          radius: 0.5 + strength * 0.28,
          strength,
        });
      }
    }

    this.previousX = hit.x;
    this.previousZ = hit.z;
    this.hasPreviousWorldPoint = true;
  }

  public dispose(): void {
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerleave', this.handlePointerLeave);
  }

  /**
   * 屏幕坐标 → 地面（y = 0）交点。射线由共享的相机数学算，这里只做与地面求交。
   */
  #intersectGround(
    camera: RenderCamera,
    viewport: PointerViewport,
    ndcX: number,
    ndcY: number,
  ): { x: number; z: number } | undefined {
    const ray = computeCameraRay(camera, viewport, ndcX, ndcY);
    if (!ray) return undefined;
    const hit = intersectRayWithHorizontalPlane(ray.origin, ray.direction, 0);
    return hit ? { x: hit.x, z: hit.z } : undefined;
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.pendingPointer = { clientX: event.clientX, clientY: event.clientY };
  };

  private readonly handlePointerLeave = (): void => {
    this.pendingPointer = undefined;
    this.hasPreviousWorldPoint = false;
  };
}

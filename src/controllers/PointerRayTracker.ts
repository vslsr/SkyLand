import { computeCameraRay, type CameraRayViewport, type WorldRay } from '../camera/cameraRay';
import type { RenderCamera } from '../render/RenderCameraBuffer';

/**
 * 记住指针最后停在画布上的哪一点，按需换算成世界射线。
 *
 * 它**是输入，不是渲染**——`getBoundingClientRect` 决定了它得留在主线程。反投影
 * 要的机位、视场角与宽高比主线程本来就有，所以不需要回头问渲染世界。
 *
 * 指针离开画布之后射线就没有了（返回 undefined），调用方退回准星（相机正前方）。
 */
export class PointerRayTracker {
  private pointer?: { clientX: number; clientY: number };

  public constructor(private readonly element: HTMLElement) {
    this.element.addEventListener('pointermove', this.handlePointer);
    this.element.addEventListener('pointerdown', this.handlePointer);
    this.element.addEventListener('pointerleave', this.handlePointerLeave);
  }

  public get available(): boolean {
    return this.pointer !== undefined;
  }

  public resolve(view: { camera: RenderCamera; viewport: CameraRayViewport }): WorldRay | undefined {
    const pointer = this.pointer;
    if (!pointer) return undefined;
    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const ndcX = ((pointer.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((pointer.clientY - rect.top) / rect.height) * 2 + 1;
    return computeCameraRay(view.camera, view.viewport, ndcX, ndcY);
  }

  public dispose(): void {
    this.element.removeEventListener('pointermove', this.handlePointer);
    this.element.removeEventListener('pointerdown', this.handlePointer);
    this.element.removeEventListener('pointerleave', this.handlePointerLeave);
    this.pointer = undefined;
  }

  private readonly handlePointer = (event: PointerEvent): void => {
    // 触屏没有悬停：一次按下就是「指到这里」，抬起后仍然记着最后那一点。
    this.pointer = { clientX: event.clientX, clientY: event.clientY };
  };

  private readonly handlePointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.pointer = undefined;
  };
}

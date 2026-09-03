import type { CameraFrame } from '../camera/CameraTransform';
import type {
  ProxyId,
  SlimeSurfaceDragRay,
  SlimeSurfaceDragState,
} from '../render/RenderScene';
import {
  PlayerInputTags,
  type InputActionEvent,
  type InputSubsystem,
} from '../input/index';

const CAMERA_FIELD_OF_VIEW_RADIANS = 50 * Math.PI / 180;

/**
 * 渲染世界里能被拖拽蒙皮的那一面。`ThreeRenderScene` 结构上满足它，
 * 所以这个文件不 import 任何渲染实现，只认识 `ProxyId`。
 */
export interface SlimeSurfaceDragSurface {
  isSlimeSurfaceDragging(id: ProxyId): boolean;
  beginSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): boolean;
  updateSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): boolean;
  endSlimeSurfaceDrag(id: ProxyId): void;
  readSlimeSurfaceDrag(id: ProxyId, out: SlimeSurfaceDragState): boolean;
}

/**
 * 把语义化 Primary 输入与光标坐标适配成世界射线。
 *
 * 指针、相机和外壳都在渲染这一侧，所以这个控制器整体属于渲染侧；
 * 它往玩法侧只发一个布尔（`onDragActiveChanged`），用来让一次手势只有一个所有者。
 */
export class SlimeSurfaceDragController {
  private readonly inputDisposer: () => void;
  private readonly pointer = {
    x: 0,
    y: 0,
    pressX: 0,
    pressY: 0,
    id: -1,
    available: false,
    pressAvailable: false,
  };
  private primaryDown = false;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    input: InputSubsystem,
    private readonly surface: SlimeSurfaceDragSurface,
    private readonly proxyId: ProxyId,
    private readonly getCameraFrame: () => CameraFrame,
    private readonly onDragActiveChanged?: (active: boolean) => void,
  ) {
    this.inputDisposer = input.bind(
      PlayerInputTags.Primary,
      (event) => this.handlePrimaryInput(event),
      // 拖拽只需要一次明确的按下和释放。忽略 triggered/ongoing，避免
      // 多设备 Action 在持续阶段切换来源时把一次有效鼠标拖拽误判成结束。
      { phases: ['started', 'completed', 'canceled'] },
    );
    this.canvas.addEventListener('pointerdown', this.handlePointerMove);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerenter', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
  }

  private get isDragging(): boolean {
    return this.surface.isSlimeSurfaceDragging(this.proxyId);
  }

  /**
   * 取出当前手势交给场景上报房间。射线和外壳都不出渲染世界，出去的只有六个
   * proxy 本地坐标；写进调用方自带的结构，每帧调用也不分配。
   */
  public captureReplicationState(out: SlimeSurfaceDragState): boolean {
    return this.surface.readSlimeSurfaceDrag(this.proxyId, out);
  }

  public update(): void {
    if (!this.primaryDown || !this.pointer.available) return;
    const ray = this.createPointerRay(this.pointer.x, this.pointer.y);
    if (!ray) return;
    if (this.isDragging) this.surface.updateSlimeSurfaceDrag(this.proxyId, ray);
  }

  public dispose(): void {
    this.inputDisposer();
    this.releaseDrag();
    this.canvas.removeEventListener('pointerdown', this.handlePointerMove);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerenter', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
  }

  private createPointerRay(clientX: number, clientY: number): SlimeSurfaceDragRay | undefined {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const frame = this.getCameraFrame();
    const tangent = Math.tan(CAMERA_FIELD_OF_VIEW_RADIANS / 2);
    const aspect = rect.width / rect.height;
    let directionX = (
      frame.axes.forward[0]
      + frame.axes.right[0] * ndcX * tangent * aspect
      + frame.axes.up[0] * ndcY * tangent
    );
    let directionY = (
      frame.axes.forward[1]
      + frame.axes.right[1] * ndcX * tangent * aspect
      + frame.axes.up[1] * ndcY * tangent
    );
    let directionZ = (
      frame.axes.forward[2]
      + frame.axes.right[2] * ndcX * tangent * aspect
      + frame.axes.up[2] * ndcY * tangent
    );
    const directionLength = Math.hypot(directionX, directionY, directionZ);
    if (directionLength <= 1e-8) return undefined;
    directionX /= directionLength;
    directionY /= directionLength;
    directionZ /= directionLength;
    return {
      origin: frame.position,
      direction: [directionX, directionY, directionZ],
    };
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    this.pointer.id = event.pointerId;
    this.pointer.available = true;
    if (event.type === 'pointerdown') {
      this.pointer.pressX = event.clientX;
      this.pointer.pressY = event.clientY;
      this.pointer.pressAvailable = true;
    }
    // DOM 指针移动可能发生在下一次 update 之前。拖拽已经建立后立即刷新目标，
    // 既减少一帧输入延迟，也不再依赖其他控制器的更新顺序。
    if (this.isDragging) {
      const ray = this.createPointerRay(event.clientX, event.clientY);
      if (ray) this.surface.updateSlimeSurfaceDrag(this.proxyId, ray);
    }
  };

  private readonly handlePointerLeave = (): void => {
    if (!this.isDragging) this.pointer.available = false;
  };

  private handlePrimaryInput(event: InputActionEvent): void {
    const isMousePrimary = (
      event.deviceKind === 'keyboardMouse'
      && event.sourceControl?.startsWith('Mouse.')
    );
    if (event.phase === 'completed' || event.phase === 'canceled') {
      if (event.deviceKind !== undefined && !isMousePrimary) return;
      if (this.primaryDown || this.isDragging) this.releaseDrag();
      return;
    }
    // 同一个语义标签也映射了手柄。非鼠标来源与表面指针拖拽无关，应忽略，
    // 不能用它去释放一条已经建立的鼠标拖拽链路。
    if (!isMousePrimary) return;
    if (event.value !== true || this.primaryDown) return;
    this.primaryDown = true;
    // 在 InputSubsystem 派发按下语义时立即完成拾取，让表面拖拽能在
    // 同一帧的 TopDown 更新前取消屏幕轨道旋转，一次手势只有一个所有者。
    const pressRay = this.pointer.pressAvailable
      ? this.createPointerRay(this.pointer.pressX, this.pointer.pressY)
      : this.createPointerRay(this.pointer.x, this.pointer.y);
    if (!pressRay || !this.surface.beginSlimeSurfaceDrag(this.proxyId, pressRay)) return;
    this.onDragActiveChanged?.(true);
    this.capturePointer();
    const currentRay = this.createPointerRay(this.pointer.x, this.pointer.y);
    if (currentRay) this.surface.updateSlimeSurfaceDrag(this.proxyId, currentRay);
  }

  private capturePointer(): void {
    if (this.pointer.id < 0 || !this.canvas.setPointerCapture) return;
    try {
      this.canvas.setPointerCapture(this.pointer.id);
    } catch {
      // 某些浏览器会在按键已经松开时拒绝 capture；语义输入仍会正常结束拖拽。
    }
  }

  private releaseDrag(): void {
    this.primaryDown = false;
    this.pointer.pressAvailable = false;
    this.surface.endSlimeSurfaceDrag(this.proxyId);
    this.onDragActiveChanged?.(false);
    if (
      this.pointer.id < 0
      || !this.canvas.hasPointerCapture?.(this.pointer.id)
      || !this.canvas.releasePointerCapture
    ) return;
    this.canvas.releasePointerCapture(this.pointer.id);
  }
}

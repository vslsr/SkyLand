import type { CameraFrame } from '../camera/CameraTransform';
import type {
  ProxyId,
  RenderScene,
  SlimeSurfaceDragRay,
  SlimeSurfaceDragReport,
  SlimeSurfaceDragState,
} from '../render/RenderScene';
import {
  PlayerInputTags,
  type InputActionEvent,
  type InputSubsystem,
} from '../input/index';

const CAMERA_FIELD_OF_VIEW_RADIANS = 50 * Math.PI / 180;

/**
 * 渲染世界里能被拖拽蒙皮的那一面。四个方法全部返回 `void`，它们就在 `RenderScene`
 * 上——不需要一扇绕过边界的门。
 */
export type SlimeSurfaceDragSurface = Pick<
  RenderScene,
  | 'beginSlimeSurfaceDrag'
  | 'updateSlimeSurfaceDrag'
  | 'endSlimeSurfaceDrag'
  | 'setSlimeSurfaceDragListener'
>;

/**
 * 把语义化 Primary 输入与光标坐标适配成世界射线。
 *
 * 指针与相机在主线程，外壳在渲染世界，所以这个控制器是**两侧之间的适配器**：
 * 往渲染侧发射线，往玩法侧发一个布尔（`onDragActiveChanged`），
 * 用来让一次手势只有一个所有者。
 *
 * 「这一次按下有没有抓住外壳」曾经是 `beginSlimeSurfaceDrag` 的返回值——最后一次
 * 跨边界等回话。现在改成：命令照发，抓没抓住由渲染侧回报（`#handleDragReport`）。
 * **在收到那条回报之前不认领这次手势**，所以相机轨道照常走它自己那一帧；
 * 而按下那一帧指针还没动过，攒下的轨道量是零，看不出差别。
 *
 * 单线程下那条回报在 `beginSlimeSurfaceDrag` 里同步就发了，行为逐帧不变。
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
  /** 渲染侧回报的事实：这条拖拽链路活着没有。不是这一侧猜的。 */
  private dragging = false;
  /** 最后一次回报的手势，供上报房间用。逐帧复用，不分配。 */
  private readonly replication: SlimeSurfaceDragState = {
    contactX: 0, contactY: 0, contactZ: 0, pullX: 0, pullY: 0, pullZ: 0,
  };

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    input: InputSubsystem,
    private readonly surface: SlimeSurfaceDragSurface,
    private readonly proxyId: ProxyId,
    private readonly getCameraFrame: () => CameraFrame,
    private readonly onDragActiveChanged?: (active: boolean) => void,
  ) {
    this.surface.setSlimeSurfaceDragListener((report) => this.handleDragReport(report));
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
    return this.dragging;
  }

  /**
   * 渲染侧回报「抓住了 / 松开了，拖成什么样」。
   *
   * 手势的所有权在这里易主——不在按下那一刻。手势本身（六个本地坐标）也在这里
   * 落进缓存：上报房间时读缓存，不回头去问渲染世界。
   */
  private handleDragReport(report: SlimeSurfaceDragReport): void {
    if (report.id !== this.proxyId) return;
    if (report.dragging) {
      this.replication.contactX = report.contactX;
      this.replication.contactY = report.contactY;
      this.replication.contactZ = report.contactZ;
      this.replication.pullX = report.pullX;
      this.replication.pullY = report.pullY;
      this.replication.pullZ = report.pullZ;
    }
    const dragging = report.dragging;
    if (dragging === this.dragging) return;
    this.dragging = dragging;
    if (dragging) {
      this.onDragActiveChanged?.(true);
      this.capturePointer();
      // 从按下到回报之间指针可能已经动了，补一次目标，别丢掉这段位移。
      const ray = this.pointer.available
        ? this.createPointerRay(this.pointer.x, this.pointer.y)
        : undefined;
      if (ray) this.surface.updateSlimeSurfaceDrag(this.proxyId, ray);
      return;
    }
    this.onDragActiveChanged?.(false);
    this.releasePointerCapture();
  }

  /**
   * 取出当前手势交给场景上报房间。射线和外壳都不出渲染世界，出去的只有六个
   * proxy 本地坐标；写进调用方自带的结构，每帧调用也不分配。
   *
   * 读的是**上一次回报的缓存**，不是回头去问渲染世界——后者是一次跨线程阻塞查询。
   * 上报本来就按快照频率节流，晚一帧的手势和晚一帧的快照是同一个量级。
   */
  public captureReplicationState(out: SlimeSurfaceDragState): boolean {
    if (!this.dragging) return false;
    out.contactX = this.replication.contactX;
    out.contactY = this.replication.contactY;
    out.contactZ = this.replication.contactZ;
    out.pullX = this.replication.pullX;
    out.pullY = this.replication.pullY;
    out.pullZ = this.replication.pullZ;
    return true;
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
    this.surface.setSlimeSurfaceDragListener(undefined);
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
    if (!pressRay) return;
    // 只发命令，不认领手势：抓没抓住由渲染侧回报（`handleDragReport`）。
    this.surface.beginSlimeSurfaceDrag(this.proxyId, pressRay);
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
    // 命令发出去，`dragging` 由回报翻回 false——`handleDragReport` 会顺带
    // 交还手势与指针捕获。渲染世界已经没了（换场景）时补一次兜底。
    this.surface.endSlimeSurfaceDrag(this.proxyId);
    if (this.dragging) {
      this.handleDragReport({
        id: this.proxyId, dragging: false,
        contactX: 0, contactY: 0, contactZ: 0, pullX: 0, pullY: 0, pullZ: 0,
      });
    }
  }

  private releasePointerCapture(): void {
    if (
      this.pointer.id < 0
      || !this.canvas.hasPointerCapture?.(this.pointer.id)
      || !this.canvas.releasePointerCapture
    ) return;
    this.canvas.releasePointerCapture(this.pointer.id);
  }
}

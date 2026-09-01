import type { CameraFrame } from '../camera/CameraTransform';
import type { InputSubsystem } from '../input/index';
import type { TerrainEditOperation } from '../network/messages';
import { PlayerInputTags } from '../input/config/playerInput';

export interface TerrainEditPort {
  /** 从准星射线取命中的地形格。 */
  pickCell(frame: CameraFrame): { cellX: number; cellZ: number } | undefined;
  /** 高亮一格；传 undefined 收起高亮。 */
  highlight(cell?: { cellX: number; cellZ: number }): void;
  /** 发出编辑请求。服务端确认后会广播回来，这里不做本地预测。 */
  sendEdit(cellX: number, cellZ: number, operation: TerrainEditOperation): void;
}

/**
 * 地形编辑模式的输入驱动。
 *
 * 没有选中工具时它完全不工作——`update` 直接收起高亮返回，`WorldInteract`
 * 的按下也会被丢掉。所以 UI 那边「收起栏目 = 关闭编辑」不需要额外的开关：
 * 工具清空之后这里自然就是惰性的。
 */
export class TerrainEditController {
  private operation?: TerrainEditOperation;
  private editRequested = false;
  private readonly disposeBinding: () => void;

  public constructor(
    private readonly input: InputSubsystem,
    private readonly port: TerrainEditPort,
  ) {
    this.disposeBinding = input.bind(
      PlayerInputTags.WorldInteract,
      () => { this.editRequested = true; },
      { phases: ['triggered'] },
    );
  }

  public get active(): boolean {
    return this.operation !== undefined;
  }

  public setOperation(operation?: TerrainEditOperation): void {
    this.operation = operation;
    // 切换工具时丢掉上一次没兑现的按下，避免换工具那一下误改一格。
    this.editRequested = false;
    if (!operation) this.port.highlight(undefined);
  }

  public update(frame: CameraFrame): void {
    if (!this.operation || !this.input.enabled) {
      this.editRequested = false;
      this.port.highlight(undefined);
      return;
    }
    const cell = this.port.pickCell(frame);
    this.port.highlight(cell);
    const requested = this.editRequested;
    this.editRequested = false;
    if (requested && cell) {
      this.port.sendEdit(cell.cellX, cell.cellZ, this.operation);
    }
  }

  public reset(): void {
    this.editRequested = false;
    this.port.highlight(undefined);
  }

  public dispose(): void {
    this.setOperation(undefined);
    this.reset();
    this.disposeBinding();
  }
}

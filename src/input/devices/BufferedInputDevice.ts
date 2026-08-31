import type {
  Axis2DValue,
  InputControlEvent,
  InputDevice,
  InputValue,
} from '../core/types';

function valuesEqual(left: InputValue, right: InputValue): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  return left.x === right.x && left.y === right.y;
}

/** 为事件型输入设备提供去重、缓冲和统一取消通知。 */
export abstract class BufferedInputDevice implements InputDevice {
  private readonly values = new Map<string, InputValue>();
  private readonly events: InputControlEvent[] = [];
  private readonly cancelHandlers = new Set<() => void>();

  public drainEvents(): readonly InputControlEvent[] {
    return this.events.splice(0);
  }

  /** 静默清空设备状态；统一 Cancel 由 InputSubsystem 负责派发。 */
  public reset(): void {
    this.values.clear();
    this.events.length = 0;
  }

  public onCancel(handler: () => void): () => void {
    this.cancelHandlers.add(handler);
    return () => this.cancelHandlers.delete(handler);
  }

  protected setDigital(control: string, value: boolean, timestampMs: number): void {
    this.setValue(control, value, timestampMs);
  }

  protected setAxis2D(control: string, value: Axis2DValue, timestampMs: number): void {
    const finiteValue = {
      x: Number.isFinite(value.x) ? value.x : 0,
      y: Number.isFinite(value.y) ? value.y : 0,
    };
    this.setValue(control, finiteValue, timestampMs);
  }

  protected requestCancel(): void {
    this.reset();
    for (const handler of [...this.cancelHandlers]) handler();
  }

  private setValue(control: string, value: InputValue, timestampMs: number): void {
    const previous = this.values.get(control);
    if (previous !== undefined && valuesEqual(previous, value)) return;
    this.values.set(control, value);
    this.events.push({ control, value, timestampMs });
  }
}

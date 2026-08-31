import type { Axis2DValue } from '../core/types';
import { BufferedInputDevice } from './BufferedInputDevice';

export interface VirtualInputDeviceOptions {
  readonly now?: () => number;
}

/** 供虚拟摇杆、触摸按钮和测试代码写入输入。 */
export class VirtualInputDevice extends BufferedInputDevice {
  private readonly now: () => number;

  public constructor(options: VirtualInputDeviceOptions = {}) {
    super();
    this.now = options.now ?? (() => performance.now());
  }

  public setDigital(control: string, value: boolean, timestampMs = this.now()): void {
    this.assertVirtualControl(control);
    super.setDigital(control, value, timestampMs);
  }

  public setAxis2D(control: string, value: Axis2DValue, timestampMs = this.now()): void {
    this.assertVirtualControl(control);
    super.setAxis2D(control, value, timestampMs);
  }

  /** 模拟失焦或触摸被系统中断。 */
  public cancel(): void {
    this.requestCancel();
  }

  private assertVirtualControl(control: string): void {
    if (!control.startsWith('Virtual.') || control.length === 'Virtual.'.length) {
      throw new TypeError(`虚拟控制路径必须以 Virtual. 开头：${control}`);
    }
  }
}

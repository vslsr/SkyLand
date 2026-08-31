import type { Axis2DValue } from '../core/types';
import { BufferedInputDevice } from './BufferedInputDevice';

export interface GamepadButtonSnapshot {
  readonly pressed: boolean;
  readonly value: number;
}

export interface GamepadSnapshot {
  readonly connected: boolean;
  readonly index: number;
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<GamepadButtonSnapshot>;
}

export interface GamepadInputDeviceOptions {
  readonly getGamepads?: () => ArrayLike<GamepadSnapshot | null>;
  readonly gamepadIndex?: number;
  readonly stickNoiseThreshold?: number;
  readonly buttonThreshold?: number;
}

const STANDARD_BUTTON_CONTROLS = [
  'Gamepad.ButtonSouth',
  'Gamepad.ButtonEast',
  'Gamepad.ButtonWest',
  'Gamepad.ButtonNorth',
  'Gamepad.LeftBumper',
  'Gamepad.RightBumper',
  'Gamepad.LeftTrigger',
  'Gamepad.RightTrigger',
  'Gamepad.Back',
  'Gamepad.Start',
  'Gamepad.LeftStickButton',
  'Gamepad.RightStickButton',
  'Gamepad.DPadUp',
  'Gamepad.DPadDown',
  'Gamepad.DPadLeft',
  'Gamepad.DPadRight',
  'Gamepad.Home',
] as const;

/** 轮询浏览器标准 Gamepad 布局，并转换为 Gamepad.* 控制路径。 */
export class GamepadInputDevice extends BufferedInputDevice {
  private readonly getGamepads: () => ArrayLike<GamepadSnapshot | null>;
  private readonly preferredIndex?: number;
  private readonly stickNoiseThreshold: number;
  private readonly buttonThreshold: number;
  private connected = false;

  public constructor(options: GamepadInputDeviceOptions = {}) {
    super('gamepad');
    this.getGamepads = options.getGamepads ?? (() => (
      typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? navigator.getGamepads()
        : []
    ));
    this.preferredIndex = options.gamepadIndex;
    this.stickNoiseThreshold = options.stickNoiseThreshold ?? 0.04;
    this.buttonThreshold = options.buttonThreshold ?? 0.5;
  }

  public poll(timestampMs: number): void {
    const gamepad = this.selectGamepad(this.getGamepads());
    if (!gamepad) {
      if (this.connected) this.releaseAll(timestampMs);
      this.connected = false;
      return;
    }

    this.connected = true;
    this.setAxis2D('Gamepad.LeftStick', this.readStick(gamepad, 0, 1), timestampMs);
    this.setAxis2D('Gamepad.RightStick', this.readStick(gamepad, 2, 3), timestampMs);
    STANDARD_BUTTON_CONTROLS.forEach((control, index) => {
      const button = gamepad.buttons[index];
      this.setDigital(
        control,
        Boolean(button?.pressed || Number(button?.value ?? 0) >= this.buttonThreshold),
        timestampMs,
      );
    });
  }

  public dispose(): void {
    this.connected = false;
    this.reset();
  }

  private selectGamepad(
    gamepads: ArrayLike<GamepadSnapshot | null>,
  ): GamepadSnapshot | undefined {
    for (let index = 0; index < gamepads.length; index += 1) {
      const gamepad = gamepads[index];
      if (!gamepad?.connected) continue;
      if (this.preferredIndex === undefined || gamepad.index === this.preferredIndex) return gamepad;
    }
    return undefined;
  }

  private readStick(gamepad: GamepadSnapshot, xIndex: number, yIndex: number): Axis2DValue {
    const x = this.quantize(Number(gamepad.axes[xIndex] ?? 0));
    const y = this.quantize(Number(gamepad.axes[yIndex] ?? 0));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
    if (Math.hypot(x, y) <= this.stickNoiseThreshold) return { x: 0, y: 0 };
    return { x, y };
  }

  private releaseAll(timestampMs: number): void {
    this.setAxis2D('Gamepad.LeftStick', { x: 0, y: 0 }, timestampMs);
    this.setAxis2D('Gamepad.RightStick', { x: 0, y: 0 }, timestampMs);
    for (const control of STANDARD_BUTTON_CONTROLS) {
      this.setDigital(control, false, timestampMs);
    }
  }

  private quantize(value: number): number {
    return Math.round(value * 10_000) / 10_000;
  }
}

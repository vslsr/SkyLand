import { BufferedInputDevice } from './BufferedInputDevice';

export interface KeyboardMouseInputDeviceOptions {
  readonly keyboardTarget?: Document;
  readonly pointerTarget?: HTMLElement;
  readonly preventDefaultControls?: Iterable<string>;
}

/** 将浏览器键盘和鼠标按钮转换为稳定的控制路径。 */
export class KeyboardMouseInputDevice extends BufferedInputDevice {
  private readonly keyboardTarget: Document;
  private readonly pointerTarget: HTMLElement;
  private readonly preventDefaultControls: Set<string>;
  private readonly pressedKeys = new Set<string>();
  private readonly pressedButtons = new Set<number>();

  public constructor(options: KeyboardMouseInputDeviceOptions = {}) {
    super('keyboardMouse');
    this.keyboardTarget = options.keyboardTarget ?? document;
    this.pointerTarget = options.pointerTarget ?? document.documentElement;
    this.preventDefaultControls = new Set(options.preventDefaultControls);
    this.bindEvents();
  }

  public override reset(): void {
    super.reset();
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }

  public dispose(): void {
    this.keyboardTarget.removeEventListener('keydown', this.handleKeyDown);
    this.keyboardTarget.removeEventListener('keyup', this.handleKeyUp);
    this.pointerTarget.removeEventListener('pointerdown', this.handlePointerDown);
    this.pointerTarget.removeEventListener('pointerup', this.handlePointerUp);
    this.pointerTarget.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('blur', this.handleFocusLoss);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.reset();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || this.isTextEntry(event.target)) return;
    const control = `Keyboard.${event.code}`;
    if (this.pressedKeys.has(event.code)) return;
    this.pressedKeys.add(event.code);
    this.setDigital(control, true, event.timeStamp);
    if (this.preventDefaultControls.has(control) && event.cancelable) event.preventDefault();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (!this.pressedKeys.delete(event.code)) return;
    const control = `Keyboard.${event.code}`;
    this.setDigital(control, false, event.timeStamp);
    if (this.preventDefaultControls.has(control) && event.cancelable) event.preventDefault();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.pressedButtons.has(event.button)) return;
    this.pressedButtons.add(event.button);
    this.setDigital(`Mouse.Button${event.button}`, true, event.timeStamp);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.pressedButtons.delete(event.button)) return;
    this.setDigital(`Mouse.Button${event.button}`, false, event.timeStamp);
  };

  private readonly handlePointerCancel = (): void => this.requestCancel();

  private readonly handleFocusLoss = (): void => this.requestCancel();

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') this.requestCancel();
  };

  private bindEvents(): void {
    this.keyboardTarget.addEventListener('keydown', this.handleKeyDown);
    this.keyboardTarget.addEventListener('keyup', this.handleKeyUp);
    this.pointerTarget.addEventListener('pointerdown', this.handlePointerDown);
    this.pointerTarget.addEventListener('pointerup', this.handlePointerUp);
    this.pointerTarget.addEventListener('pointercancel', this.handlePointerCancel);
    window.addEventListener('blur', this.handleFocusLoss);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private isTextEntry(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable);
  }
}

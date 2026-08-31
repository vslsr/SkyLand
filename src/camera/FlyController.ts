import { CameraTransform, type CameraFrame, type CameraTransformOptions } from './CameraTransform';

export interface FlyControllerOptions extends CameraTransformOptions {
  moveSpeed?: number;
  lookSpeed?: number;
  enabled?: boolean;
  onLockChange?: (locked: boolean) => void;
}

export class FlyController {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: CameraTransform;
  private readonly pressedKeys = new Set<string>();
  private moveSpeed: number;
  private readonly lookSpeed: number;
  private readonly onLockChange?: (locked: boolean) => void;
  private inputEnabled: boolean;

  public constructor(canvas: HTMLCanvasElement, options: FlyControllerOptions = {}) {
    this.canvas = canvas;
    this.camera = new CameraTransform(options);
    this.moveSpeed = options.moveSpeed ?? 6.5;
    this.lookSpeed = options.lookSpeed ?? 0.0018;
    this.inputEnabled = options.enabled ?? true;
    this.onLockChange = options.onLockChange;
    this.bindEvents();
  }

  public get frame(): CameraFrame {
    return this.camera.frame;
  }

  public get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  public setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) this.pressedKeys.clear();
  }

  public update(deltaSeconds: number): void {
    if (!this.inputEnabled || !this.locked) return;

    const localRight = Number(this.pressedKeys.has('KeyD')) - Number(this.pressedKeys.has('KeyA'));
    const localUp =
      Number(this.pressedKeys.has('Space')) -
      Number(this.pressedKeys.has('KeyC') || this.pressedKeys.has('ControlLeft'));
    const localForward = Number(this.pressedKeys.has('KeyW')) - Number(this.pressedKeys.has('KeyS'));
    const sprint = this.pressedKeys.has('ShiftLeft') || this.pressedKeys.has('ShiftRight') ? 2.5 : 1;

    this.camera.moveLocal(
      [localRight, localUp, localForward],
      this.moveSpeed * sprint * deltaSeconds,
    );
  }

  public configure(options: CameraTransformOptions & { moveSpeed?: number }): void {
    this.camera.setPose(options);
    if (options.moveSpeed !== undefined && options.moveSpeed > 0) {
      this.moveSpeed = options.moveSpeed;
    }
    this.pressedKeys.clear();
  }

  public requestLock(): void {
    if (!this.inputEnabled) return;
    void this.canvas.requestPointerLock().catch(() => {
      // Embedded preview surfaces may reject pointer lock.
    });
  }

  public dispose(): void {
    this.canvas.removeEventListener('click', this.handleCanvasClick);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    window.removeEventListener('blur', this.clearPressedKeys);
    this.pressedKeys.clear();
  }

  private readonly handleCanvasClick = (): void => this.requestLock();

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.inputEnabled || !this.locked) return;
    this.pressedKeys.add(event.code);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) event.preventDefault();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressedKeys.delete(event.code);
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.inputEnabled || !this.locked) return;
    this.camera.rotate(event.movementX * this.lookSpeed, -event.movementY * this.lookSpeed);
  };

  private readonly handlePointerLockChange = (): void => {
    this.pressedKeys.clear();
    this.onLockChange?.(this.locked);
  };

  private readonly clearPressedKeys = (): void => this.pressedKeys.clear();

  private bindEvents(): void {
    this.canvas.addEventListener('click', this.handleCanvasClick);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    window.addEventListener('blur', this.clearPressedKeys);
  }
}

import { CameraTransform, type CameraFrame, type CameraTransformOptions } from './CameraTransform';

export interface FlyControllerOptions extends CameraTransformOptions {
  moveSpeed?: number;
  lookSpeed?: number;
  onLockChange?: (locked: boolean) => void;
}

export class FlyController {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: CameraTransform;
  private readonly pressedKeys = new Set<string>();
  private readonly moveSpeed: number;
  private readonly lookSpeed: number;
  private readonly onLockChange?: (locked: boolean) => void;

  public constructor(canvas: HTMLCanvasElement, options: FlyControllerOptions = {}) {
    this.canvas = canvas;
    this.camera = new CameraTransform(options);
    this.moveSpeed = options.moveSpeed ?? 6.5;
    this.lookSpeed = options.lookSpeed ?? 0.0018;
    this.onLockChange = options.onLockChange;
    this.bindEvents();
  }

  public get frame(): CameraFrame {
    return this.camera.frame;
  }

  public update(deltaSeconds: number): void {
    if (!this.isLocked) return;

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

  public requestLock(): void {
    void this.canvas.requestPointerLock().catch(() => {
      // Embedded preview surfaces may reject pointer lock.
    });
  }

  private get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private bindEvents(): void {
    this.canvas.addEventListener('click', () => this.requestLock());

    document.addEventListener('keydown', (event) => {
      if (!this.isLocked) return;
      this.pressedKeys.add(event.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) {
        event.preventDefault();
      }
    });

    document.addEventListener('keyup', (event) => {
      this.pressedKeys.delete(event.code);
    });

    document.addEventListener('mousemove', (event) => {
      if (!this.isLocked) return;
      this.camera.rotate(event.movementX * this.lookSpeed, -event.movementY * this.lookSpeed);
    });

    document.addEventListener('pointerlockchange', () => {
      this.pressedKeys.clear();
      this.onLockChange?.(this.isLocked);
    });

    window.addEventListener('blur', () => this.pressedKeys.clear());
  }
}

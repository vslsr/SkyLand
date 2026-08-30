import type { CameraFrame } from '../camera/CameraTransform';

export interface SceneCameraController {
  readonly frame: CameraFrame;
  setInputEnabled(enabled: boolean): void;
  update(deltaSeconds: number, elapsedSeconds?: number): void;
}

type ControlMode = 'fly' | 'topdown';

export class SceneControlRouter {
  private readonly fallbackController: SceneCameraController;
  private playerController?: SceneCameraController;
  private inputEnabled = false;
  private modeChangeHandler?: (mode: ControlMode) => void;

  public constructor(fallbackController: SceneCameraController) {
    this.fallbackController = fallbackController;
    this.fallbackController.setInputEnabled(false);
  }

  public get frame(): CameraFrame {
    return this.activeController.frame;
  }

  public get mode(): ControlMode {
    return this.playerController ? 'topdown' : 'fly';
  }

  public setPlayerController(controller: SceneCameraController | undefined): void {
    const previousMode = this.mode;
    this.playerController?.setInputEnabled(false);
    this.playerController = controller;
    this.syncEnabledController();
    if (this.mode !== previousMode) this.modeChangeHandler?.(this.mode);
  }

  public setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    this.syncEnabledController();
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.activeController.update(deltaSeconds, elapsedSeconds);
  }

  public onModeChange(handler: (mode: ControlMode) => void): void {
    this.modeChangeHandler = handler;
    handler(this.mode);
  }

  private get activeController(): SceneCameraController {
    return this.playerController ?? this.fallbackController;
  }

  private syncEnabledController(): void {
    this.fallbackController.setInputEnabled(this.inputEnabled && !this.playerController);
    this.playerController?.setInputEnabled(this.inputEnabled);
  }
}

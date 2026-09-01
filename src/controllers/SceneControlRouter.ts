import type { CameraFrame } from '../camera/CameraTransform';
import { CameraFrameTransition } from '../camera/CameraFrameTransition';

export interface SceneCameraController {
  readonly frame: CameraFrame;
  setInputEnabled(enabled: boolean): void;
  update(deltaSeconds: number, elapsedSeconds?: number): void;
}

type ControlMode = 'fly' | 'topdown';

export interface SceneControlRouterOptions {
  cameraTransitionDurationSeconds?: number;
}

export class SceneControlRouter {
  private readonly fallbackController: SceneCameraController;
  private readonly cameraTransition: CameraFrameTransition;
  private playerController?: SceneCameraController;
  private inputEnabled = false;
  private modeChangeHandler?: (mode: ControlMode) => void;

  public constructor(
    fallbackController: SceneCameraController,
    options: SceneControlRouterOptions = {},
  ) {
    this.fallbackController = fallbackController;
    this.cameraTransition = new CameraFrameTransition({
      durationSeconds: options.cameraTransitionDurationSeconds,
    });
    this.fallbackController.setInputEnabled(false);
  }

  public get frame(): CameraFrame {
    return this.cameraTransition.resolve(this.activeController.frame);
  }

  public get mode(): ControlMode {
    return this.playerController ? 'topdown' : 'fly';
  }

  public setPlayerController(controller: SceneCameraController | undefined): void {
    if (controller === this.playerController) return;
    const transitionSource = this.frame;
    const previousMode = this.mode;
    this.playerController?.setInputEnabled(false);
    this.playerController = controller;
    this.cameraTransition.begin(transitionSource);
    this.syncEnabledController();
    if (this.mode !== previousMode) this.modeChangeHandler?.(this.mode);
  }

  public setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    this.syncEnabledController();
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.activeController.update(deltaSeconds, elapsedSeconds);
    this.cameraTransition.update(deltaSeconds);
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

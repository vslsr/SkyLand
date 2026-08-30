import { CommonUIManager } from '../ui/common/CommonUIManager';

export interface SceneUIContext {
  sceneRoot: HTMLElement;
  baseLayer: HTMLElement;
  overlayRoot: HTMLElement;
}

export abstract class Scene {
  public readonly commonUI: CommonUIManager;
  public readonly id: string;
  private active = false;

  protected constructor(id: string, uiContext: SceneUIContext) {
    this.id = id;
    this.commonUI = new CommonUIManager(uiContext);
  }

  public get isActive(): boolean {
    return this.active;
  }

  public enter(): void {
    if (this.active) return;
    this.active = true;
    this.commonUI.activate();
    this.onEnter();
  }

  public leave(): void {
    if (!this.active) return;
    this.active = false;
    this.commonUI.deactivate();
    this.onLeave();
  }

  public abstract update(deltaSeconds: number, elapsedSeconds: number): void;
  public abstract render(elapsedSeconds: number): void;

  protected abstract onEnter(): void;
  protected abstract onLeave(): void;
}

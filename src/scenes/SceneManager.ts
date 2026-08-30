import type { Scene } from './Scene';

export class SceneManager {
  private currentScene?: Scene;

  public get current(): Scene | undefined {
    return this.currentScene;
  }

  public switchTo(scene: Scene): void {
    if (scene === this.currentScene) return;
    this.currentScene?.leave();
    this.currentScene = scene;
    this.currentScene.enter();
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.currentScene?.update(deltaSeconds, elapsedSeconds);
  }

  public render(elapsedSeconds: number): void {
    this.currentScene?.render(elapsedSeconds);
  }
}

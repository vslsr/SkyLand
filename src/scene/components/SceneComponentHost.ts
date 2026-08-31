import type { SceneComponentDefinition } from '../../scenes/data/SceneDefinition';
import { createSceneRuntimeComponent } from './createSceneRuntimeComponent';
import type {
  SceneComponentContext,
  SceneComponentFactory,
  SceneRuntimeComponent,
} from './SceneComponent';

/** 管理一张场景的组件实例，并保证换图时完整回收场景特化状态。 */
export class SceneComponentHost {
  private components: SceneRuntimeComponent[] = [];
  private active = false;

  public constructor(
    private readonly factory: SceneComponentFactory = createSceneRuntimeComponent,
  ) {}

  public load(
    definitions: readonly SceneComponentDefinition[],
    context: SceneComponentContext,
  ): void {
    this.clear();
    const created: SceneRuntimeComponent[] = [];
    try {
      for (const definition of definitions) created.push(this.factory(definition, context));
      if (this.active) this.activate(created);
      this.components = created;
    } catch (error) {
      this.deactivate(created);
      this.dispose(created);
      throw error;
    }
  }

  public setActive(active: boolean): void {
    if (active === this.active) return;
    if (active) {
      this.activate(this.components);
      this.active = true;
      return;
    }
    this.deactivate(this.components);
    this.active = false;
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    if (!this.active) return;
    for (const component of this.components) component.update?.(deltaSeconds, elapsedSeconds);
  }

  public clear(): void {
    if (this.active) this.deactivate(this.components);
    this.dispose(this.components);
    this.components = [];
  }

  public dispose(): void {
    this.clear();
    this.active = false;
  }

  private activate(components: readonly SceneRuntimeComponent[]): void {
    const activated: SceneRuntimeComponent[] = [];
    try {
      for (const component of components) {
        component.activate?.();
        activated.push(component);
      }
    } catch (error) {
      this.deactivate(activated);
      throw error;
    }
  }

  private deactivate(components: readonly SceneRuntimeComponent[]): void {
    for (let index = components.length - 1; index >= 0; index -= 1) {
      components[index].deactivate?.();
    }
  }

  private dispose(components: readonly SceneRuntimeComponent[]): void {
    for (let index = components.length - 1; index >= 0; index -= 1) {
      components[index].dispose?.();
    }
  }
}

import type * as THREE from 'three';
import type { InputSubsystem } from '../../input';
import type { PlayerEntity } from '../../player/PlayerEntity';
import type { SceneRenderer } from '../../rendering/SceneRenderer';
import type {
  SceneComponentDefinition,
  SceneDefinition,
} from '../../scenes/data/SceneDefinition';

/** 场景组件只依赖宿主明确暴露的能力，不通过场景 id 查找全局对象。 */
export interface SceneComponentContext {
  readonly definition: SceneDefinition;
  readonly canvas: HTMLCanvasElement;
  readonly uiRoot: HTMLElement;
  readonly input: InputSubsystem;
  readonly renderer: SceneRenderer;
  readonly player?: PlayerEntity;
}

/**
 * 类似 GameMode 的场景级运行单元。
 *
 * 数组声明顺序就是 activate/update 顺序；deactivate/dispose 按相反顺序执行，
 * 让后加载的规则先释放对前置规则的依赖。
 */
export interface SceneRuntimeComponent {
  readonly type: SceneComponentDefinition['type'];
  activate?(): void;
  deactivate?(): void;
  update?(deltaSeconds: number, elapsedSeconds: number): void;
  dispose?(): void;
}

export type SceneBeforeRenderListener = (camera: THREE.Camera) => void;

export type SceneComponentFactory = (
  definition: SceneComponentDefinition,
  context: SceneComponentContext,
) => SceneRuntimeComponent;

import type { SceneUpdateContext } from '../SceneVisualSystem';
import type * as THREE from 'three';
import type { InputSubsystem } from '../../input';
import type { PlayerEntity } from '../../player/PlayerEntity';
import type { SceneRenderer } from '../../rendering/SceneRenderer';
import type { SceneWorld } from '../SceneWorld';
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
  /** 场景里不属于渲染的那一半：地形采样、物理查询、Actor 查询。 */
  readonly world: SceneWorld;
  readonly player?: PlayerEntity;
  /** 房间分配的流式世界种子；固定场景可以省略。 */
  readonly worldSeed?: number;
  /** 与 ChunkStreamer 共用的当前玩家/相机焦点。 */
  readonly getFocus?: () => SceneUpdateContext;
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

/**
 * 返回 `undefined` 表示「这一类不归主线程建」——纯表现的组件由
 * `createRenderWorld` 建，跟着 canvas 走。
 */
export type SceneComponentFactory = (
  definition: SceneComponentDefinition,
  context: SceneComponentContext,
) => SceneRuntimeComponent | undefined;

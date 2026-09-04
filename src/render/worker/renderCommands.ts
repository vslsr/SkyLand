import type {
  AbilityLabAction,
  AbilityLabViewState,
} from '../../abilities/lab/AbilityLabSimulation';
import type {
  BuildPreviewState,
  GuidePathState,
  MeshProxyDesc,
  PlayerProxyDesc,
  ProxyId,
  RenderScene,
  SlimeSurfaceDragListener,
  SlimeSurfaceDragReport,
  SlimeSurfaceDragRay,
} from '../RenderScene';
import type { GrassBendImpulse } from '../../grass';
import type { RenderInstanceBuffer } from '../RenderInstanceBuffer';
import type { RenderWorldCommands } from '../RenderWorldRuntime';
import type { SceneUpdateContext } from '../../scene/SceneVisualSystem';
import type { SceneDefinition } from '../../scenes/data/SceneDefinition';
import type { WeatherType } from '../../weather/index';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import type { ChunkViewMountRequest, ChunkViewSink } from '../../world/ChunkViewHost';

/**
 * 渲染世界的命令编码（引擎迁移路线图 第 3 步）。
 *
 * 前面几步把 `RenderScene` 与 `ChunkViewSink` 上**每一个方法都改成了返回 `void`**，
 * 为的就是这一刻：一次调用能原样变成一条报文，不需要等对面回话。
 *
 * 参数全都是结构化克隆过得去的东西——数字、字符串、配置对象、类型化数组。
 * 这不是巧合，是「过边界的是描述不是对象」那条约定的直接结果：
 * `MeshProxyDesc` 本来就是一份 JSON 形状的配置，不是 `Object3D`。
 *
 * **按帧成批**：每帧几百个 proxy 各发一条 `postMessage` 会把结构化克隆的开销放大到
 * 比渲染本身还贵。所以代理只往数组里堆，一帧 `flush()` 一次——和 transform SoA
 * 的 `publish()` 同一个节奏。
 */

export type RenderCommand =
  | { readonly kind: 'createMeshProxy'; readonly id: ProxyId; readonly desc: MeshProxyDesc }
  | { readonly kind: 'createPlayerProxy'; readonly id: ProxyId; readonly desc: PlayerProxyDesc }
  | { readonly kind: 'destroyMeshProxy'; readonly id: ProxyId }
  | {
    readonly kind: 'setGuidePath';
    readonly id: ProxyId;
    readonly state: GuidePathState;
    readonly pathChanged: boolean;
  }
  | {
      readonly kind: 'setInteractionMarker';
      readonly id: ProxyId;
      readonly label: string;
      readonly opacity?: number;
    }
  | { readonly kind: 'setHoveredProxy'; readonly id: ProxyId }
  | { readonly kind: 'setBuildPreview'; readonly state: BuildPreviewState | undefined }
  | { readonly kind: 'setAbilityLabTarget'; readonly id: ProxyId }
  | {
      readonly kind: 'setAbilityLabState';
      readonly state: AbilityLabViewState | undefined;
      readonly casterX: number;
      readonly casterY: number;
      readonly casterZ: number;
    }
  | {
      readonly kind: 'playAbilityLabAction';
      readonly action: AbilityLabAction;
      readonly casterX: number;
      readonly casterY: number;
      readonly casterZ: number;
      readonly succeeded: boolean;
    }
  | {
      readonly kind: 'spawnHealthPopup';
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly amount: number;
    }
  | { readonly kind: 'setTemperatureMarkersVisible'; readonly visible: boolean }
  | { readonly kind: 'setSimpleCollisionVisible'; readonly visible: boolean }
  /**
   * 注意这里**不带那段字节**：worker 一开始就拿到了同一个 `SharedArrayBuffer`，
   * 每帧再传一次视图是白费。过来的只有两个时间量。
   */
  | { readonly kind: 'updateVisuals'; readonly deltaSeconds: number; readonly elapsedSeconds: number }
  /**
   * 同样不带那段字节：这条命令的意思只是「刚翻了一面，去读」。
   * 排在 `updateVisuals` 之前，和单线程下的调用顺序一致。
   */
  | { readonly kind: 'submitTransforms' }
  | {
      readonly kind: 'submitInstances';
      readonly props: RenderInstanceSlice;
      readonly fruit: RenderInstanceSlice;
    }
  | {
      readonly kind: 'loadRenderScene';
      readonly definition: SceneDefinition;
      readonly worldSeed?: number;
    }
  | { readonly kind: 'clearRenderScene' }
  | { readonly kind: 'adoptTransforms'; readonly bytes: ArrayBufferLike }
  | {
      readonly kind: 'setViewport';
      readonly cssWidth: number;
      readonly cssHeight: number;
      readonly pixelRatio: number;
    }
  | { readonly kind: 'setWeather'; readonly weather: WeatherType }
  | { readonly kind: 'setTimeOfDay'; readonly timeOfDay: number; readonly running: boolean }
  | { readonly kind: 'setSceneActive'; readonly active: boolean }
  | {
      readonly kind: 'setTerrainCells';
      readonly cells: readonly { cellX: number; cellZ: number; code: number }[];
    }
  | {
      readonly kind: 'setTerrainHighlight';
      readonly cell?: { cellX: number; cellZ: number };
    }
  | {
      readonly kind: 'setPhysicsDebug';
      readonly buffers?: { vertices: Float32Array; colors: Float32Array };
    }
  | { readonly kind: 'applyGrassImpulse'; readonly impulse: GrassBendImpulse }
  | { readonly kind: 'setFrameContext'; readonly context: SceneUpdateContext }
  | {
      readonly kind: 'beginSlimeSurfaceDrag' | 'updateSlimeSurfaceDrag';
      readonly id: ProxyId;
      readonly ray: SlimeSurfaceDragRay;
    }
  | { readonly kind: 'endSlimeSurfaceDrag'; readonly id: ProxyId }
  | { readonly kind: 'disposeRenderScene' }
  | { readonly kind: 'mountChunk'; readonly request: ChunkViewMountRequest }
  | { readonly kind: 'unmountChunk'; readonly key: string }
  | { readonly kind: 'clearChunks' };

/** 一帧攒下来的命令。 */
export interface RenderCommandBatch {
  readonly commands: readonly RenderCommand[];
  /** 这一批里可以转移而不是复制的缓冲区（地形覆盖）。 */
  readonly transfer: readonly ArrayBufferLike[];
}

/**
 * 玩法侧那一端：把调用堆成一批。
 *
 * 它同时实现 `RenderScene` 与 `ChunkViewSink`——玩法侧本来就是拿这两个接口说话的，
 * 所以换成跨线程时调用方一个字都不用改。
 */
/** 一条实例记录段的定长切片：整数段、浮点段、条数。 */
export interface RenderInstanceSlice {
  readonly integers: Int32Array;
  readonly floats: Float32Array;
  readonly count: number;
}

function sliceInstances(buffer: RenderInstanceBuffer): RenderInstanceSlice {
  return {
    integers: buffer.copyIntegers(),
    floats: buffer.copyFloats(),
    count: buffer.count,
  };
}

function applyInstanceSlice(buffer: RenderInstanceBuffer, slice: RenderInstanceSlice): void {
  buffer.adopt(slice.integers, slice.floats, slice.count);
}

export class RenderCommandQueue implements RenderScene, ChunkViewSink, RenderWorldCommands {
  #commands: RenderCommand[] = [];
  #transfer: ArrayBufferLike[] = [];
  /**
   * 上一次真的发出去的实例记录。内容逐字节没变的帧不再发——渲染侧留着上一份就是
   * 这一帧的。发出去的那段字节是转移的，所以这里留的是自己的一份副本。
   */
  #sentProps?: RenderInstanceSlice;
  #sentFruit?: RenderInstanceSlice;
  readonly #generatorReady: ((kind: string) => void)[] = [];
  #generatorKind?: string;
  #slimeDragListener?: SlimeSurfaceDragListener;

  /** 取走这一帧攒下的命令。空批返回 undefined，省掉一次 `postMessage`。 */
  public flush(): RenderCommandBatch | undefined {
    if (this.#commands.length === 0) return undefined;
    const batch = { commands: this.#commands, transfer: this.#transfer };
    this.#commands = [];
    this.#transfer = [];
    return batch;
  }

  public get pendingCount(): number {
    return this.#commands.length;
  }

  // --- RenderScene ---

  public createMeshProxy(id: ProxyId, desc: MeshProxyDesc): void {
    this.#commands.push({ kind: 'createMeshProxy', id, desc });
  }

  public createPlayerProxy(id: ProxyId, desc: PlayerProxyDesc): void {
    this.#commands.push({ kind: 'createPlayerProxy', id, desc });
  }

  public destroyMeshProxy(id: ProxyId): void {
    this.#commands.push({ kind: 'destroyMeshProxy', id });
  }

  public setGuidePath(id: ProxyId, state: GuidePathState, pathChanged: boolean): void {
    this.#commands.push({ kind: 'setGuidePath', id, state, pathChanged });
  }

  public setInteractionMarker(id: ProxyId, label: string, opacity?: number): void {
    this.#commands.push({ kind: 'setInteractionMarker', id, label, opacity });
  }

  public setHoveredProxy(id: ProxyId): void {
    this.#commands.push({ kind: 'setHoveredProxy', id });
  }

  public setBuildPreview(state: BuildPreviewState | undefined): void {
    this.#commands.push({ kind: 'setBuildPreview', state });
  }

  public setAbilityLabTarget(id: ProxyId): void {
    this.#commands.push({ kind: 'setAbilityLabTarget', id });
  }

  public setAbilityLabState(
    state: AbilityLabViewState | undefined,
    casterX: number,
    casterY: number,
    casterZ: number,
  ): void {
    this.#commands.push({ kind: 'setAbilityLabState', state, casterX, casterY, casterZ });
  }

  public playAbilityLabAction(
    action: AbilityLabAction,
    casterX: number,
    casterY: number,
    casterZ: number,
    succeeded: boolean,
  ): void {
    this.#commands.push({
      kind: 'playAbilityLabAction',
      action,
      casterX,
      casterY,
      casterZ,
      succeeded,
    });
  }

  public spawnHealthPopup(x: number, y: number, z: number, amount: number): void {
    this.#commands.push({ kind: 'spawnHealthPopup', x, y, z, amount });
  }

  public setTemperatureMarkersVisible(visible: boolean): void {
    this.#commands.push({ kind: 'setTemperatureMarkersVisible', visible });
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    this.#commands.push({ kind: 'setSimpleCollisionVisible', visible });
  }

  public submitTransforms(_transforms: RenderTransformBuffer): void {
    this.#commands.push({ kind: 'submitTransforms' });
  }

  /**
   * 合批内容**带着这一帧那几百条记录一起过去**，和 `submitTransforms` 不一样。
   *
   * transform SoA 是双缓冲的 `SharedArrayBuffer`，读的一侧永远读到完整的一帧，
   * 所以那条命令不带载荷。实例通道不是：它每帧整个重铺（内容变化太频繁，
   * 记账比重排还贵），也就没有「读到一半被改写」的防护。定长记录复制过去
   * 反而是最省事的正确做法——一张图满打满算几百条，按 `count` 截断之后是几 KB。
   */
  public submitInstances(props: RenderInstanceBuffer, fruit: RenderInstanceBuffer): void {
    // 什么都没变的帧（绝大多数帧）一个字节都不发：不复制、不克隆、不转移。
    if (
      this.#sentProps && this.#sentFruit
      && props.matches(this.#sentProps.integers, this.#sentProps.floats, this.#sentProps.count)
      && fruit.matches(this.#sentFruit.integers, this.#sentFruit.floats, this.#sentFruit.count)
    ) return;
    const propSlice = sliceInstances(props);
    const fruitSlice = sliceInstances(fruit);
    this.#sentProps = sliceInstances(props);
    this.#sentFruit = sliceInstances(fruit);
    this.#commands.push({ kind: 'submitInstances', props: propSlice, fruit: fruitSlice });
    this.#transfer.push(
      propSlice.integers.buffer,
      propSlice.floats.buffer,
      fruitSlice.integers.buffer,
      fruitSlice.floats.buffer,
    );
  }

  public loadRenderScene(definition: SceneDefinition, worldSeed?: number): void {
    // 新的渲染世界没见过任何实例记录：下一帧不管变没变都要发一次。
    this.#sentProps = undefined;
    this.#sentFruit = undefined;
    this.#commands.push({ kind: 'loadRenderScene', definition, worldSeed });
  }

  public clearRenderScene(): void {
    this.#sentProps = undefined;
    this.#sentFruit = undefined;
    this.#commands.push({ kind: 'clearRenderScene' });
  }

  /**
   * transform SoA 扩容之后那一块新的 `SharedArrayBuffer`。
   *
   * 扩容会重新分配，旧的那一块渲染侧还拿着——不补这一条，它会一直读一段没人再写的
   * 内存。一局里至多发生一两次（容量按 2 的倍数涨，起点就是 Actor 上限 256）。
   */
  public adoptTransforms(bytes: ArrayBufferLike): void {
    this.#commands.push({ kind: 'adoptTransforms', bytes });
  }

  public setViewport(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.#commands.push({ kind: 'setViewport', cssWidth, cssHeight, pixelRatio });
  }

  public setWeather(weather: WeatherType): void {
    this.#commands.push({ kind: 'setWeather', weather });
  }

  public setTimeOfDay(timeOfDay: number, running: boolean): void {
    this.#commands.push({ kind: 'setTimeOfDay', timeOfDay, running });
  }

  public setSceneActive(active: boolean): void {
    this.#commands.push({ kind: 'setSceneActive', active });
  }

  public setTerrainCells(
    cells: readonly { cellX: number; cellZ: number; code: number }[],
  ): void {
    this.#commands.push({ kind: 'setTerrainCells', cells });
  }

  public setTerrainHighlight(cell?: { cellX: number; cellZ: number }): void {
    this.#commands.push({ kind: 'setTerrainHighlight', cell });
  }

  public setPhysicsDebug(buffers?: { vertices: Float32Array; colors: Float32Array }): void {
    // Rapier 每帧给的是新数组，直接转移走比复制便宜；开关关着时根本不产生它们。
    if (!buffers) {
      this.#commands.push({ kind: 'setPhysicsDebug' });
      return;
    }
    this.#commands.push({ kind: 'setPhysicsDebug', buffers });
    this.#transfer.push(buffers.vertices.buffer, buffers.colors.buffer);
  }

  public applyGrassImpulse(impulse: GrassBendImpulse): void {
    this.#commands.push({ kind: 'applyGrassImpulse', impulse });
  }

  public setFrameContext(context: SceneUpdateContext): void {
    this.#commands.push({ kind: 'setFrameContext', context });
  }

  public updateVisuals(
    _transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    // 那段字节 worker 一开始就有；这里只送时间量。
    this.#commands.push({ kind: 'updateVisuals', deltaSeconds, elapsedSeconds });
  }

  public dispose(): void {
    this.#commands.push({ kind: 'disposeRenderScene' });
  }

  // --- ChunkViewSink ---

  public mount(request: ChunkViewMountRequest): void {
    this.#commands.push({ kind: 'mountChunk', request });
    // 覆盖数组这一侧发完就不再用，转移比复制便宜；空数组不值得登记。
    if (request.terrainOverrides.length > 0) this.#transfer.push(request.terrainOverrides.buffer);
  }

  public unmount(key: string): void {
    this.#commands.push({ kind: 'unmountChunk', key });
  }

  public clear(): void {
    this.#commands.push({ kind: 'clearChunks' });
  }

  public beginSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): void {
    this.#commands.push({ kind: 'beginSlimeSurfaceDrag', id, ray });
  }

  public updateSlimeSurfaceDrag(id: ProxyId, ray: SlimeSurfaceDragRay): void {
    this.#commands.push({ kind: 'updateSlimeSurfaceDrag', id, ray });
  }

  public endSlimeSurfaceDrag(id: ProxyId): void {
    this.#commands.push({ kind: 'endSlimeSurfaceDrag', id });
  }

  /**
   * 拖拽状态的回报也是**反向**的，和 `generatorReady` 一样不走命令队列：
   * 监听器留在这一端，由持有这个队列的那一方在收到 worker 报文时调
   * `slimeSurfaceDragChanged()`。
   */
  public setSlimeSurfaceDragListener(listener?: SlimeSurfaceDragListener): void {
    this.#slimeDragListener = listener;
  }

  /** worker 报告某个 proxy 的蒙皮拖拽开始或结束。 */
  public slimeSurfaceDragChanged(report: SlimeSurfaceDragReport): void {
    this.#slimeDragListener?.(report);
  }

  /**
   * 生成后端就位的通知是**反向**的，所以它不走命令队列，走 `generatorReady()`——
   * 由持有这个队列的那一端在收到 worker 报文时调用。
   */
  public onGeneratorReady(listener: (kind: string) => void): void {
    if (this.#generatorKind !== undefined) listener(this.#generatorKind);
    else this.#generatorReady.push(listener);
  }

  /** worker 报告生成后端就位。 */
  public generatorReady(kind: string): void {
    if (this.#generatorKind !== undefined) return;
    this.#generatorKind = kind;
    for (const listener of this.#generatorReady) listener(kind);
    this.#generatorReady.length = 0;
  }
}

/** 渲染侧那一端：把一条命令兑现到真正的渲染世界。 */
export function applyRenderCommand(
  command: RenderCommand,
  target: {
    readonly scene: RenderScene;
    readonly transforms: RenderTransformBuffer;
    /** 合批内容那两段字节。和 transforms 一样，worker 一开始就持有同一份。 */
    readonly propInstances: RenderInstanceBuffer;
    readonly fruitInstances: RenderInstanceBuffer;
    readonly chunkViews?: ChunkViewSink;
    /** 整图级命令的收件人。渲染线程那一端有，测试里的假目标可以不给。 */
    readonly runtime?: RenderWorldCommands;
    /** transform SoA 扩容时换上新的那一块字节。 */
    readonly adoptTransforms?: (bytes: ArrayBufferLike) => void;
  },
): void {
  switch (command.kind) {
    case 'createMeshProxy':
      target.scene.createMeshProxy(command.id, command.desc);
      return;
    case 'createPlayerProxy':
      target.scene.createPlayerProxy(command.id, command.desc);
      return;
    case 'destroyMeshProxy':
      target.scene.destroyMeshProxy(command.id);
      return;
    case 'setGuidePath':
      target.scene.setGuidePath(command.id, command.state, command.pathChanged);
      return;
    case 'setInteractionMarker':
      target.scene.setInteractionMarker(command.id, command.label, command.opacity);
      return;
    case 'setHoveredProxy':
      target.scene.setHoveredProxy(command.id);
      return;
    case 'setBuildPreview':
      target.scene.setBuildPreview(command.state);
      return;
    case 'beginSlimeSurfaceDrag':
      target.scene.beginSlimeSurfaceDrag(command.id, command.ray);
      return;
    case 'updateSlimeSurfaceDrag':
      target.scene.updateSlimeSurfaceDrag(command.id, command.ray);
      return;
    case 'endSlimeSurfaceDrag':
      target.scene.endSlimeSurfaceDrag(command.id);
      return;
    case 'submitInstances':
      applyInstanceSlice(target.propInstances, command.props);
      applyInstanceSlice(target.fruitInstances, command.fruit);
      target.scene.submitInstances(target.propInstances, target.fruitInstances);
      return;
    case 'loadRenderScene':
      target.runtime?.loadRenderScene(command.definition, command.worldSeed);
      return;
    case 'clearRenderScene':
      target.runtime?.clearRenderScene();
      return;
    case 'adoptTransforms':
      target.adoptTransforms?.(command.bytes);
      return;
    case 'setViewport':
      target.runtime?.setViewport(command.cssWidth, command.cssHeight, command.pixelRatio);
      return;
    case 'setWeather':
      target.runtime?.setWeather(command.weather);
      return;
    case 'setTimeOfDay':
      target.runtime?.setTimeOfDay(command.timeOfDay, command.running);
      return;
    case 'setSceneActive':
      target.runtime?.setSceneActive(command.active);
      return;
    case 'setTerrainCells':
      target.runtime?.setTerrainCells(command.cells);
      return;
    case 'setTerrainHighlight':
      target.runtime?.setTerrainHighlight(command.cell);
      return;
    case 'setPhysicsDebug':
      target.runtime?.setPhysicsDebug(command.buffers);
      return;
    case 'applyGrassImpulse':
      target.runtime?.applyGrassImpulse(command.impulse);
      return;
    case 'setFrameContext':
      target.runtime?.setFrameContext(command.context);
      return;
    case 'setAbilityLabTarget':
      target.scene.setAbilityLabTarget(command.id);
      return;
    case 'setAbilityLabState':
      target.scene.setAbilityLabState(
        command.state,
        command.casterX,
        command.casterY,
        command.casterZ,
      );
      return;
    case 'playAbilityLabAction':
      target.scene.playAbilityLabAction(
        command.action,
        command.casterX,
        command.casterY,
        command.casterZ,
        command.succeeded,
      );
      return;
    case 'spawnHealthPopup':
      target.scene.spawnHealthPopup(command.x, command.y, command.z, command.amount);
      return;
    case 'setTemperatureMarkersVisible':
      target.scene.setTemperatureMarkersVisible(command.visible);
      return;
    case 'setSimpleCollisionVisible':
      target.scene.setSimpleCollisionVisible(command.visible);
      return;
    case 'submitTransforms':
      target.scene.submitTransforms(target.transforms);
      return;
    case 'updateVisuals':
      target.scene.updateVisuals(target.transforms, command.deltaSeconds, command.elapsedSeconds);
      return;
    case 'disposeRenderScene':
      target.scene.dispose();
      return;
    case 'mountChunk':
      target.chunkViews?.mount(command.request);
      return;
    case 'unmountChunk':
      target.chunkViews?.unmount(command.key);
      return;
    case 'clearChunks':
      target.chunkViews?.clear();
      return;
    default:
      // 命令种类加了却忘了兑现，会在这里变成一个编译错误。
      command satisfies never;
  }
}

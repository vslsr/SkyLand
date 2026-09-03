/**
 * PlatformLayer · 线程与共享内存能力（引擎迁移路线图 §7 / 第 0 步）。
 *
 * PlatformLayer 是一条「在每个线程上都存在、提供同一套 API」的连续基带。
 * 这个文件是它的第一块：把「这台机器上能不能真的开线程、能不能共享字节」
 * 收敛成一次探测，让上层（RenderTransformBuffer、之后的 Sim / Render Worker）
 * 不必各自去碰 `crossOriginIsolated` 这类宿主全局量。
 *
 * Web 后端的能力集由跨源隔离决定，见 `server/http/crossOriginIsolation.mjs`。
 * Node（测试与房间进程）没有 `crossOriginIsolated` 这个全局量，但 SAB 一直可用，
 * 所以探测按「有没有构造器」而不是按「是不是浏览器」来判断。
 */

/** 探测所依赖的宿主全局量。抽成接口只是为了让测试能喂一个假 scope。 */
export interface ThreadingScope {
  readonly crossOriginIsolated?: boolean;
  readonly SharedArrayBuffer?: SharedArrayBufferConstructor;
  readonly Worker?: unknown;
  readonly OffscreenCanvas?: unknown;
  readonly Atomics?: unknown;
}

export interface ThreadingCapabilities {
  /** 文档是否跨源隔离。Node 之类没有这个概念的宿主上恒为 false。 */
  readonly crossOriginIsolated: boolean;
  /** 能否真的分配到共享内存——Game World 与 Render World 之间只有它能跨线程。 */
  readonly sharedMemory: boolean;
  /** 有无 `Atomics`：无锁双缓冲的发布/获取语义靠它，不是靠 postMessage。 */
  readonly atomics: boolean;
  /** 能否开工作线程。 */
  readonly workers: boolean;
  /** 能否把画布交给渲染线程独占（第 3 步的前置）。 */
  readonly offscreenCanvas: boolean;
}

function hasConstructor(scope: ThreadingScope, name: keyof ThreadingScope): boolean {
  return typeof scope[name] === 'function';
}

export function detectThreadingCapabilities(
  scope: ThreadingScope = globalThis as ThreadingScope,
): ThreadingCapabilities {
  // 浏览器里未隔离的文档仍然暴露 SharedArrayBuffer 构造器，但 new 出来的 buffer
  // 不能 postMessage，也不能支撑 Emscripten 的 pthreads。所以「有构造器」不等于
  // 「能共享」：只要宿主声明了 crossOriginIsolated 这个量，就以它为准。
  const isolationAware = typeof scope.crossOriginIsolated === 'boolean';
  const crossOriginIsolated = scope.crossOriginIsolated === true;
  const sharedMemory = hasConstructor(scope, 'SharedArrayBuffer')
    && (!isolationAware || crossOriginIsolated);
  return {
    crossOriginIsolated,
    sharedMemory,
    atomics: typeof scope.Atomics === 'object' && scope.Atomics !== null,
    workers: hasConstructor(scope, 'Worker'),
    offscreenCanvas: hasConstructor(scope, 'OffscreenCanvas'),
  };
}

/**
 * 分配一段「能共享就共享」的字节。拿不到 SAB 时回落成普通 `ArrayBuffer`：
 * 单线程下两者的读写语义完全一致，所以调用方不需要分支——**这正是第 1 步
 * 能在不开 worker 的情况下先落地边界的原因**。
 */
export function allocateSharedBytes(
  byteLength: number,
  scope: ThreadingScope = globalThis as ThreadingScope,
): ArrayBufferLike {
  const size = Math.max(0, Math.ceil(byteLength));
  if (detectThreadingCapabilities(scope).sharedMemory && scope.SharedArrayBuffer) {
    return new scope.SharedArrayBuffer(size);
  }
  return new ArrayBuffer(size);
}

export function isSharedBytes(
  buffer: ArrayBufferLike,
  scope: ThreadingScope = globalThis as ThreadingScope,
): boolean {
  return typeof scope.SharedArrayBuffer === 'function'
    && buffer instanceof scope.SharedArrayBuffer;
}

/**
 * 能力集的一行摘要，给启动日志和调试面板用。
 * 「隔离没打开」是个静默降级——线上真出问题时，第一句要问的就是这行。
 */
export function describeThreadingCapabilities(
  capabilities: ThreadingCapabilities = detectThreadingCapabilities(),
): string {
  const flags = [
    capabilities.crossOriginIsolated ? 'isolated' : 'not-isolated',
    capabilities.sharedMemory ? 'shared-memory' : 'no-shared-memory',
    capabilities.workers ? 'workers' : 'no-workers',
    capabilities.offscreenCanvas ? 'offscreen-canvas' : 'no-offscreen-canvas',
  ];
  return flags.join(' · ');
}

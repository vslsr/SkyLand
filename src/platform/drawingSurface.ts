/**
 * PlatformLayer · 离屏绘制面（引擎迁移路线图 第 3 步）。
 *
 * 渲染栈里还剩两处 `document.createElement('canvas')`——两个标记牌的文字贴图。
 * canvas 一旦交给渲染线程，那两处就跑在没有 `document` 的地方。
 *
 * `OffscreenCanvas` 主线程和 worker 里都有，所以这里**不做双路**：
 * 有就用，没有（Node 下的测试）就返回 undefined，调用方本来就得处理
 * 「这台机器给不出 2D 上下文」这一路——原来那两处判的是 `typeof document`，
 * 现在判的是真正决定成败的那个东西。
 */

export interface DrawingSurface {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
}

/**
 * 开一块离屏 2D 画布。
 *
 * 拿不到就返回 undefined：标记牌会退化成没有文字的底板，而不是让整个场景装不起来。
 * 一块文字贴图画不出来，不该让玩家进不去游戏——和 `loadChunkGenerator`
 * 「WASM 加载失败就降级到 JS」是同一个取向。
 */
export function createDrawingSurface(width: number, height: number): DrawingSurface | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const context = canvas.getContext('2d');
  return context ? { canvas, context } : undefined;
}

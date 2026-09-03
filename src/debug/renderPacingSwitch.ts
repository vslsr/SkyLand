import type { RenderPacingMode } from '../render/worker/renderWorkerProtocol';

/**
 * `?renderpace=free`：渲染线程不等主线程翻面，每拍读最新一面（老行为）。
 * 默认 'locked'——每拍等主线程翻面再画（`RenderFramePacer`）。
 *
 * 留这个开关是为了在帧耗时面板上对照：不等的话「重复／跳过」会随两条线程的相位
 * 漂动，那正是「两边都满帧、画面却一顿一顿」的来源。
 *
 * 放在 debug 下而不是 render 下：读 URL 是主线程的事，渲染栈那些目录不许摸
 * `window`（`RenderSceneBoundary` 那条测试盯着）。worker 的 `location` 是它自己
 * 脚本的地址，所以由主线程读好、随开工那条报文交过去。
 */
export function readRenderPacingMode(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): RenderPacingMode {
  return new URLSearchParams(search).get('renderpace') === 'free' ? 'free' : 'locked';
}

import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';

/**
 * 关于渲染模型的、**玩法侧也需要知道的** spawn 时事实。
 *
 * 这些问题以前是 `resolve()` 出活着的 proxy 再看它身上有没有对应的 rig。
 * 递出一个活对象过不了线程边界，而这些事实本来就只取决于 `render.model`——
 * 玩法侧拿着同一份定义，自己判得出来。
 *
 * 放在 `src/render/` 而不是玩法侧，是因为**答案由渲染侧的模型工厂决定**：
 * 哪天某个模型也长出火焰，改的是那边，这张表要跟着改。
 * `tests/RenderModelFacts.test.ts` 把两边钉在一起。
 */

/** 会建出火焰 rig 的模型。它们对应的 Actor 需要一个 `FireVisualComponent`。 */
const FIRE_VISUAL_MODELS = new Set<ActorRenderDefinition['model']>([
  'line-art-campfire',
  'line-art-dry-hay',
]);

export function modelBuildsFireVisual(model: ActorRenderDefinition['model']): boolean {
  return FIRE_VISUAL_MODELS.has(model);
}

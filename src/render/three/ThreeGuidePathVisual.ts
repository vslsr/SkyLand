import { GuidePath, type GuidePathOptions } from '../../guidance/index';
import type { GuidePathState } from '../RenderScene';

/**
 * 渲染世界里的一条引导路径（引擎迁移路线图 第 1.5 步）。
 *
 * 这里曾经是 `GuidePathVisualComponent`——一个挂在 Actor 上、直接握着整棵
 * `GuidePath` 子树的 Component。搬进渲染世界之后 Actor 那侧只剩权威状态本身
 * （`GuidePathComponent`，`shared/` 里的那份），表现完全在这边。
 *
 * **样式不过边界**：lineColor / lineWidth / dash* / markerSize 都不在快照里
 * （见 `GuidePathComponent.mjs` 的注释：样式仍来自已净化的 Actor 原型），
 * 所以它们照 `MeshProxyDesc.render` 的先例在 `createMeshProxy` 时一次性给定。
 * 每帧过边界的只有路点、曲线类型、当前节点与开关。
 */
export class ThreeGuidePathVisual {
  public readonly guide: GuidePath;

  public constructor(name: string, options: GuidePathOptions) {
    this.guide = new GuidePath(options);
    this.guide.root.name = name;
  }

  /**
   * 应用一次状态更新。
   *
   * **路径与索引必须在同一次调用里落地**：`GuidePath.setPath` 内部会 `reset()`，
   * 把揭示进度与当前节点归零；拆成两条命令、中间隔一帧的话，玩家会看到引导线
   * 闪回起点再跳回去。这也是这里不把「换路径」和「设索引」拆开的原因。
   */
  public apply(state: GuidePathState, pathChanged: boolean): void {
    if (pathChanged) {
      this.guide.setPath(state.points, state.curve, state.markerColor);
    }
    this.guide.setCurrentMarkerIndex(state.currentPointIndex);
    this.guide.setEnabled(state.enabled);
  }

  public update(deltaSeconds: number): void {
    this.guide.update(deltaSeconds);
  }

  /**
   * 线宽是像素单位，shader 需要真实的画布尺寸。必须在 `beforeRender` 里给：
   * `SceneRenderer.render` 先 `resizeToDisplaySize()` 再跑 `beforeRender`，
   * 放进 `world.update` 会永远读到 resize 之前的旧尺寸，窗口一变线宽差一帧。
   */
  public setResolution(width: number, height: number): void {
    this.guide.setResolution(width, height);
  }

  public dispose(): void {
    this.guide.root.parent?.remove(this.guide.root);
    this.guide.dispose();
  }
}

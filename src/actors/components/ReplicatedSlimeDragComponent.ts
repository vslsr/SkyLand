import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { SnapshotSlimeDrag } from '../../network/protocol';
import type { HybridSlimeSimulation } from '../../slime/hybrid/HybridSlimeSimulation';
import type { SlimeSurfaceDragDefinition } from './SlimeSurfaceDragComponent';

export const REPLICATED_SLIME_DRAG_COMPONENT = 'replicated-slime-drag';

/**
 * 远端玩家身上的拖拽形变。
 *
 * 快照只带命中点与位移两组本地坐标，这里用本机的同一份参数在自己的
 * HybridSlimeSimulation 上重放：不需要拾取射线，也不写回任何权威状态。
 * 两端外壳顶点的历史不同，所以复现的是同一个手势而不是逐顶点一致的网格。
 */
export class ReplicatedSlimeDragComponent extends ActorComponent {
  /** 已经在求解器上开始过的那一次抓取；revision 变化才重新拾取顶点邻域。 */
  private appliedRevision?: number;

  public constructor(
    private readonly simulation: HybridSlimeSimulation,
    private readonly definition: SlimeSurfaceDragDefinition,
  ) {
    super(REPLICATED_SLIME_DRAG_COMPONENT);
  }

  public apply(state: SnapshotSlimeDrag | undefined): void {
    if (!state) {
      this.clear();
      return;
    }
    if (this.appliedRevision !== state.revision) {
      // 每帧重新 beginSurfaceDrag 会把起始位置刷成当前的已形变外壳，拉伸量因此
      // 永远累积不起来。只有换了一次抓取才重建影响权重。
      if (!this.simulation.beginSurfaceDrag(
        state.contactX,
        state.contactY,
        state.contactZ,
        this.definition,
      )) return;
      this.appliedRevision = state.revision;
    }
    this.simulation.setSurfaceDragPull(state.pullX, state.pullY, state.pullZ);
  }

  public override onDetach(): void {
    this.clear();
  }

  private clear(): void {
    if (this.appliedRevision === undefined) return;
    this.appliedRevision = undefined;
    this.simulation.endSurfaceDrag();
  }
}

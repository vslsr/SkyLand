import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  GUIDE_PATH_COMPONENT,
  type GuidePathComponent,
} from '../../../shared/actor/index.mjs';
import type { ProxyId } from '../../render/RenderScene';
import type { ThreeRenderScene } from '../../render/three/ThreeRenderScene';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';

/**
 * 把权威引导路径推给渲染世界（引擎迁移路线图 第 1.5 步）。
 *
 * 引导路径是这一步里唯一带**变长数据**的一项，所以它不走定长参数段，而是
 * on-change 的命令：只有 revision 变了才发。发送方在这边记账，是因为
 * 「要不要发」是玩法侧的事实；渲染侧只负责应用。
 *
 * 两个 revision 的触发面不对称，必须都盯着：`pathRevision` 只由 `setPath` 抬
 * （并且会**同时**抬 `revision`），而 `revision` 还被 `setEnabled` /
 * `setCurrentPointIndex` / `advance` 单独抬。漏掉任何一个都会让引导线停在旧状态。
 *
 * 路径与索引装在同一条命令里：`GuidePath.setPath` 内部会 `reset()` 把进度归零，
 * 拆成两条、中间隔一帧的话，玩家会看到引导线闪回起点再跳回去。
 */
export class ActorGuidePathSyncSystem {
  private readonly appliedPathRevision = new Map<ProxyId, number>();
  private readonly appliedRevision = new Map<ProxyId, number>();

  public constructor(private readonly scene: ThreeRenderScene) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    const live = new Set<ProxyId>();
    for (const actor of world.query(GUIDE_PATH_COMPONENT, RENDER_PROXY_COMPONENT) as Actor[]) {
      const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
      const state = actor.requireComponent(GUIDE_PATH_COMPONENT) as GuidePathComponent;
      const id = proxy.proxyId;
      live.add(id);
      const pathChanged = this.appliedPathRevision.get(id) !== state.pathRevision;
      if (!pathChanged && this.appliedRevision.get(id) === state.revision) continue;
      this.appliedPathRevision.set(id, state.pathRevision);
      this.appliedRevision.set(id, state.revision);
      this.scene.setGuidePath(id, {
        points: state.points as unknown as ReadonlyArray<readonly [number, number, number]>,
        curve: state.curve,
        markerColor: state.markerColor,
        currentPointIndex: state.currentPointIndex,
        enabled: state.enabled,
      }, pathChanged);
    }
    // 槽位会被复用：Actor 没了就丢掉记账，否则新 proxy 拿到同一个下标时
    // 会被误判成「已经应用过」而收不到首次命令。
    for (const id of this.appliedRevision.keys()) {
      if (live.has(id)) continue;
      this.appliedRevision.delete(id);
      this.appliedPathRevision.delete(id);
    }
  }
}

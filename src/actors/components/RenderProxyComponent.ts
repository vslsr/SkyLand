import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { ProxyId, RenderCommandSink } from '../../render/RenderScene';

export const RENDER_PROXY_COMPONENT = 'render-proxy';

/**
 * Actor 在渲染世界里的句柄（引擎迁移路线图 第 1 步）。
 *
 * **它只持有一个整数。** 这里曾经是 `ThreeObjectComponent`，直接握着
 * `THREE.Group`——单线程能跑，一上 worker 全废，因为对象过不了线程边界。
 * 换成 `proxyId` 之后，Game World 与 Render World 之间就只剩 id 和字节。
 *
 * `commands` 是往渲染世界发命令的口子，不是场景本身：单线程下它是一次直接
 * 调用，上 worker 之后同一个方法变成往环形缓冲写一条 destroy 命令。
 */
export class RenderProxyComponent extends ActorComponent {
  public constructor(
    public readonly proxyId: ProxyId,
    private readonly commands: RenderCommandSink,
  ) {
    super(RENDER_PROXY_COMPONENT);
  }

  public override onEndPlay(): void {
    this.commands.destroyMeshProxy(this.proxyId);
  }
}

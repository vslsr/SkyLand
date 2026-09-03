import { buildContainerView, type ContainerModelLike, type InventoryModelLike } from '../inventory/index';
import type { InventoryCommand } from '../network/messages';
import type { ContainerPage } from '../ui/pages/ContainerPage';

export interface ContainerPort {
  getInventory(): InventoryModelLike | undefined;
  /** 这个 Actor 上的容器 Component；看不见它时是 undefined。 */
  getContainer(actorId: string): ContainerModelLike | undefined;
  /** 服务端认为我开着哪个容器；关掉也由它说了算（走远会被服务端移出）。 */
  findOpenContainerActorId(): string | undefined;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  send(command: InventoryCommand): void;
}

/**
 * 容器界面的 Controller。
 *
 * MVC 里唯一同时认识 Model 和 View 的一层。它和背包 Controller 有一处关键不同：
 * **开合不是本地状态**。
 *
 * 界面开着与否跟随服务端的 `container.open`——走远、箱子被拆、掉线都由服务端把人
 * 移出，客户端不需要各自判一遍距离，也就不会出现「服务端已经关了但界面还开着，
 * 点存取全部被拒」这种状态。玩家按下交互键只是发一条 `container:open`，界面在
 * 下一帧快照回来时才真的打开。
 */
export class ContainerController {
  /** 上一次画出去的 revision；null 表示上一次画的是「没有容器」。 */
  private renderedRevision: number | null = null;
  private renderedActorId?: string;
  /**
   * 已经请求关闭、还在等服务端确认的那个容器。
   *
   * 这不是第二个「开着没有」的真相来源，而是一次**在途请求**的记账。没有它的话：
   * 点 X 立刻弹栈 → `container:close` 还在路上 → 下一帧快照里服务端仍然认为我
   * 开着 → `sync()` 把页面推回来 → 再下一帧才真的关上。表现就是关闭时闪一下。
   *
   * 快照 10Hz，纯等服务端确认要 100ms 以上才消失，点 X 会明显发黏，所以这里保留
   * 立即关闭，只是让 `sync()` 在确认到达之前别把它推回来。
   */
  private pendingCloseActorId?: string;

  public constructor(
    private readonly view: ContainerPage,
    private readonly port: ContainerPort,
  ) {
    this.view.onTransfer((itemType, quantity, direction) => {
      const actorId = this.port.findOpenContainerActorId();
      if (!actorId || quantity <= 0) return;
      this.port.send({ kind: 'container:transfer', actorId, itemType, quantity, direction });
    });
    this.view.onStoreAll(() => this.storeAll());
  }

  /** 收到快照后调用：跟随服务端开合，内容变了才重画。 */
  public sync(): void {
    const reported = this.port.findOpenContainerActorId();
    // 服务端已经不认为我开着它了：这次关闭到账，在途标记可以清掉。
    if (this.pendingCloseActorId && reported !== this.pendingCloseActorId) {
      this.pendingCloseActorId = undefined;
    }
    // 还在等确认的那个当作已经关了；别的箱子照常开——中途走到另一个箱子前面按 E
    // 不该被上一次的在途关闭压掉。
    const actorId = reported === this.pendingCloseActorId ? undefined : reported;
    const container = actorId ? this.port.getContainer(actorId) : undefined;
    if (!actorId || !container) {
      if (this.port.isOpen()) this.port.setOpen(false);
      this.renderedRevision = null;
      this.renderedActorId = undefined;
      return;
    }
    if (!this.port.isOpen()) this.port.setOpen(true);
    // 换了一个箱子也可能撞上同一个 revision，所以 actorId 也要比。
    if (this.renderedActorId === actorId && this.renderedRevision === container.revision) return;
    this.renderedActorId = actorId;
    this.renderedRevision = container.revision;
    this.view.setContainer(buildContainerView(actorId, container, this.port.getInventory()));
  }

  /** 主动关：X 按钮与 Esc 都走这里。界面立刻收起，服务端确认在后面到。 */
  public requestClose(): void {
    const actorId = this.port.findOpenContainerActorId();
    if (actorId) {
      this.port.send({ kind: 'container:close', actorId });
      // 记下这次在途请求，`sync()` 才不会在确认到达之前把页面推回来。
      this.pendingCloseActorId = actorId;
    }
    this.port.setOpen(false);
  }

  /**
   * 一键全存。
   *
   * 逐种发一条，而不是发一条「全部」：服务端那边每种物品的可存量都要各自截断
   * （箱子可能中途装满），拆成一条一条之后，成功的那些照样进去，装不下的原样
   * 留在背包里。
   */
  private storeAll(): void {
    const actorId = this.port.findOpenContainerActorId();
    const inventory = this.port.getInventory();
    if (!actorId || !inventory) return;
    const totals = new Map<string, number>();
    for (const entry of [...inventory.slots, ...inventory.pooled]) {
      totals.set(entry.itemType, (totals.get(entry.itemType) ?? 0) + entry.quantity);
    }
    for (const [itemType, quantity] of totals) {
      this.port.send({ kind: 'container:transfer', actorId, itemType, quantity, direction: 'store' });
    }
  }
}

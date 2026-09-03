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
    const actorId = this.port.findOpenContainerActorId();
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

  /** 主动关：玩家点了关闭按钮。服务端收到后把我移出，下一帧快照才真的关上。 */
  public requestClose(): void {
    const actorId = this.port.findOpenContainerActorId();
    if (actorId) this.port.send({ kind: 'container:close', actorId });
    // 界面先收起来，不等那一帧：关闭是玩家自己的意图，等一帧会感觉按钮没反应。
    // 万一服务端拒了，下一次 sync 会把它重新打开。
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

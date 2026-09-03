import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import { buildInventoryView, type InventoryModelLike } from '../inventory/index';
import type { InventoryCommand } from '../network/messages';
import type { InventoryItemAction } from '../ui/InventoryItemMenu';
import type { InventoryPage } from '../ui/pages/InventoryPage';

export interface InventoryPort {
  /** 当前角色的背包 Component；没进房间或角色已销毁时是 undefined。 */
  getInventory(): InventoryModelLike | undefined;
  /** 背包界面现在是不是 CommonUI 栈顶。 */
  isOpen(): boolean;
  /** 把界面推入或弹出 CommonUI 栈。 */
  setOpen(open: boolean): void;
  /** 现在能不能开背包：大厅、创建房间等页面盖着时不开。 */
  canOpen(): boolean;
  /** 把一条意图发给服务端。改没改成以下一帧快照为准，这里不预测。 */
  send(command: InventoryCommand): void;
}

/**
 * 背包的 Controller。
 *
 * MVC 里唯一同时认识 Model 和 View 的一层：它决定什么时候开合、什么时候
 * 把 Component 翻译成视图数据交给 `InventoryPage`。界面不碰 Component，
 * Component 也不知道界面存在。
 *
 * 开合有两条入口，因为它们的可用时机不一样：
 *
 * - 手柄和触屏走 `Input.Player.Inventory` 标签，只能在 Gameplay Input 还开着
 *   （也就是背包还没开）的时候按到，所以这条只负责「打开」；
 * - 键盘那一下由场景注册成 CommonUI 全局入口，页面盖住画面时依然收得到，
 *   所以关背包的那次 `toggle` 走的是它。
 */
export class InventoryController {
  /** 上一次画出去的 revision；null 表示上一次画的是「没有背包」。 */
  private renderedRevision: number | null = null;
  private hasRendered = false;
  private readonly disposeBinding: () => void;

  public constructor(
    private readonly view: InventoryPage,
    input: InputSubsystem,
    private readonly port: InventoryPort,
  ) {
    this.disposeBinding = input.bind(
      PlayerInputTags.Inventory,
      () => this.toggle(),
      { phases: ['triggered'] },
    );
    this.view.onItemAction((action, itemType) => this.applyItemAction(action, itemType));
  }

  /**
   * 背包菜单里那三条各自兑现成什么。
   *
   * **「使用」只是把它送到手上并让开画面**，不代按一次使用键。这个项目里的 `use`
   * 是一个世界动作：投掷要蓄力（`mode: 'charge'`，菜单里按不出力度），工具要面前
   * 正好有可采集的目标（背包盖着画面时玩家根本没在瞄）。代按一次得到的只会是一次
   * 脚下的软投或一次打空的敲击——比什么都不做更糟。菜单能诚实做到的是上手。
   */
  private applyItemAction(action: InventoryItemAction, itemType: string): void {
    if (action === 'use') {
      this.port.send({ kind: 'hold', itemType });
      this.close();
      return;
    }
    if (action === 'drop') {
      // 走 `drop:stack` 而不是「先 hold 再 drop」：后者会顺手改写快捷栏一格、
      // 把原本握着的东西换下去，丢完还自动再抽一个同类的到手上。
      this.port.send({ kind: 'drop:stack', itemType });
      return;
    }
    const slotIndex = this.resolveEquipSlot(itemType);
    if (slotIndex === undefined) return;
    this.port.send({ kind: 'assign', slotIndex, itemType });
  }

  /**
   * 装备放进哪一格：已经配着它的那格 → 第一个空格 → 当前选中格。
   *
   * 和 `InventoryComponent.holdItemType` 是同一套顺序，两条路进物品栏的落点因此
   * 一致；服务端仍会自己校验序号，这里算错最多是一次没有效果的请求。
   */
  private resolveEquipSlot(itemType: string): number | undefined {
    const hotbar = this.port.getInventory()?.hotbar;
    if (!hotbar || hotbar.length === 0) return undefined;
    const existing = hotbar.indexOf(itemType);
    if (existing >= 0) return existing;
    const firstEmpty = hotbar.indexOf(null);
    if (firstEmpty >= 0) return firstEmpty;
    const active = this.port.getInventory()?.activeHotbarIndex ?? 0;
    return Math.max(0, active);
  }

  public toggle(): void {
    if (this.port.isOpen()) {
      this.close();
      return;
    }
    this.open();
  }

  public open(): void {
    if (this.port.isOpen() || !this.port.canOpen()) return;
    // 换了角色也可能撞上同一个 revision，所以开的这一下一律重画。
    this.hasRendered = false;
    this.refresh();
    this.port.setOpen(true);
  }

  public close(): void {
    if (!this.port.isOpen()) return;
    this.port.setOpen(false);
  }

  /** 收到快照后调用：开着才重画，revision 没动就跳过。 */
  public sync(): void {
    if (!this.port.isOpen()) return;
    this.refresh();
  }

  /** 把开合键的显示名交给界面，让关闭提示写玩家实际按的那个键。 */
  public setControlLabel(label: string | undefined): void {
    this.view.setCloseHint(label);
  }

  public dispose(): void {
    this.disposeBinding();
  }

  private refresh(): void {
    const inventory = this.port.getInventory();
    const revision = inventory ? inventory.revision : null;
    if (this.hasRendered && this.renderedRevision === revision) return;
    this.hasRendered = true;
    this.renderedRevision = revision;
    this.view.setInventory(inventory ? buildInventoryView(inventory) : undefined);
  }
}

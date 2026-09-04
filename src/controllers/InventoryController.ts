import { itemCatalog } from '../../shared/items/index.mjs';
import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import { buildInventoryView, type InventoryModelLike } from '../inventory/index';
import type { InventoryCommand, InventorySlotAddress } from '../network/messages';
import type { InventoryItemAction } from '../ui/InventoryItemMenu';
import type { InventorySlotRef } from '../ui/InventorySlotCell';
import type {
  InventoryDragSource,
  InventoryDragTarget,
  InventoryPage,
} from '../ui/pages/InventoryPage';

export interface InventoryPort {
  /** 当前角色的背包 Component；没进房间或角色已销毁时是 undefined。 */
  getInventory(): InventoryModelLike | undefined;
  /**
   * 告诉输入层「接下来的使用键说的是这件东西」。
   *
   * 背包里点「使用」授予的是一条能力，激活要按使用键——两边说的必须是同一件东西，
   * 所以这条和 `use:arm` 在同一刻发出。传 undefined 是撤销。
   */
  armItem(itemType: string | undefined, options?: { onHotbar?: boolean }): void;
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
    this.view.onItemAction((action, slot) => this.applyItemAction(action, slot));
    this.view.onDragDrop((source, target) => this.applyDragDrop(source, target));
  }

  /**
   * 背包菜单里那三条各自兑现成什么。
   *
   * **「使用」不再是「拿到手上」**。这个项目里的使用是一条临时授予玩家的能力：
   * 点一下菜单把它挂上去，随后按使用键激活（点按物品当场结算，长按物品要按住走
   * 完那圈圆形倒计时），完成后能力收回。它因此和物品栏是两条独立的路——吃一
   * 个果子不该顺手改写物品栏的一格，也不该让玩家先装配再切格再按键。
   *
   * 「装配」才是把背包里那一摞搬进物品栏。
   */
  private applyItemAction(action: InventoryItemAction, slot: InventorySlotRef): void {
    if (slot.kind === 'hotbar') {
      this.applyHotbarAction(action, slot.slotIndex);
      return;
    }
    const itemType = slot.itemType;
    if (action === 'use') {
      // 让开画面：激活要按使用键，而使用键在背包盖着画面时收不到。
      this.port.armItem(itemType);
      this.port.send({ kind: 'use:arm', itemType });
      this.close();
      return;
    }
    if (action === 'drop') {
      // 走 `drop:stack` 而不是「先装配再丢」：后者会顺手改写物品栏一格、
      // 把原本握着的东西换下去。
      this.port.send({ kind: 'drop:stack', itemType });
      return;
    }
    if (action === 'unload') {
      this.port.send({ kind: 'ammo:unload', slot: { kind: 'backpack', itemType } });
      return;
    }
    if (action !== 'equip') return;
    const slotIndex = this.resolveEquipSlot(itemType);
    if (slotIndex === undefined) return;
    // 动了物品栏就作废「刚刚在背包里点出来的那件」：服务端在同一批命令上撤同一条
    // 能力，两边说的因此始终是同一件东西。
    this.port.armItem(undefined);
    this.port.send({ kind: 'assign', slotIndex, itemType });
  }

  /**
   * 物品栏那一格的菜单。
   *
   * 「使用」在这本账上不是 `use:arm`：物品栏里那件东西的用法**跟着选中格走**，
   * 服务端在切格的同一刻就把能力挂上了。所以这里做的是「切到这一格 + 让开画面」，
   * 接下来按使用键激活的正是它——再发一条 arm 只会让两条能力抢同一个槽位。
   */
  private applyHotbarAction(action: InventoryItemAction, slotIndex: number): void {
    // 动了物品栏就作废「刚刚在菜单里点出来的那件」，理由同 `applyItemAction`；
    // 「使用」那一条随后自己重新指一件。
    this.port.armItem(undefined);
    if (action === 'use') {
      const inventory = this.port.getInventory();
      // 输入层现在就得知道接下来那一下说的是哪件东西：快照 10Hz，等它回来才认的话，
      // 玩家在这 100 毫秒里按下的那一下会因为「手上还是空的」被整条忽略——表现就是
      // 「点了使用，按下去没反应」。
      const itemType = inventory?.hotbar?.[slotIndex]?.itemType;
      this.port.armItem(itemType, { onHotbar: true });
      // 已经握在手上的那一格不用再切：`select` 把「切到当前格」当成收手，
      // 再发一次会把它从手上放下。
      if (inventory?.activeHotbarIndex !== slotIndex) {
        this.port.send({ kind: 'select', slotIndex });
      }
      this.close();
      return;
    }
    if (action === 'unequip') {
      this.port.send({ kind: 'hotbar:stow', slotIndex });
      return;
    }
    if (action === 'unload') {
      this.port.send({ kind: 'ammo:unload', slot: { kind: 'hotbar', slotIndex } });
      return;
    }
    if (action === 'drop') this.port.send({ kind: 'drop:hotbar', slotIndex });
  }

  /**
   * 拖拽：把一摞货从一本账搬到另一本账。
   *
   * 三种落点各自对应一条命令，语义都是转移而不是配置：
   *
   * - 背包 → 物品栏某格：装配（`assign`）；
   * - 物品栏 → 物品栏另一格：对调（`hotbar:swap`），玩家在排 1-9 的顺序；
   * - 物品栏 → 背包：收回（`hotbar:stow`）。
   */
  private applyDragDrop(source: InventoryDragSource, target: InventoryDragTarget): void {
    // 和「装配」同一个理由：动过物品栏，背包里点出来的那条能力就不再指向玩家想的
    // 那件东西了。
    this.port.armItem(undefined);
    // 背包界面里没有箱子那本账：`container` 那种格子只出现在容器界面上，
    // 它的拖拽由 `ContainerController` 兑现。
    if (source.kind === 'container') return;
    // 装填这一条优先：拖的是弹药、落点又收这种弹药时，玩家想的是「装进去」，
    // 不是「这两格对调」。其余情况仍然是搬。
    const loadTarget = this.resolveAmmoTarget(source, target);
    if (loadTarget) {
      this.port.send({ kind: 'ammo:load', slot: loadTarget, source });
      return;
    }
    if (target.kind === 'backpack' && target.itemType !== undefined && source.kind === 'backpack') {
      // 落在包里另一件东西上、又装不进去：包里的顺序是自动排的，没有「搬到这一格」
      // 这回事，所以什么都不做，而不是悄悄换个语义。
      return;
    }
    if (source.kind === 'backpack') {
      if (target.kind !== 'hotbar') return;
      this.port.send({ kind: 'assign', slotIndex: target.slotIndex, itemType: source.itemType });
      return;
    }

    if (target.kind === 'backpack') {
      this.port.send({ kind: 'hotbar:stow', slotIndex: source.slotIndex });
      return;
    }
    if (target.slotIndex === source.slotIndex) return;
    this.port.send({
      kind: 'hotbar:swap',
      fromIndex: source.slotIndex,
      slotIndex: target.slotIndex,
    });
  }

  /**
   * 这次拖拽是不是一次装填；是的话，装到哪一格。
   *
   * 判据只有一条，和服务端读的是同一份数据：**落点那件东西的 `ammo.accepts` 收不收
   * 拖过来的这一种**。所以「什么算弹药」由吃它的那件东西说了算——弹弓吃的是普通
   * 石头，而石头是材料，不是弹药分类。
   */
  private resolveAmmoTarget(
    source: InventorySlotAddress,
    target: InventoryDragTarget,
  ): InventorySlotAddress | undefined {
    const ammoType = this.itemTypeAt(source);
    const targetType = target.kind === 'hotbar'
      ? this.itemTypeAt({ kind: 'hotbar', slotIndex: target.slotIndex })
      : target.itemType;
    if (!ammoType || !targetType || ammoType === targetType) return undefined;
    const accepts = itemCatalog.get(targetType)?.ammo?.accepts;
    if (!accepts?.includes(ammoType)) return undefined;
    return target.kind === 'hotbar'
      ? { kind: 'hotbar', slotIndex: target.slotIndex }
      : { kind: 'backpack', itemType: targetType };
  }

  /** 那一格里现在装的是哪一种；空格是 undefined。 */
  private itemTypeAt(ref: InventorySlotAddress): string | undefined {
    if (ref.kind === 'backpack') return ref.itemType;
    return this.port.getInventory()?.hotbar?.[ref.slotIndex]?.itemType;
  }

  /**
   * 装配放进哪一格：已经装着它的那格 → 第一个空格 → 当前选中格。
   *
   * 服务端仍会自己校验序号与账本，这里算错最多是一次没有效果的请求。
   */
  private resolveEquipSlot(itemType: string): number | undefined {
    const inventory = this.port.getInventory();
    const hotbar = inventory?.hotbar;
    if (!hotbar || hotbar.length === 0) return undefined;
    const existing = hotbar.findIndex((slot) => slot?.itemType === itemType);
    if (existing >= 0) return existing;
    const firstEmpty = hotbar.findIndex((slot) => slot === null);
    if (firstEmpty >= 0) return firstEmpty;
    return Math.max(0, inventory?.activeHotbarIndex ?? 0);
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

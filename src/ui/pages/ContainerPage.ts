import { ModalWindow } from '../common/ModalWindow';
import {
  InventoryItemMenu,
  type InventoryItemMenuEntry,
} from '../InventoryItemMenu';
import {
  backpackSlotView,
  containerSlotView,
  createInventorySlotCell,
  hotbarSlotView,
  type InventorySlotRef,
  type InventorySlotView,
} from '../InventorySlotCell';
import type { CommonUICloseReason } from '../common/CommonUIPage';
import type { ContainerView } from '../../inventory/index';

/** 一次拖拽落到哪一片上。箱子和背包各是一整片落点，格子顺序不是信息。 */
export type ContainerDragTarget = 'container' | 'backpack';

/**
 * 搬一次的全部内容：搬**哪一格**、搬几个、往哪个方向。
 *
 * 菜单和拖拽说的是同一件事，所以它们报的是同一份意图——两条入口，一个含义。
 * 方向不用另外判断：它由那一格在哪一片上决定（箱内的只能取出，身上的只能存入）。
 */
export interface ContainerTransferRequest {
  readonly slot: InventorySlotRef;
  readonly quantity: number;
  readonly direction: 'store' | 'withdraw';
}

/**
 * 容器界面。
 *
 * View：只把 `ContainerView` 画出来，把「搬哪一格、搬到哪一片」交出去。它不认识
 * 物品目录、不认识 Component、也不发请求——搬没搬动由服务端说了算。
 *
 * **上半屏是箱内，下半屏就是背包界面那一份**（背包 + 物品栏），中间隔一道线。
 * 箱子和背包装的是同一种东西、守的是同一套堆叠与货位规则，所以界面上也是同一种
 * 格子（`createInventorySlotCell`）：一样点得开菜单、一样拖得动、一样用记号说
 * 「这一格里是什么」。搬东西就是把一格拖到另一片上——玩家已经在背包里学过这个
 * 动作，不必为箱子再学一套。
 *
 * 这一版之前是一张表：一行一种物品，箱内和身上两个数字并排，右侧「存 / 取」两个
 * 按钮。那张表读起来像库存清单而不像一个箱子——一件东西在包里占几格、堆没堆满、
 * 箱子还剩多少空位，全被折叠成了数字。格子把这些还原成看得见的形状。
 *
 * 同一个箱子可以被几个人同时翻：别人存进去的东西会随下一帧快照直接出现在这里，
 * 界面不需要为此做任何事——它本来就只画收到的状态。
 */
export class ContainerPage extends ModalWindow {
  private readonly capacityText: HTMLElement;
  private readonly viewerText: HTMLElement;
  private readonly containerGrid: HTMLElement;
  private readonly backpackGrid: HTMLElement;
  private readonly backpackHeading: HTMLElement;
  private readonly hotbarSection: HTMLElement;
  private readonly hotbarTrack: HTMLElement;
  private readonly emptyNotice: HTMLElement;
  private readonly storeAllButton: HTMLButtonElement;
  private readonly itemMenu: InventoryItemMenu;
  private view?: ContainerView;
  private transferHandler?: (request: ContainerTransferRequest) => void;
  private storeAllHandler?: () => void;
  /** 正在拖的是哪一格；记在这里而不是 `DataTransfer`，理由同背包界面。 */
  private dragSource?: InventorySlotRef;

  public constructor() {
    super({
      id: 'container',
      kicker: 'STORAGE',
      title: '储物箱',
      description: '大宗资源存进箱子；箱子归这片地方所有，同伴也能一起取用。',
      size: 'wide',
      // Esc 不能走 CommonUI 的默认弹栈：那条路只把页面弹掉，不通知服务端，于是
      // 下一帧快照又把它推回来。这里自己接管，和 X 按钮走同一个 requestClose。
      closeOnEscape: false,
    });
    this.element.className += ' container-window';

    const summary = document.createElement('section');
    summary.className = 'container__summary';
    this.capacityText = document.createElement('p');
    this.capacityText.className = 'container__capacity';
    this.viewerText = document.createElement('p');
    this.viewerText.className = 'container__viewers';
    this.viewerText.setAttribute('role', 'status');
    this.storeAllButton = document.createElement('button');
    this.storeAllButton.type = 'button';
    this.storeAllButton.className = 'container__store-all';
    this.storeAllButton.textContent = '全部存入';
    this.storeAllButton.addEventListener('click', () => this.storeAllHandler?.());
    summary.append(this.capacityText, this.viewerText, this.storeAllButton);

    this.emptyNotice = document.createElement('p');
    this.emptyNotice.className = 'container__empty-notice';
    this.emptyNotice.textContent = '还没有这个箱子的内容。';
    this.emptyNotice.hidden = true;

    // 箱内那一片整体是一个落点（「放进箱子」，箱内顺序本来就是自动排的）。
    this.containerGrid = document.createElement('ul');
    this.containerGrid.className = 'inventory__grid container__grid';
    this.containerGrid.setAttribute('role', 'list');
    this.containerGrid.setAttribute('aria-label', '箱内');
    this.makeGridDropZone(this.containerGrid, 'container');

    this.backpackHeading = document.createElement('h3');
    this.backpackHeading.className = 'container__heading';
    this.backpackHeading.textContent = '背包';

    this.backpackGrid = document.createElement('ul');
    this.backpackGrid.className = 'inventory__grid';
    this.backpackGrid.setAttribute('role', 'list');
    this.backpackGrid.setAttribute('aria-label', '背包');
    this.makeGridDropZone(this.backpackGrid, 'backpack');

    this.bodyElement.append(
      summary,
      this.emptyNotice,
      this.containerGrid,
      this.backpackHeading,
      this.backpackGrid,
    );

    this.hotbarSection = document.createElement('section');
    this.hotbarSection.className = 'inventory-hotbar';
    this.hotbarSection.setAttribute('aria-label', '物品栏');
    const hint = document.createElement('p');
    hint.className = 'inventory-hotbar__hint';
    hint.textContent = '往上拖是存进箱子，从箱子往下拖是取回来；点一格也能选';
    this.hotbarTrack = document.createElement('ul');
    this.hotbarTrack.className = 'inventory-hotbar__track';
    this.hotbarTrack.setAttribute('role', 'list');
    this.hotbarSection.append(hint, this.hotbarTrack);
    this.footerElement.append(this.hotbarSection);

    // 菜单挂在页面根节点上而不是正文里：正文 `overflow: auto` 会把它裁掉半截。
    this.itemMenu = new InventoryItemMenu(this.element);
    this.itemMenu.onSelect((action, slot) => this.requestTransfer(
      slot,
      action === 'withdraw' ? 'withdraw' : 'store',
    ));

    this.setContainer(undefined);
  }

  /** Esc 与 X 走同一条路：都只是「请求关闭」，真正的关闭由服务端确认。 */
  public handleGlobalInputEvent(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape') return false;
    this.requestClose();
    return true;
  }

  /**
   * 搬一次。菜单和拖拽都走这一条：View 只报意图，怎么发命令是 Controller 的事。
   */
  public onTransfer(handler: (request: ContainerTransferRequest) => void): void {
    this.transferHandler = handler;
  }

  public onStoreAll(handler: () => void): void {
    this.storeAllHandler = handler;
  }

  /** 关掉容器时收起菜单：它挂着的那个格子已经不在了，监听也要在这里解绑。 */
  public onClose(_reason: CommonUICloseReason): void {
    this.itemMenu.close();
    this.dragSource = undefined;
  }

  /** 画一份容器；传 undefined 表示还没有权威数据。 */
  public setContainer(view: ContainerView | undefined): void {
    // 每次重画都会换掉全部格子，菜单挂着的那个锚点随之作废。这同时也是动作的
    // 收尾：搬完一次就会带来一次新快照，菜单跟着自己收起来。
    this.itemMenu.close();
    this.dragSource = undefined;
    this.view = view;
    if (!view) {
      this.titleElement.textContent = '储物箱';
      this.capacityText.textContent = '货位 —';
      this.viewerText.textContent = '';
      this.containerGrid.replaceChildren();
      this.backpackGrid.replaceChildren();
      this.hotbarTrack.replaceChildren();
      this.hotbarSection.hidden = true;
      this.backpackHeading.hidden = true;
      this.emptyNotice.hidden = false;
      this.storeAllButton.disabled = true;
      return;
    }

    this.titleElement.textContent = view.label;
    this.capacityText.textContent = `箱内货位 ${view.usedSlots} / ${view.slotCapacity}`;
    // 别人也在翻这个箱子时说一声：东西会在眼前变化，不说会以为是 bug。
    this.viewerText.textContent = view.otherViewerCount > 0
      ? `另有 ${view.otherViewerCount} 人正在翻这个箱子`
      : '';
    this.emptyNotice.hidden = true;
    this.backpackHeading.hidden = false;

    const stored = view.stored.map((stack) => this.createCell(containerSlotView(stack)));
    for (let index = 0; index < view.freeSlots; index += 1) {
      stored.push(this.createCell(emptySlot({ kind: 'container', itemType: '' })));
    }
    this.containerGrid.replaceChildren(...stored);

    const carried = view.carried;
    this.storeAllButton.disabled = !carried || carried.slots.length + carried.pooled.length === 0;
    if (!carried) {
      this.backpackGrid.replaceChildren();
      this.hotbarTrack.replaceChildren();
      this.hotbarSection.hidden = true;
      return;
    }
    // 背包那一片画的是「全部」，不分页：箱子前面要的是「我身上有什么」，
    // 而不是「我身上的补给品有什么」——翻页会把另一半藏起来。
    const cells = [...carried.slots, ...carried.pooled]
      .map((stack) => this.createCell(backpackSlotView(stack)));
    for (let index = 0; index < carried.freeSlots; index += 1) {
      cells.push(this.createCell(emptySlot({ kind: 'backpack', itemType: '' })));
    }
    this.backpackGrid.replaceChildren(...cells);
    this.hotbarSection.hidden = carried.hotbar.length === 0;
    this.hotbarTrack.replaceChildren(...carried.hotbar.map(
      (slot) => this.createCell(hotbarSlotView(slot)),
    ));
  }

  /** 三本账共用同一个格子构造，只在这里接上这一页的拖拽与菜单。 */
  private createCell(slot: InventorySlotView): HTMLElement {
    return createInventorySlotCell(slot, {
      openMenu: (cell, target) => this.openItemMenu(cell, target),
      beginDrag: (target) => {
        this.dragSource = target.ref;
        this.itemMenu.close();
      },
      endDrag: () => { this.dragSource = undefined; },
      isDragging: () => this.dragSource !== undefined,
    });
  }

  /**
   * 一整片接得住拖过来的东西。
   *
   * 落点是**哪一片**而不是哪一格：箱内和背包的顺序都是自动排的，没有「放到第几格」
   * 这回事，让玩家瞄准一个不存在的位置只会平添失败。
   *
   * `dragover` 必须 `preventDefault`，否则浏览器根本不会派发 `drop`。
   */
  private makeGridDropZone(zone: HTMLElement, target: ContainerDragTarget): void {
    zone.addEventListener('dragover', (event) => {
      if (!this.dragSource) return;
      event.preventDefault();
      const transfer = (event as DragEvent).dataTransfer;
      if (transfer) transfer.dropEffect = 'move';
    });
    zone.addEventListener('drop', (event) => {
      const source = this.dragSource;
      this.dragSource = undefined;
      if (!source) return;
      event.preventDefault();
      // 拖回自己那一片什么都不做：这两片里的顺序都是自动排的，没有「挪到这里」
      // 这回事，把它兑现成一次来回搬只会白跑一趟命令。
      const inContainer = source.kind === 'container';
      if (inContainer === (target === 'container')) return;
      this.requestTransfer(source, inContainer ? 'withdraw' : 'store');
    });
  }

  /** 把一格翻译成一次搬运请求：搬的是**那一格里现在有几个**，和拖拽同一个含义。 */
  private requestTransfer(slot: InventorySlotRef, direction: 'store' | 'withdraw'): void {
    const quantity = this.quantityAt(slot);
    if (quantity <= 0) return;
    this.transferHandler?.({ slot, quantity, direction });
  }

  /** 这一格现在有几个。界面画的是哪一摞，搬的就是哪一摞。 */
  private quantityAt(ref: InventorySlotRef): number {
    const view = this.view;
    if (!view) return 0;
    if (ref.kind === 'container') {
      return view.stored.find((stack) => stack.itemType === ref.itemType)?.quantity ?? 0;
    }
    if (ref.kind === 'hotbar') return view.carried?.hotbar[ref.slotIndex]?.quantity ?? 0;
    return [...(view.carried?.slots ?? []), ...(view.carried?.pooled ?? [])]
      .find((stack) => stack.itemType === ref.itemType)?.quantity ?? 0;
  }

  private openItemMenu(cell: HTMLElement, slot: InventorySlotView): void {
    if (!slot.itemType) return;
    if (this.itemMenu.isOpen && sameSlot(this.itemMenu.slot, slot.ref)) {
      this.itemMenu.close();
      return;
    }
    this.itemMenu.open(cell, slot.ref, slot.displayName ?? '', menuEntries(slot, this.view));
  }
}

/** 空格子也要画：那是「箱子还能装多少」「包里还剩几格」看得见的形状。 */
function emptySlot(ref: InventorySlotRef): InventorySlotView {
  return { ref, quantity: 0, stackLimit: 0, holdable: false };
}

/**
 * 这一格在箱子前面能做什么。
 *
 * 只有一条动作，方向由它在哪一片上决定：箱内那一格是「取出」，身上那一格是
 * 「存入」。搬的是整摞——和拖拽同一个含义，所以两条入口说的是同一件事。
 *
 * 数量选择器是拖拽之外第二费工的交互，而「整摞搬」覆盖了绝大多数实际操作；
 * 要精确挪几个，把那一摞取出来再存回去一部分反而更难，所以这条留到有人真的
 * 需要时再加。
 */
function menuEntries(
  slot: InventorySlotView,
  view: ContainerView | undefined,
): InventoryItemMenuEntry[] {
  if (slot.ref.kind === 'container') {
    return [{
      action: 'withdraw',
      label: '取出',
      hint: `把这一摞${slot.displayName ?? ''}搬回身上，装不下的留在箱里`,
    }];
  }
  const full = view !== undefined && view.freeSlots === 0;
  return [{
    action: 'store',
    label: '存入',
    hint: full ? '箱子满了，再存不进去' : `把这一摞${slot.displayName ?? ''}搬进箱子`,
    disabled: full,
  }];
}

function sameSlot(left: InventorySlotRef | undefined, right: InventorySlotRef): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'hotbar') return left.slotIndex === (right as { slotIndex: number }).slotIndex;
  return left.itemType === (right as { itemType: string }).itemType;
}

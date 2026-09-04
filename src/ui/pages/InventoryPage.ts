import { ModalWindow } from '../common/ModalWindow';
import {
  InventoryItemMenu,
  type InventoryItemAction,
  type InventoryItemMenuEntry,
} from '../InventoryItemMenu';
import {
  backpackSlotView,
  createInventorySlotCell,
  hotbarSlotView,
  type InventorySlotRef,
  type InventorySlotView,
} from '../InventorySlotCell';
import type { CommonUICloseReason } from '../common/CommonUIPage';
import type { InventoryView, ItemUseMode } from '../../inventory/index';

/** 一次拖拽从哪本账上拿的、落到哪本账上。两头说的都是「哪一格」。 */
export type InventoryDragSource = InventorySlotRef;
/**
 * 落到哪。
 *
 * 背包那一片整体是一个落点（「放回包里」，包里的顺序本来就是自动排的），但落在
 * **一件吃弹药的东西**上时说的是那一格——把石头拖到弓上和把石头扔回包里是两件事，
 * 所以这时带上 `itemType`。
 */
export type InventoryDragTarget =
  | { readonly kind: 'backpack'; readonly itemType?: string }
  | { readonly kind: 'hotbar'; readonly slotIndex: number };

/**
 * 背包界面。
 *
 * MVC 里的 View：只把 `InventoryView` 画出来。它不认识物品目录、不认识
 * Actor Component、也不发任何请求——拿不到数据就显示空态，拿到就重画。
 * 什么时候画、画哪一份，由 `InventoryController` 决定。
 *
 * 界面上是两本账并排：上面是背包，下面那条是**物品栏**。它们看起来是两个区域，
 * 实质是同一种东西的两个去处，所以格子只有一套（`createInventorySlotCell`）：
 * 两边都点得开菜单、都拖得动、都用同一套记号说「这一格里是什么」。中间那道动作
 * 因此是「搬」而不是「设置」——把一格拖到另一边，或者在菜单里选装配 / 收回背包，
 * 说的都是同一件事。
 */
export class InventoryPage extends ModalWindow {
  private readonly ledgerText: HTMLElement;
  private readonly slotGrid: HTMLElement;
  private readonly emptyNotice: HTMLElement;
  private readonly tabBar: HTMLElement;
  /** 下方那条物品栏。格数由快照决定，所以整条按 `HotbarSlotView[]` 重画。 */
  private readonly hotbarTrack: HTMLElement;
  private readonly hotbarSection: HTMLElement;
  private closeHintText = 'Esc 关闭';
  private readonly closeHint: HTMLElement;
  /** 当前页签。分类空掉时自动落回「全部」，不会停在一个打不开的页上。 */
  private activePageId: string = 'all';
  private view?: InventoryView;
  private readonly itemMenu: InventoryItemMenu;
  private actionHandler?: (action: InventoryItemAction, slot: InventorySlotRef) => void;
  private dragHandler?: (source: InventoryDragSource, target: InventoryDragTarget) => void;
  /**
   * 正在拖的是哪一格。
   *
   * 记在这里而不是塞进 `DataTransfer`：拖拽全程都在这一个页面里，读回来的东西
   * 只有自己写得出来，走一遍字符串序列化没有任何收益，还会把「拖的是第几格」这条
   * 结构化信息压成一个需要再解析的字符串。
   */
  private dragSource?: InventoryDragSource;

  public constructor() {
    super({
      id: 'player-inventory',
      kicker: 'BACKPACK',
      title: '背包',
      description: '角色只带得走一次收获：大宗资源存进船舱，弹药和基础工具不占格。',
      size: 'wide',
    });
    this.element.className += ' inventory-window';

    // 「货位 2 / 6」加一条进度条曾经占着最上面一整块。**那是个读数，不是信息**：
    // 空格本来就画成虚线方格，还剩几格一眼数得出来；真正要说的只有「满了」，
    // 而那一句在 ledger 里。所以整块去掉，剩下的只在有话说时才出现。
    this.ledgerText = document.createElement('p');
    this.ledgerText.className = 'inventory__ledger';
    this.ledgerText.setAttribute('role', 'status');
    this.ledgerText.hidden = true;

    this.emptyNotice = document.createElement('p');
    this.emptyNotice.className = 'inventory__empty-notice';
    this.emptyNotice.textContent = '进入房间后才有随身物品。';
    this.emptyNotice.hidden = true;

    this.tabBar = document.createElement('div');
    this.tabBar.className = 'inventory__tabs';
    this.tabBar.setAttribute('role', 'tablist');
    this.tabBar.setAttribute('aria-label', '物品分类');

    // 没有小标题：页签就在正上方，它已经说了下面这一格格是什么。
    this.slotGrid = document.createElement('ul');
    this.slotGrid.className = 'inventory__grid';
    this.slotGrid.setAttribute('role', 'list');
    // 背包这一整片都是落点：从物品栏往回拖时，玩家想的是「放回包里」，
    // 而不是「放回包里第几格」——包里的顺序本来就是自动排的。
    this.makeGridDropZone(this.slotGrid);

    this.bodyElement.append(
      this.emptyNotice,
      this.ledgerText,
      this.tabBar,
      this.slotGrid,
    );

    this.hotbarSection = document.createElement('section');
    this.hotbarSection.className = 'inventory-hotbar';
    this.hotbarSection.setAttribute('aria-label', '物品栏');
    const hotbarHint = document.createElement('p');
    hotbarHint.className = 'inventory-hotbar__hint';
    hotbarHint.textContent = '这一条也是格子：点开有使用 / 收回背包 / 丢弃，拖进来就是装配（1-9 切换手持）';
    this.hotbarTrack = document.createElement('ul');
    this.hotbarTrack.className = 'inventory-hotbar__track';
    this.hotbarTrack.setAttribute('role', 'list');
    this.hotbarSection.append(hotbarHint, this.hotbarTrack);

    this.closeHint = document.createElement('p');
    this.closeHint.className = 'inventory__hint';
    this.closeHint.textContent = this.closeHintText;
    // 物品栏在页脚而不是正文里：正文会滚动，而这一条是拖拽的固定落点，
    // 滚走了就没法把东西拖过来。
    this.footerElement.append(this.hotbarSection, this.closeHint);

    // 菜单挂在页面根节点上而不是正文里：正文 `overflow: auto` 会把它裁掉半截。
    this.itemMenu = new InventoryItemMenu(this.element);
    this.itemMenu.onSelect((action, slot) => this.actionHandler?.(action, slot));

    this.setInventory(undefined);
  }

  /** 由 Controller 解析出的开合按键，用来把关闭提示写成玩家实际按的那个键。 */
  public setCloseHint(controlLabel: string | undefined): void {
    this.closeHintText = controlLabel ? `Esc 或 ${controlLabel} 关闭` : 'Esc 关闭';
    this.closeHint.textContent = this.closeHintText;
  }

  /**
   * 点一下某一格会弹出菜单，选中哪一条由这里交出去。
   *
   * View 只报意图：每条动作要发哪几条命令，是 Controller 的事。
   */
  public onItemAction(
    handler: (action: InventoryItemAction, slot: InventorySlotRef) => void,
  ): void {
    this.actionHandler = handler;
  }

  /** 一次拖拽落地了：从哪来、到哪去交出去，怎么兑现是 Controller 的事。 */
  public onDragDrop(
    handler: (source: InventoryDragSource, target: InventoryDragTarget) => void,
  ): void {
    this.dragHandler = handler;
  }

  /**
   * 关掉背包（弹栈、清空、切场景都算）时把菜单收起来。
   *
   * 不只是为了下次开背包别看见一个挂在旧格子上的菜单：菜单开着时在 document 和
   * window 上挂着关闭监听，这里是它们唯一的解绑点。
   */
  public onClose(_reason: CommonUICloseReason): void {
    this.itemMenu.close();
    this.dragSource = undefined;
  }

  /** 画一份背包；传 undefined 表示还没有权威数据（没进房间或角色已销毁）。 */
  public setInventory(view: InventoryView | undefined): void {
    // 每次重画都会换掉全部格子，菜单挂着的那个锚点随之作废。这同时也是动作的
    // 收尾：装配完、丢完都会带来一次新快照，菜单跟着自己收起来。
    this.itemMenu.close();
    this.dragSource = undefined;
    this.view = view;
    this.emptyNotice.hidden = view !== undefined;
    if (!view) {
      this.setLedger('');
      this.tabBar.replaceChildren();
      this.slotGrid.replaceChildren();
      this.hotbarTrack.replaceChildren();
      this.hotbarSection.hidden = true;
      return;
    }

    this.setLedger(this.describeLedger(view));
    // 上一次停留的分类可能已经空了（东西用完或存进了箱子）；落回全部而不是留白。
    if (!view.pages.some((page) => page.id === this.activePageId)) this.activePageId = 'all';
    this.renderTabs(view);
    this.renderPage(view);
    this.renderHotbar(view);
  }

  private renderTabs(view: InventoryView): void {
    this.tabBar.replaceChildren(...view.pages.map((page) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'inventory__tab';
      tab.setAttribute('role', 'tab');
      const selected = page.id === this.activePageId;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
      // 标签和数量拆开：数量不是名字的一部分，它该是一个更淡、更小的附注。
      const label = document.createElement('span');
      label.className = 'inventory__tab-label';
      label.textContent = page.label;
      const count = document.createElement('span');
      count.className = 'inventory__tab-count';
      count.textContent = String(page.stacks.length);
      count.setAttribute('aria-hidden', 'true');
      tab.append(label, count);
      tab.setAttribute('aria-label', `${page.label} ${page.stacks.length} 件`);
      tab.addEventListener('click', () => {
        if (this.activePageId === page.id || !this.view) return;
        this.activePageId = page.id;
        this.renderTabs(this.view);
        this.renderPage(this.view);
      });
      return tab;
    }));
  }

  private renderPage(view: InventoryView): void {
    const page = view.pages.find((entry) => entry.id === this.activePageId) ?? view.pages[0];
    const stacks = page?.stacks ?? [];
    const cells = stacks.map((stack) => this.createCell(backpackSlotView(stack)));
    // 空格只在「全部」页补：分类页补空格会让人以为那个分类有独立容量。
    if (this.activePageId === 'all') {
      for (let index = 0; index < view.freeSlots; index += 1) {
        cells.push(this.createCell({
          ref: { kind: 'backpack', itemType: '' },
          quantity: 0,
          stackLimit: 0,
          holdable: false,
        }));
      }
    }
    this.slotGrid.replaceChildren(...cells);
  }

  /**
   * 下方那条物品栏。
   *
   * 它画的是**物品栏自己持有的那一摞**，不是背包里某件东西的影子：数量直接读格子，
   * 所以「装配之后背包里少了、这条上多了」在界面上是看得见的一次搬运。
   */
  private renderHotbar(view: InventoryView): void {
    this.hotbarSection.hidden = view.hotbar.length === 0;
    this.hotbarTrack.replaceChildren(...view.hotbar.map(
      (slot) => this.createCell(hotbarSlotView(slot)),
    ));
  }

  /** 两本账共用同一个格子构造，只在这里接上这一页的拖拽与菜单。 */
  private createCell(slot: InventorySlotView): HTMLElement {
    return createInventorySlotCell(slot, {
      openMenu: (cell, target) => this.openItemMenu(cell, target),
      beginDrag: (target) => {
        this.dragSource = target.ref;
        this.itemMenu.close();
      },
      endDrag: () => { this.dragSource = undefined; },
      isDragging: () => this.dragSource !== undefined,
      // 物品栏那一条的每一格都是落点（拖进来 = 装配到这一格）；背包那边整片是
      // 一个落点，所以背包格子自己不接——**除了吃弹药的那一格**：装填说的是「装到
      // 这一件上」，那一格必须自己接得住，不能被「放回包里」吞掉。
      // 背包格子接下之后 `dragSource` 已经清空，冒泡到整片的那次因此自己空转。
      dropOn: slot.ref.kind === 'hotbar' || slot.ammoSlot !== undefined
        ? (target) => {
          const source = this.dragSource;
          this.dragSource = undefined;
          if (!source) return;
          this.dragHandler?.(
            source,
            target.ref.kind === 'hotbar'
              ? { kind: 'hotbar', slotIndex: target.ref.slotIndex }
              : { kind: 'backpack', itemType: target.ref.itemType },
          );
        }
        : undefined,
    });
  }

  private describeLedger(view: InventoryView): string {
    const parts: string[] = [];
    if (view.cargoValue > 0) parts.push(`待兑现 ${view.cargoValue} 金币`);
    if (view.contrabandCount > 0) parts.push(`携带 ${view.contrabandCount} 件违禁品，位置会被公开`);
    if (view.freeSlots === 0) parts.push('背包满了，再采只能留在原地');
    return parts.join(' · ');
  }

  /** 没话说就整行收起来，不留一条空白。 */
  private setLedger(text: string): void {
    this.ledgerText.textContent = text;
    this.ledgerText.hidden = text.length === 0;
  }

  /**
   * 弹出这一格的动作菜单。
   *
   * 已经在同一格上开着就收起来：再点一次是「我不选了」，而不是把同一份菜单
   * 重画一遍。
   */
  private openItemMenu(cell: HTMLElement, slot: InventorySlotView): void {
    if (!slot.itemType) return;
    if (this.itemMenu.isOpen && sameSlot(this.itemMenu.slot, slot.ref)) {
      this.itemMenu.close();
      return;
    }
    this.itemMenu.open(cell, slot.ref, slot.displayName ?? '', this.menuEntries(slot));
  }

  /**
   * 这一格现在能做哪几件事。
   *
   * 三条都列出来，做不了的那条列出来但点不动：直接抹掉会让菜单在不同格子上长得
   * 不一样，玩家得先数一遍才知道点的是哪一条。
   *
   * 两本账的第三条方向相反：背包里那一格往物品栏搬（装配），物品栏那一格往背包
   * 搬（收回背包）。这也是它们唯一的区别。
   */
  private menuEntries(slot: InventorySlotView): InventoryItemMenuEntry[] {
    const stack = this.view?.slots.find((entry) => entry.itemType === slot.itemType);
    const hotbar = this.view?.hotbar.find((entry) => entry.itemType === slot.itemType);
    const usable = slot.ref.kind === 'hotbar' ? hotbar?.usable === true : stack?.usable === true;
    const equipped = this.view?.hotbar.some((entry) => entry.itemType === slot.itemType) ?? false;
    const onHotbar = slot.ref.kind === 'hotbar';
    const useHint = describeUse(
      usable,
      onHotbar ? hotbar?.useMode : stack?.useMode,
      (onHotbar ? hotbar?.holdSeconds : stack?.holdSeconds) ?? 0,
      onHotbar,
    );
    if (onHotbar) {
      return [
        { action: 'use', label: '使用', hint: useHint, disabled: !usable },
        {
          action: 'unequip',
          label: '收回背包',
          hint: '把这一格整摞搬回背包，那一格空出来',
        },
        ...ammoEntries(slot),
        { action: 'drop', label: '丢弃', hint: '把这一格的一个丢到身前的地上' },
      ];
    }
    return [
      { action: 'use', label: '使用', hint: useHint, disabled: !usable },
      {
        action: 'equip',
        label: '装配',
        hint: equipped ? '已经在物品栏上了' : '交给物品栏的空格，数字键就能切到手上',
        disabled: equipped || !slot.holdable,
      },
      ...ammoEntries(slot),
      { action: 'drop', label: '丢弃', hint: '把一个丢到身前的地上' },
    ];
  }

  /**
   * 背包那一整片接得住从物品栏拖回来的东西。
   *
   * `dragover` 必须 `preventDefault`，否则浏览器根本不会派发 `drop`。
   */
  private makeGridDropZone(zone: HTMLElement): void {
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
      this.dragHandler?.(source, { kind: 'backpack' });
    });
  }
}

/**
 * 「卸下弹药」那一条：只在吃弹药的那些格子上出现。
 *
 * 空着的时候仍然列出来但点不动——这一格**能**装弹药是它的属性，藏起来会让菜单
 * 在装弹前后长得不一样，玩家得先数一遍才知道点的是哪一条。
 */
function ammoEntries(slot: InventorySlotView): InventoryItemMenuEntry[] {
  if (!slot.ammoSlot) return [];
  const loaded = slot.ammo;
  return [{
    action: 'unload',
    label: '卸下弹药',
    hint: loaded
      ? `把 ${loaded.quantity} 个${loaded.displayName}收回身上`
      : '这一格现在空着，没有弹药可卸',
    disabled: !loaded,
  }];
}

function sameSlot(left: InventorySlotRef | undefined, right: InventorySlotRef): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === 'backpack' && right.kind === 'backpack'
    ? left.itemType === right.itemType
    : left.kind === 'hotbar' && right.kind === 'hotbar' && left.slotIndex === right.slotIndex;
}

/** 「使用」那一条说什么，取决于这件东西按一下还是按住、又在哪本账上。 */
function describeUse(
  usable: boolean,
  useMode: ItemUseMode | undefined,
  holdSeconds: number,
  onHotbar: boolean,
): string {
  if (!usable) return '这件东西没有用法';
  // 蓄力和长按画同一个圈，说法却相反：一个是「按住等它走完」，一个是「拉满了松手」。
  const press = holdSeconds > 0 && (useMode === 'hold' || useMode === 'charge')
    ? (useMode === 'charge'
      ? `按住使用键蓄力 ${holdSeconds} 秒，松手打出去`
      : `按住使用键 ${holdSeconds} 秒`)
    : '按一下使用键';
  return onHotbar ? `切到这一格并关掉背包，${press}` : `关掉背包，${press}`;
}

import { ModalWindow } from '../common/ModalWindow';
import { createItemIcon } from '../icons/ItemIconSprite';
import {
  InventoryItemMenu,
  type InventoryItemAction,
  type InventoryItemMenuEntry,
} from '../InventoryItemMenu';
import type { CommonUICloseReason } from '../common/CommonUIPage';
import type { HotbarSlotView, InventoryStackView, InventoryView } from '../../inventory/index';

/** 一次拖拽从哪本账上拿的。 */
export type InventoryDragSource =
  | { readonly kind: 'backpack'; readonly itemType: string }
  | { readonly kind: 'hotbar'; readonly slotIndex: number };

/** 一次拖拽落到哪本账上。 */
export type InventoryDragTarget =
  | { readonly kind: 'backpack' }
  | { readonly kind: 'hotbar'; readonly slotIndex: number };

/**
 * 背包界面。
 *
 * MVC 里的 View：只把 `InventoryView` 画出来。它不认识物品目录、不认识
 * Actor Component、也不发任何请求——拿不到数据就显示空态，拿到就重画。
 * 什么时候画、画哪一份，由 `InventoryController` 决定。
 *
 * 界面上是两本账并排：上面是背包，下面那条是**物品栏**。它们看起来是两个区域，
 * 实质是同一种东西的两个去处，所以中间那道动作是「搬」而不是「设置」——把一格
 * 拖到另一边，或者在菜单里选「装配」，两条路说的是同一件事。
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
  private actionHandler?: (action: InventoryItemAction, itemType: string) => void;
  private dragHandler?: (source: InventoryDragSource, target: InventoryDragTarget) => void;
  /**
   * 正在拖的是哪一摞。
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
    this.makeDropZone(this.slotGrid, () => ({ kind: 'backpack' }));

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
    hotbarHint.textContent = '拖到这一条，或用菜单里的「装配」，把东西交给物品栏（1-9 切换手持）';
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
    this.itemMenu.onSelect((action, itemType) => this.actionHandler?.(action, itemType));

    this.setInventory(undefined);
  }

  /** 由 Controller 解析出的开合按键，用来把关闭提示写成玩家实际按的那个键。 */
  public setCloseHint(controlLabel: string | undefined): void {
    this.closeHintText = controlLabel ? `Esc 或 ${controlLabel} 关闭` : 'Esc 关闭';
    this.closeHint.textContent = this.closeHintText;
  }

  /**
   * 点一下某件物品会弹出菜单，选中哪一条由这里交出去。
   *
   * View 只报意图：`use` / `equip` / `drop` 各自要发哪几条命令，是 Controller 的事。
   */
  public onItemAction(
    handler: (action: InventoryItemAction, itemType: string) => void,
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
    const cells = stacks.map((stack) => this.createStackCell(stack));
    // 空格只在「全部」页补：分类页补空格会让人以为那个分类有独立容量。
    if (this.activePageId === 'all') {
      for (let index = 0; index < view.freeSlots; index += 1) cells.push(this.createEmptyCell());
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
    this.hotbarTrack.replaceChildren(...view.hotbar.map((slot) => this.createHotbarCell(slot)));
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
  private openItemMenu(cell: HTMLElement, stack: InventoryStackView): void {
    if (this.itemMenu.isOpen && this.itemMenu.itemType === stack.itemType) {
      this.itemMenu.close();
      return;
    }
    this.itemMenu.open(cell, stack.itemType, stack.displayName, this.menuEntries(stack));
  }

  /**
   * 这一格现在能做哪几件事。
   *
   * 三条都列出来，做不了的那条列出来但点不动：直接抹掉会让菜单在不同格子上长得
   * 不一样，玩家得先数一遍才知道点的是哪一条。
   */
  private menuEntries(stack: InventoryStackView): InventoryItemMenuEntry[] {
    const equipped = this.view?.hotbar.some((slot) => slot.itemType === stack.itemType) ?? false;
    return [
      {
        action: 'use',
        label: '使用',
        hint: useHint(stack),
        disabled: !stack.usable,
      },
      {
        action: 'equip',
        label: '装配',
        hint: equipped ? '已经在物品栏上了' : '交给物品栏的空格，数字键就能切到手上',
        disabled: equipped || !stack.holdable,
      },
      {
        action: 'drop',
        label: '丢弃',
        hint: '把一个丢到身前的地上',
      },
    ];
  }

  private createEmptyCell(): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory__cell inventory__cell--empty';
    cell.setAttribute('aria-label', '空格子');
    return cell;
  }

  private createStackCell(stack: InventoryStackView): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory__cell';
    // 一次点击弹出菜单，动作在菜单里选；按住拖动则是直接搬到物品栏那一条上。
    // 两条入口指向同一件事，快的那条不用打开菜单，慢的那条不用先学会拖拽。
    if (stack.holdable) {
      cell.classList.add('inventory__cell--actionable');
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-haspopup', 'menu');
      // 格子是 `<li role="button">`，不是真的 `<button>`。`CommonUIManager` 只按标签名
      // 认「这次点击是给 DOM 的」，认不出它就会在捕获阶段把事件拦掉——点了格子毫无
      // 反应、菜单永远弹不出来。这条标记是它给出的显式入口。
      cell.dataset.commonUiReceiver = '';
      cell.addEventListener('click', () => this.openItemMenu(cell, stack));
      cell.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.openItemMenu(cell, stack);
      });
      this.makeDraggable(cell, { kind: 'backpack', itemType: stack.itemType });
    }
    cell.dataset.itemType = stack.itemType;
    cell.dataset.category = stack.category;
    if (stack.contraband) cell.dataset.contraband = 'true';
    cell.setAttribute('title', `${stack.displayName}　${stack.summary}`);
    cell.setAttribute(
      'aria-label',
      `${stack.categoryLabel} ${stack.displayName}，${stack.quantity} 个，上限 ${stack.stackLimit}`
      + (stack.holdable ? '，点击打开动作菜单，也可以拖到物品栏' : ''),
    );

    const swatch = document.createElement('span');
    swatch.className = 'inventory__swatch';
    // 物品自己的颜色画在底衬上，图标保持描边跟随文字色，选中态不用换图。
    swatch.setAttribute('style', `--item-tint:${stack.tint}`);
    swatch.append(createItemIcon(stack.iconId, { className: 'inventory__icon' }));

    const name = document.createElement('span');
    name.className = 'inventory__name';
    name.textContent = stack.displayName;

    const count = document.createElement('span');
    count.className = stack.full ? 'inventory__count is-full' : 'inventory__count';
    count.textContent = stack.stackLimit > 1 ? `${stack.quantity} / ${stack.stackLimit}` : '1';

    cell.append(swatch, name, count);

    if (stack.slotCost > 1) {
      const cost = document.createElement('span');
      cost.className = 'inventory__badge';
      cost.textContent = `${stack.slotCost} 格`;
      cell.append(cost);
    } else if (stack.slotCost === 0) {
      const pooledBadge = document.createElement('span');
      pooledBadge.className = 'inventory__badge inventory__badge--pooled';
      pooledBadge.textContent = '不占格';
      cell.append(pooledBadge);
    }
    if (stack.coinValue !== undefined) {
      const value = document.createElement('span');
      value.className = 'inventory__badge inventory__badge--coin';
      value.textContent = `${stack.coinValue} 金币`;
      cell.append(value);
    }
    return cell;
  }

  private createHotbarCell(slot: HotbarSlotView): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory-hotbar__slot';
    cell.dataset.state = slot.itemType ? 'ready' : 'empty';
    cell.dataset.active = String(slot.active);
    cell.dataset.slotIndex = String(slot.index);
    this.makeDropZone(cell, () => ({ kind: 'hotbar', slotIndex: slot.index }));

    const shortcut = document.createElement('span');
    shortcut.className = 'inventory-hotbar__shortcut';
    shortcut.textContent = String(slot.index + 1);
    const figure = document.createElement('span');
    figure.className = 'inventory-hotbar__figure';
    const quantity = document.createElement('span');
    quantity.className = 'inventory-hotbar__quantity';
    quantity.hidden = true;

    if (slot.itemType) {
      const icon = createItemIcon(slot.iconId ?? '', { className: 'inventory-hotbar__icon' });
      if (slot.tint) icon.style.color = slot.tint;
      figure.append(icon);
      quantity.hidden = false;
      quantity.textContent = String(slot.quantity);
      // 装着东西的格子拖得动：往另一格拖是排顺序，往背包里拖是收回。
      this.makeDraggable(cell, { kind: 'hotbar', slotIndex: slot.index });
    }

    cell.append(shortcut, figure, quantity);
    cell.setAttribute(
      'aria-label',
      slot.itemType
        ? `物品栏第 ${slot.index + 1} 格 ${slot.displayName ?? ''} ×${slot.quantity}`
          + (slot.active ? '，正拿在手上' : '')
        : `物品栏第 ${slot.index + 1} 格 空`,
    );
    return cell;
  }

  /**
   * 让一格拖得动。
   *
   * `dragend` 无条件清掉来源：拖到界面外面松手不会触发 `drop`，不清的话下一次
   * 拖拽会带着上一次的来源落地，搬错一摞货。
   */
  private makeDraggable(cell: HTMLElement, source: InventoryDragSource): void {
    cell.draggable = true;
    cell.dataset.commonUiReceiver = '';
    cell.addEventListener('dragstart', (event) => {
      this.dragSource = source;
      this.itemMenu.close();
      const transfer = (event as DragEvent).dataTransfer;
      if (transfer) transfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragend', () => { this.dragSource = undefined; });
  }

  /**
   * 让一片区域接得住。
   *
   * `dragover` 必须 `preventDefault`，否则浏览器根本不会派发 `drop`——这是 HTML
   * 拖放里最容易漏、漏了之后表现为「拖过去没反应」的一步。
   */
  private makeDropZone(zone: HTMLElement, resolve: () => InventoryDragTarget): void {
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
      this.dragHandler?.(source, resolve());
    });
  }
}

/** 「使用」那一条说什么，取决于这件东西按一下还是按住。 */
function useHint(stack: InventoryStackView): string {
  if (!stack.usable) return '这件东西没有用法';
  if (stack.useMode === 'hold') {
    return `关掉背包，按住使用键 ${stack.holdSeconds} 秒`;
  }
  return '关掉背包，按一下使用键';
}

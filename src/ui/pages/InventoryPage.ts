import { ModalWindow } from '../common/ModalWindow';
import { createItemIcon } from '../icons/ItemIconSprite';
import type { InventoryStackView, InventoryView } from '../../inventory/index';

/**
 * 背包界面。
 *
 * MVC 里的 View：只把 `InventoryView` 画出来。它不认识物品目录、不认识
 * Actor Component、也不发任何请求——拿不到数据就显示空态，拿到就重画。
 * 什么时候画、画哪一份，由 `InventoryController` 决定。
 */
export class InventoryPage extends ModalWindow {
  private readonly ledgerText: HTMLElement;
  private readonly slotGrid: HTMLElement;
  private readonly pooledSection: HTMLElement;
  private readonly pooledGrid: HTMLElement;
  private readonly emptyNotice: HTMLElement;
  private readonly tabBar: HTMLElement;
  private closeHintText = 'Esc 关闭';
  private readonly closeHint: HTMLElement;
  /** 当前页签。分类空掉时自动落回「全部」，不会停在一个打不开的页上。 */
  private activePageId: string = 'all';
  private view?: InventoryView;
  private holdHandler?: (itemType: string) => void;

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
    const slotSection = document.createElement('section');
    slotSection.className = 'inventory__section';
    this.slotGrid = document.createElement('ul');
    this.slotGrid.className = 'inventory__grid';
    this.slotGrid.setAttribute('role', 'list');
    slotSection.append(this.slotGrid);

    this.pooledSection = document.createElement('section');
    this.pooledSection.className = 'inventory__section';
    this.pooledSection.hidden = true;
    const pooledHeading = document.createElement('h3');
    pooledHeading.textContent = '不占格';
    const pooledNote = document.createElement('p');
    pooledNote.className = 'inventory__note';
    pooledNote.textContent = '弹药与基础工具各有上限，但不挤压随身格子。';
    this.pooledGrid = document.createElement('ul');
    this.pooledGrid.className = 'inventory__grid inventory__grid--pooled';
    this.pooledGrid.setAttribute('role', 'list');
    this.pooledSection.append(pooledHeading, pooledNote, this.pooledGrid);

    this.bodyElement.append(
      this.emptyNotice,
      this.ledgerText,
      this.tabBar,
      slotSection,
      this.pooledSection,
    );

    this.closeHint = document.createElement('p');
    this.closeHint.className = 'inventory__hint';
    this.closeHint.textContent = this.closeHintText;
    this.footerElement.append(this.closeHint);

    this.setInventory(undefined);
  }

  /** 由 Controller 解析出的开合按键，用来把关闭提示写成玩家实际按的那个键。 */
  public setCloseHint(controlLabel: string | undefined): void {
    this.closeHintText = controlLabel ? `Esc 或 ${controlLabel} 关闭` : 'Esc 关闭';
    this.closeHint.textContent = this.closeHintText;
  }

  /** 点一下某件物品会做什么：放上快捷栏并握在手上。由 Controller 接出去发意图。 */
  public onHold(handler: (itemType: string) => void): void {
    this.holdHandler = handler;
  }

  /** 画一份背包；传 undefined 表示还没有权威数据（没进房间或角色已销毁）。 */
  public setInventory(view: InventoryView | undefined): void {
    this.view = view;
    this.emptyNotice.hidden = view !== undefined;
    if (!view) {
      this.setLedger('');
      this.tabBar.replaceChildren();
      this.slotGrid.replaceChildren();
      this.pooledSection.hidden = true;
      this.pooledGrid.replaceChildren();
      return;
    }

    this.setLedger(this.describeLedger(view));
    // 上一次停留的分类可能已经空了（东西用完或存进了箱子）；落回全部而不是留白。
    if (!view.pages.some((page) => page.id === this.activePageId)) this.activePageId = 'all';
    this.renderTabs(view);
    this.renderPage(view);
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
    const cells = stacks.map((stack) => this.createStackCell(stack, view.heldItemType === stack.itemType));
    // 空格只在「全部」页补：分类页补空格会让人以为那个分类有独立容量。
    if (this.activePageId === 'all') {
      for (let index = 0; index < view.freeSlots; index += 1) cells.push(this.createEmptyCell());
    }
    this.slotGrid.replaceChildren(...cells);
    // 「不占货位」原来是一个独立分区。分类页签接管这件事之后，它会把弹药和工具
    // 画第二遍——同一堆货出现在两个地方，数量还同步变化，玩家没法理解那是一件东西。
    // 这条信息改由格子上的「不占格」标记承担，位置就在它自己那一格上。
    this.pooledSection.hidden = true;
    this.pooledGrid.replaceChildren();
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

  private createEmptyCell(): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory__cell inventory__cell--empty';
    cell.setAttribute('aria-label', '空格子');
    return cell;
  }

  private createStackCell(stack: InventoryStackView, held: boolean): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory__cell';
    // 不做拖拽：一次点击就是这个界面的全部交互，所以格子本身是按钮。
    // 拿不到手上的东西（弹药）保持成普通格子，点了没反应比点了没提示好。
    if (stack.holdable) {
      cell.classList.add('inventory__cell--actionable');
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.addEventListener('click', () => this.holdHandler?.(stack.itemType));
      cell.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.holdHandler?.(stack.itemType);
      });
    }
    cell.classList.toggle('is-held', held);
    cell.dataset.itemType = stack.itemType;
    cell.dataset.category = stack.category;
    if (stack.contraband) cell.dataset.contraband = 'true';
    cell.setAttribute('title', `${stack.displayName}　${stack.summary}`);
    cell.setAttribute(
      'aria-label',
      `${stack.categoryLabel} ${stack.displayName}，${stack.quantity} 个，上限 ${stack.stackLimit}`
      + (stack.holdable ? (held ? '，正拿在手上' : '，点击拿到手上') : ''),
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
}

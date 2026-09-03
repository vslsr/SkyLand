/** 菜单上那三条。语义由 `InventoryController` 兑现，这里只负责说出意图。 */
export type InventoryItemAction = 'use' | 'equip' | 'drop';

export interface InventoryItemMenuEntry {
  readonly action: InventoryItemAction;
  readonly label: string;
  /** 说清这一条到底会发生什么；菜单太小，写不下就挂在 title 上。 */
  readonly hint: string;
  /** 现在做不了（比如已经在物品栏上），仍然列出来但点不动。 */
  readonly disabled?: boolean;
}

/** 菜单贴着格子放，四周留这么多空隙，别压在格线上。 */
const ANCHOR_GAP = 6;
/** 离窗口边缘至少留这么多，避免菜单顶着边框出去。 */
const EDGE_MARGIN = 8;

/**
 * 背包里点一格弹出来的浮动菜单。
 *
 * 位置贴着被点的那一格，不是屏幕中央：菜单说的是「这一格」的事，飘到别处玩家就得
 * 自己回想刚才点的是哪一个。
 *
 * **挂在页面根节点上，不是格子里**。格子在 `.modal-window__body` 里，那一层
 * `overflow: auto`，菜单挂进去会被裁掉半截；挂到页面外面（比如 body）又会掉出
 * `CommonUIManager` 认的那棵子树——栈顶页面之外的指针事件会被它拦下，菜单于是点不
 * 动。页面根节点是唯一同时满足两边的位置。
 *
 * 坐标因此是相对页面根节点算的：`.modal-window` 自己带 `transform`，是定位包含块，
 * 用 `position: fixed` 加视口坐标反而会错位。
 */
export class InventoryItemMenu {
  public readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly titleElement: HTMLElement;
  private selectHandler?: (action: InventoryItemAction, itemType: string) => void;
  private openItemType?: string;
  private disposeDismiss?: () => void;

  public constructor(private readonly host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'inventory-menu';
    this.element.hidden = true;
    this.element.setAttribute('role', 'menu');

    this.titleElement = document.createElement('p');
    this.titleElement.className = 'inventory-menu__title';

    this.list = document.createElement('div');
    this.list.className = 'inventory-menu__list';

    this.element.append(this.titleElement, this.list);
    this.host.append(this.element);
  }

  public get isOpen(): boolean {
    return this.openItemType !== undefined;
  }

  /** 当前挂着菜单的那一格是哪种物品；没开时是 undefined。 */
  public get itemType(): string | undefined {
    return this.openItemType;
  }

  public onSelect(handler: (action: InventoryItemAction, itemType: string) => void): void {
    this.selectHandler = handler;
  }

  public open(
    anchor: HTMLElement,
    itemType: string,
    title: string,
    entries: readonly InventoryItemMenuEntry[],
  ): void {
    this.openItemType = itemType;
    this.titleElement.textContent = title;
    this.list.replaceChildren(...entries.map((entry) => this.createEntry(entry, itemType)));
    this.element.hidden = false;
    this.position(anchor);
    this.listenForDismiss();
  }

  public close(): void {
    if (!this.isOpen) return;
    this.openItemType = undefined;
    this.element.hidden = true;
    this.list.replaceChildren();
    this.disposeDismiss?.();
    this.disposeDismiss = undefined;
  }

  public dispose(): void {
    this.close();
    this.element.remove();
  }

  private createEntry(entry: InventoryItemMenuEntry, itemType: string): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-menu__entry';
    button.setAttribute('role', 'menuitem');
    button.dataset.action = entry.action;
    button.textContent = entry.label;
    button.setAttribute('title', entry.hint);
    button.setAttribute('aria-label', `${entry.label}：${entry.hint}`);
    if (entry.disabled) {
      button.disabled = true;
      button.classList.add('is-disabled');
      return button;
    }
    button.addEventListener('click', () => {
      // 先收菜单再兑现：动作会改背包，改完那一格会被重画，菜单挂着的锚点就没了。
      this.close();
      this.selectHandler?.(entry.action, itemType);
    });
    return button;
  }

  /**
   * 贴着格子摆：默认在右边，右边放不下就翻到左边；下边超出就往上顶。
   *
   * 拿不到 `getBoundingClientRect` 时（没有排版的测试环境）保持默认位置：菜单的
   * 内容与开合是可测的，摆在哪一像素不是。
   */
  private position(anchor: HTMLElement): void {
    const anchorRect = anchor.getBoundingClientRect?.();
    const hostRect = this.host.getBoundingClientRect?.();
    const menuRect = this.element.getBoundingClientRect?.();
    if (!anchorRect || !hostRect || !menuRect) return;

    const rightOfAnchor = anchorRect.right - hostRect.left + ANCHOR_GAP;
    const leftOfAnchor = anchorRect.left - hostRect.left - menuRect.width - ANCHOR_GAP;
    const fitsRight = rightOfAnchor + menuRect.width <= hostRect.width - EDGE_MARGIN;
    const left = fitsRight ? rightOfAnchor : Math.max(EDGE_MARGIN, leftOfAnchor);
    const top = Math.max(
      EDGE_MARGIN,
      Math.min(
        anchorRect.top - hostRect.top,
        hostRect.height - menuRect.height - EDGE_MARGIN,
      ),
    );
    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
  }

  /**
   * 点别处就收起来。
   *
   * 捕获阶段挂在 document 上，比 `CommonUIManager` 在 `#app-shell` 上的那道守卫更早
   * 拿到事件——挡在窗口外面的那次点击本来会被它拦掉，菜单就永远收不起来了。听
   * `pointerdown` 而不是 `click`：点另一格时先收旧的（pointerdown）、再开新的
   * （click），两件事不会打架。
   *
   * 滚动与改窗口大小一并收起：菜单是按当时的格子位置摆的，格子一动它就指错了。
   */
  private listenForDismiss(): void {
    this.disposeDismiss?.();
    const onPointerDown = (event: Event): void => {
      // 用 `contains` 而不是 `instanceof Node`：`Node` 是 DOM 独有的全局，
      // 在没有它的测试环境里那句会直接抛。非节点的 target 一律当作点在外面。
      const target = event.target as Node | null;
      if (target && this.element.contains(target)) return;
      this.close();
    };
    const onReflow = (): void => this.close();
    const options = { capture: true } as const;
    document.addEventListener('pointerdown', onPointerDown, options);
    // 背包正文自己滚动，滚动事件不冒泡到 window，所以两处都要听。
    this.host.addEventListener('scroll', onReflow, options);
    window.addEventListener('resize', onReflow);
    this.disposeDismiss = () => {
      document.removeEventListener('pointerdown', onPointerDown, options);
      this.host.removeEventListener('scroll', onReflow, options);
      window.removeEventListener('resize', onReflow);
    };
  }
}

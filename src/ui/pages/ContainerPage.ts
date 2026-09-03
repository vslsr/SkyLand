import { ModalWindow } from '../common/ModalWindow';
import { createItemIcon } from '../icons/ItemIconSprite';
import type { ContainerView, ContainerRowView } from '../../inventory/index';

/**
 * 容器界面。
 *
 * View：只把 `ContainerView` 画出来，把「存 / 取 / 全部存入」交出去。它不认识物品
 * 目录、不认识 Component、也不发请求——搬没搬动由服务端说了算。
 *
 * **不做双面板拖拽。** 拖拽是背包系统里最费工、手柄和触屏最难做的一件事，而它换
 * 来的东西在这套设计里并不存在（格子顺序不是信息）。一行两个按钮就够，而且天然
 * 支持触屏。
 *
 * 同一个箱子可以被几个人同时翻：别人存进去的东西会随下一帧快照直接出现在这里，
 * 界面不需要为此做任何事——它本来就只画收到的状态。
 */
export class ContainerPage extends ModalWindow {
  private readonly capacityText: HTMLElement;
  private readonly viewerText: HTMLElement;
  private readonly rowList: HTMLElement;
  private readonly emptyNotice: HTMLElement;
  private readonly storeAllButton: HTMLButtonElement;
  private transferHandler?: (
    itemType: string,
    quantity: number,
    direction: 'store' | 'withdraw',
  ) => void;
  private storeAllHandler?: () => void;

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
    summary.append(this.capacityText, this.viewerText);

    this.storeAllButton = document.createElement('button');
    this.storeAllButton.type = 'button';
    this.storeAllButton.className = 'container__store-all';
    this.storeAllButton.textContent = '全部存入';
    this.storeAllButton.addEventListener('click', () => this.storeAllHandler?.());

    this.emptyNotice = document.createElement('p');
    this.emptyNotice.className = 'container__empty-notice';
    this.emptyNotice.textContent = '箱子和背包都是空的。';
    this.emptyNotice.hidden = true;

    this.rowList = document.createElement('ul');
    this.rowList.className = 'container__rows';
    this.rowList.setAttribute('role', 'list');

    this.bodyElement.append(summary, this.storeAllButton, this.emptyNotice, this.rowList);
    this.setContainer(undefined);
  }

  /** Esc 与 X 走同一条路：都只是「请求关闭」，真正的关闭由服务端确认。 */
  public handleGlobalInputEvent(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape') return false;
    this.requestClose();
    return true;
  }

  public onTransfer(
    handler: (itemType: string, quantity: number, direction: 'store' | 'withdraw') => void,
  ): void {
    this.transferHandler = handler;
  }

  public onStoreAll(handler: () => void): void {
    this.storeAllHandler = handler;
  }

  /** 画一份容器；传 undefined 表示还没有权威数据。 */
  public setContainer(view: ContainerView | undefined): void {
    if (!view) {
      this.titleElement.textContent = '储物箱';
      this.capacityText.textContent = '货位 —';
      this.viewerText.textContent = '';
      this.rowList.replaceChildren();
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
    this.emptyNotice.hidden = view.rows.length > 0;
    this.storeAllButton.disabled = !view.rows.some((row) => row.carried > 0);
    this.rowList.replaceChildren(...view.rows.map((row) => this.createRow(row)));
  }

  private createRow(row: ContainerRowView): HTMLElement {
    const item = document.createElement('li');
    item.className = 'container__row';
    item.dataset.itemType = row.itemType;

    const swatch = document.createElement('span');
    swatch.className = 'container__swatch';
    swatch.setAttribute('style', `--item-tint:${row.tint}`);
    swatch.append(createItemIcon(row.iconId, { className: 'container__icon' }));

    const name = document.createElement('span');
    name.className = 'container__name';
    name.textContent = row.displayName;

    const counts = document.createElement('span');
    counts.className = 'container__counts';
    counts.textContent = `身上 ${row.carried}　箱内 ${row.stored}`;

    item.append(swatch, name, counts);
    // 存和取各一个按钮，搬的是这一行的全部数量：casual 向的取舍——数量选择器
    // 是拖拽之外第二费工的交互，而「全存 / 全取」覆盖了绝大多数实际操作。
    item.append(
      this.createAction('存', row.carried > 0, () => {
        this.transferHandler?.(row.itemType, row.carried, 'store');
      }),
      this.createAction('取', row.stored > 0, () => {
        this.transferHandler?.(row.itemType, row.stored, 'withdraw');
      }),
    );
    return item;
  }

  private createAction(label: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'container__action';
    button.textContent = label;
    button.disabled = !enabled;
    button.addEventListener('click', onClick);
    return button;
  }
}

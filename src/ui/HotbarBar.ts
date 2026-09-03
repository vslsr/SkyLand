import { createItemIcon } from './icons/ItemIconSprite';
import type { HeldItemProgress } from '../controllers/HotbarController';
import type { HotbarSlotView } from '../inventory/index';

/**
 * 屏幕底部那一排手持格。
 *
 * View：只把 `HotbarSlotView[]` 画出来，点一下就把序号交出去。它不认识物品目录、
 * 不认识 Component、也不发任何请求——切换成不成由服务端说了算，这里画的是收到的
 * 快照，不是本地预测。
 *
 * 点击/触摸是切换手持的第一入口（数字键和手柄肩键是另外两条），所以每一格都是
 * 一个真正的按钮：手柄能聚焦、读屏能念、触屏点得到。
 *
 * **一格只有一种状态可看**：`data-state` 说这一格是空的、有货、还是货用光了，
 * `data-held` 说哪一格拿在手上。之前是三个 `is-*` class 加两个 dataset 混着写，
 * 同一件事有几处写法，改一处就漏一处；现在全部收进这两个属性里。
 */

/** 一格现在是什么样子。配置着但货用光了要单独算一种，它和空格不是一回事。 */
type HotbarSlotState = 'empty' | 'ready' | 'depleted';

interface HotbarSlot {
  readonly button: HTMLButtonElement;
  readonly shortcut: HTMLElement;
  readonly figure: HTMLElement;
  readonly quantity: HTMLElement;
}

function slotState(slot: HotbarSlotView): HotbarSlotState {
  if (!slot.itemType) return 'empty';
  return slot.quantity === 0 ? 'depleted' : 'ready';
}

export class HotbarBar {
  public readonly element: HTMLElement;
  private readonly track: HTMLElement;
  /** 手持那一格头顶的一块牌子：平时写物品名，按住时写这次按住在做什么。 */
  private readonly plate: HTMLElement;
  private readonly slots: HotbarSlot[] = [];
  private selectHandler?: (index: number) => void;
  private rendered: string | undefined;
  /** 拿在手上的那一格。进度圈画在它身上，不用每帧翻一遍 DOM 去找。 */
  private heldSlot: HotbarSlot | undefined;
  private heldName = '';
  private progressLabel: string | undefined;

  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hotbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', '手持物品栏');

    this.plate = document.createElement('p');
    this.plate.className = 'hotbar__plate';
    // 只是把已经看得见的事写成字，读屏从按钮的 aria-label 上念，不必念两遍。
    this.plate.setAttribute('aria-hidden', 'true');
    this.plate.hidden = true;

    this.track = document.createElement('div');
    this.track.className = 'hotbar__track';

    this.element.append(this.plate, this.track);
  }

  public onSelect(handler: (index: number) => void): void {
    this.selectHandler = handler;
  }

  /**
   * 按快照重画。
   *
   * 格数变了才重建 DOM，其余情况只改内容：每帧重建会打断触摸按压态，也会让
   * 手柄焦点掉回第一格。
   *
   * 签名把画出来的每一样都算进去（图标、颜色、名字都在内）。只算 itemType 和
   * 数量会漏掉换皮：同一种物品换了图标，签名没变，画面就停在旧图上。
   */
  public setSlots(slots: readonly HotbarSlotView[]): void {
    const signature = slots.map((slot) => [
      slot.itemType ?? '',
      slot.displayName ?? '',
      slot.iconId ?? '',
      slot.tint ?? '',
      slot.quantity,
      slot.active ? 1 : 0,
    ].join(':')).join('|');
    if (this.rendered === signature) return;
    this.rendered = signature;

    if (this.slots.length !== slots.length) this.rebuild(slots.length);
    this.heldSlot = undefined;
    this.heldName = '';
    // 新快照到手，上一次按住的进度就作废了：换手之后那半圈说的是别的东西。
    // 控制器每帧都会再推一次，按住还没松就会立刻重新画上。
    this.progressLabel = undefined;
    slots.forEach((slot, index) => this.paint(this.slots[index], slot));
    this.element.hidden = slots.length === 0;
    this.syncPlate();
  }

  /**
   * 画那一圈进度：使用蓄力与交互键长按共用同一个圈，靠 `kind` 换颜色。
   *
   * 圈画在当前手持那一格上，因为两种按住说的都是「手上这件东西」。手上空着
   * （格子配着但货用光了）时没有那一格，圈无处可画，牌子也不写。
   */
  public setProgress(progress: HeldItemProgress | undefined): void {
    const held = this.heldSlot;
    if (!progress || !held) {
      this.clearProgress();
      return;
    }
    this.progressLabel = progress.label;
    held.button.style.setProperty('--hotbar-progress', `${Math.round(progress.ratio * 100)}%`);
    held.button.dataset.progress = progress.kind;
    this.syncPlate();
  }

  public dispose(): void {
    this.element.remove();
  }

  private clearProgress(): void {
    this.progressLabel = undefined;
    for (const slot of this.slots) {
      slot.button.style.removeProperty('--hotbar-progress');
      delete slot.button.dataset.progress;
    }
    this.syncPlate();
  }

  /** 牌子只说一句话：按住的时候说这次按住，其余时候说手上拿的是什么。 */
  private syncPlate(): void {
    const text = this.progressLabel ?? this.heldName;
    this.plate.textContent = text;
    this.plate.hidden = text.length === 0;
    this.plate.dataset.progress = this.progressLabel ? 'true' : '';
  }

  private rebuild(count: number): void {
    for (const slot of this.slots) slot.button.remove();
    this.slots.length = 0;
    this.heldSlot = undefined;
    for (let index = 0; index < count; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hotbar__slot';
      // 鼠标点完不要把焦点留在格子上：焦点圈和「拿在手上」是两种意思，一起亮着
      // 就有两格看起来都是选中的。按住不放的那一下就吃掉默认的取焦，键盘 Tab
      // 和手柄导航不走这条路径，焦点圈照常给它们用。
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => this.selectHandler?.(index));

      const shortcut = document.createElement('span');
      shortcut.className = 'hotbar__shortcut';
      shortcut.textContent = String(index + 1);

      // 图标外面套一层：货用光时要把「图标 + 数量」一起画淡，套一层就不用在
      // 每个子节点上各写一遍，也给了 replaceChildren 一个固定的落点。
      const figure = document.createElement('span');
      figure.className = 'hotbar__figure';

      const quantity = document.createElement('span');
      quantity.className = 'hotbar__quantity';
      quantity.hidden = true;

      button.append(shortcut, figure, quantity);
      this.track.append(button);
      this.slots.push({ button, shortcut, figure, quantity });
    }
  }

  private paint(slot: HotbarSlot, view: HotbarSlotView): void {
    const state = slotState(view);
    const { button } = slot;
    button.dataset.state = state;
    button.dataset.held = String(view.active);
    button.setAttribute('aria-pressed', String(view.active));
    button.style.removeProperty('--hotbar-progress');
    delete button.dataset.progress;
    slot.shortcut.textContent = String(view.index + 1);

    if (view.active && state === 'ready') {
      this.heldSlot = slot;
      this.heldName = view.displayName ?? '';
    }

    if (!view.itemType) {
      slot.figure.replaceChildren();
      slot.quantity.hidden = true;
      button.setAttribute('aria-label', `第 ${view.index + 1} 格 空`);
      return;
    }

    const icon = createItemIcon(view.iconId ?? '', { className: 'hotbar__icon' });
    if (view.tint) icon.style.color = view.tint;
    slot.figure.replaceChildren(icon);

    slot.quantity.hidden = view.quantity <= 0;
    slot.quantity.textContent = String(view.quantity);

    button.setAttribute(
      'aria-label',
      `第 ${view.index + 1} 格 ${view.displayName ?? ''}`
      + (state === 'depleted' ? ' 已用完' : ` ×${view.quantity}`)
      + (view.active ? '，正拿在手上' : ''),
    );
  }
}

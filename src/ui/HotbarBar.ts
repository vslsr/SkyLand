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
 */
export class HotbarBar {
  public readonly element: HTMLElement;
  private readonly slotElements: HTMLButtonElement[] = [];
  private readonly progressLabel: HTMLElement;
  private selectHandler?: (index: number) => void;
  private rendered: string | undefined;

  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hotbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', '手持物品栏');
    this.progressLabel = document.createElement('p');
    this.progressLabel.className = 'hotbar__progress-label';
    this.progressLabel.hidden = true;
    this.element.append(this.progressLabel);
  }

  public onSelect(handler: (index: number) => void): void {
    this.selectHandler = handler;
  }

  /**
   * 按快照重画。
   *
   * 格数变了才重建 DOM，其余情况只改内容：每帧重建会打断触摸按压态，也会让
   * 手柄焦点掉回第一格。
   */
  public setSlots(slots: readonly HotbarSlotView[]): void {
    const signature = slots.map((slot) => (
      `${slot.itemType ?? ''}:${slot.quantity}:${slot.active ? 1 : 0}`
    )).join('|');
    if (this.rendered === signature) return;
    this.rendered = signature;
    if (this.slotElements.length !== slots.length) this.rebuild(slots.length);
    slots.forEach((slot, index) => this.paint(this.slotElements[index], slot));
    this.element.hidden = slots.length === 0;
  }

  /**
   * 画那一圈进度：使用蓄力与交互键长按共用同一个圈，靠 `kind` 换颜色。
   *
   * 圈画在当前手持那一格上，因为两种按住说的都是「手上这件东西」。
   */
  public setProgress(progress: HeldItemProgress | undefined): void {
    for (const element of this.slotElements) {
      element.style.removeProperty('--hotbar-progress');
      element.dataset.progress = '';
    }
    this.progressLabel.hidden = !progress;
    if (!progress) return;
    this.progressLabel.textContent = progress.label;
    const active = this.slotElements.find((element) => element.dataset.active === 'true');
    if (!active) return;
    active.style.setProperty('--hotbar-progress', `${Math.round(progress.ratio * 100)}%`);
    active.dataset.progress = progress.kind;
  }

  public dispose(): void {
    this.element.remove();
  }

  private rebuild(count: number): void {
    for (const element of this.slotElements) element.remove();
    this.slotElements.length = 0;
    for (let index = 0; index < count; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hotbar__slot';
      // 数字键是第二入口，标在格子上，玩家不用去翻按键说明。
      button.dataset.shortcut = String(index + 1);
      button.addEventListener('click', () => this.selectHandler?.(index));
      this.slotElements.push(button);
      this.element.append(button);
    }
  }

  private paint(button: HTMLButtonElement, slot: HotbarSlotView): void {
    button.replaceChildren();
    button.dataset.active = String(slot.active);
    button.classList.toggle('is-active', slot.active);
    // 配置还在但货用光了：格子留着，画成灰的，补货回来自动亮起。
    const depleted = Boolean(slot.itemType) && slot.quantity === 0;
    button.classList.toggle('is-depleted', depleted);
    button.classList.toggle('is-empty', !slot.itemType);

    const shortcut = document.createElement('span');
    shortcut.className = 'hotbar__shortcut';
    shortcut.textContent = String(slot.index + 1);
    button.append(shortcut);

    if (!slot.itemType) {
      button.setAttribute('aria-label', `第 ${slot.index + 1} 格 空`);
      return;
    }
    const icon = createItemIcon(slot.iconId ?? '', { className: 'hotbar__icon' });
    if (slot.tint) icon.style.color = slot.tint;
    button.append(icon);

    if (slot.quantity > 0) {
      const quantity = document.createElement('span');
      quantity.className = 'hotbar__quantity';
      quantity.textContent = String(slot.quantity);
      button.append(quantity);
    }
    button.setAttribute(
      'aria-label',
      `第 ${slot.index + 1} 格 ${slot.displayName ?? ''}${depleted ? ' 已用完' : ` ×${slot.quantity}`}`,
    );
    button.setAttribute('aria-pressed', String(slot.active));
  }
}

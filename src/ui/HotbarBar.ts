import { createItemIcon } from './icons/ItemIconSprite';
import type { HeldItemProgress } from '../controllers/HotbarController';
import type { HotbarSlotView } from '../inventory/index';

/**
 * 屏幕底部那条物品栏。
 *
 * View：只把 `HotbarSlotView[]` 画出来，点一下就把序号交出去。它不认识物品目录、
 * 不认识 Component、也不发任何请求——切换成不成由服务端说了算，这里画的是收到的
 * 快照，不是本地预测。
 *
 * 点击/触摸是切换手持的第一入口（数字键 1-9 和手柄肩键是另外两条），所以每一格
 * 都是一个真正的按钮：手柄能聚焦、读屏能念、触屏点得到。
 *
 * **一格只有一种状态可看**：`data-state` 说这一格是空的还是有货，`data-held` 说
 * 哪一格拿在手上。物品栏现在自己持有那一摞，用光的格子直接空出来，所以不再有
 * 「配置还在、货没了」这种中间态。
 */

/** 一格现在是什么样子。 */
type HotbarSlotState = 'empty' | 'ready';

interface HotbarSlot {
  readonly button: HTMLButtonElement;
  readonly shortcut: HTMLElement;
  readonly figure: HTMLElement;
  readonly quantity: HTMLElement;
  /** 还剩几发弹药。没装弹药的格子上整个收起来，和背包里那个小框同一条规矩。 */
  readonly ammo: HTMLElement;
  /** 长按时盖在这一格上的那圈圆形倒计时。平时是收起来的。 */
  readonly dial: HTMLElement;
  /** 这一格现在装着什么。冷却圈按物品种类找格子，所以要记住它。 */
  itemType?: string;
}

/**
 * 冷却里的那一件（设计稿「CD效果 · 轻型工具CD」）。
 *
 * 记的是**物品种类**而不是格号：冷却记在种类上（服务端那边也是，见
 * `itemCooldownGroup`），冷却途中把弓拖到另一格并不会让它立刻又能射。
 */
export interface HotbarCooldownState {
  readonly itemType: string;
  /** 还剩多少没走完，[0, 1]。1 是刚进冷却，0 是好了。 */
  readonly remainingRatio: number;
}

function slotState(slot: HotbarSlotView): HotbarSlotState {
  return slot.itemType && slot.quantity > 0 ? 'ready' : 'empty';
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
  /** 这一帧要画的两种圈。进度圈盖过冷却圈：手上正在做的事比「刚才做完了」重要。 */
  private progress: HeldItemProgress | undefined;
  private cooldown: HotbarCooldownState | undefined;

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
      // 弹药也算进签名：打掉一发之后这一格看得见地变了，不重画就停在旧发数上。
      slot.ammo ? `${slot.ammo.itemType}x${slot.ammo.quantity}` : '',
    ].join(':')).join('|');
    if (this.rendered === signature) return;
    this.rendered = signature;

    if (this.slots.length !== slots.length) this.rebuild(slots.length);
    this.heldSlot = undefined;
    this.heldName = '';
    // 新快照到手，上一次按住的进度就作废了：换手之后那半圈说的是别的东西。
    // 控制器每帧都会再推一次，按住还没松就会立刻重新画上。
    this.progress = undefined;
    slots.forEach((slot, index) => this.paint(this.slots[index], slot));
    this.element.hidden = slots.length === 0;
    // 冷却不跟着重画清掉：它是一段自己在走的时间，和这一帧的格子内容无关。
    this.refreshDials();
  }

  /**
   * 画那圈圆形倒计时：长按使用一件物品时它盖在那一格上，`data-progress` 记的是
   * 这次用法（吃 / 敲 / 投）。
   *
   * 圈盖在当前手持那一格上，是一个真正的环——不是把方格底色填掉一角。倒计时是
   * 「还剩多少时间」，环的周长天然是一条闭合的时间轴，扫到起点就是结束；方块被
   * 填掉一角只说得出「填了一些」。
   *
   * 只画属于物品栏的那一次（`onHotbar`）。叼着的蘑菇、从背包里点出来的用法都没有
   * 格子，它们的圈在准星下方那块牌子上，这里不重复。
   */
  public setProgress(progress: HeldItemProgress | undefined): void {
    this.progress = progress;
    this.refreshDials();
  }

  /**
   * 画冷却圈（设计稿「CD效果 · 轻型工具CD」）。
   *
   * 和长按那圈是**同一个环**，只是反着走：长按是攒满，冷却是退空。用同一个环
   * 而不是另画一个记号，是因为玩家问的是同一个问题——「这一格现在能不能按」。
   *
   * 冷却时长写在物品目录的 `use.cooldownSeconds` 上，客户端跑的是和服务端同一份
   * 数据、同一个起点（松手 / 激活那一刻），所以这圈退空那一刻就是那边冷却好的
   * 那一刻——和长按那圈「两端跑同一个 holdRatio」是同一条规矩。
   */
  public setCooldown(cooldown: HotbarCooldownState | undefined): void {
    this.cooldown = cooldown;
    this.refreshDials();
  }

  /** 把两种圈画到各自那一格上。进度圈在后，所以它盖过冷却圈。 */
  private refreshDials(): void {
    for (const slot of this.slots) {
      slot.dial.hidden = true;
      slot.dial.style.removeProperty('--hotbar-progress');
      delete slot.dial.dataset.charged;
      delete slot.button.dataset.progress;
    }
    this.progressLabel = undefined;

    const cooling = this.cooldown;
    if (cooling && cooling.remainingRatio > 0) {
      for (const slot of this.slots) {
        if (slot.itemType !== cooling.itemType) continue;
        slot.dial.hidden = false;
        slot.dial.style.setProperty('--hotbar-progress', `${Math.round(cooling.remainingRatio * 100)}%`);
        slot.button.dataset.progress = 'cooldown';
      }
    }

    const progress = this.progress;
    const held = this.heldSlot;
    if (progress && progress.onHotbar && held) {
      this.progressLabel = progress.label;
      held.dial.hidden = false;
      held.dial.style.setProperty('--hotbar-progress', `${Math.round(progress.ratio * 100)}%`);
      held.button.dataset.progress = progress.action;
      // 蓄力拉满之后圈停在满圈上等松手，所以要有一个「已经满了」的记号——
      // 否则玩家只能靠盯着那一圈还在不在猜这一下已经到顶。
      held.dial.dataset.charged = String(progress.mode === 'charge' && progress.ratio >= 1);
    }
    this.syncPlate();
  }

  public dispose(): void {
    this.element.remove();
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

      const ammo = document.createElement('span');
      ammo.className = 'hotbar__ammo';
      ammo.hidden = true;

      // 圆形倒计时是一层独立的盖片，不是格子的背景：它要盖住图标、要能单独收起，
      // 也不该在换手重画时跟着格子内容一起被清掉。
      const dial = document.createElement('span');
      dial.className = 'hotbar__dial';
      dial.hidden = true;
      dial.setAttribute('aria-hidden', 'true');

      button.append(shortcut, figure, quantity, ammo, dial);
      this.track.append(button);
      this.slots.push({ button, shortcut, figure, quantity, ammo, dial });
    }
  }

  private paint(slot: HotbarSlot, view: HotbarSlotView): void {
    const state = slotState(view);
    const { button } = slot;
    button.dataset.state = state;
    button.dataset.held = String(view.active);
    button.setAttribute('aria-pressed', String(view.active));
    slot.itemType = view.itemType ?? undefined;
    slot.shortcut.textContent = String(view.index + 1);
    slot.ammo.hidden = view.ammo === undefined;
    slot.ammo.textContent = view.ammo ? String(view.ammo.quantity) : '';

    if (view.active && state === 'ready') {
      this.heldSlot = slot;
      this.heldName = view.displayName ?? '';
    }

    if (state === 'empty') {
      slot.figure.replaceChildren();
      slot.quantity.hidden = true;
      slot.ammo.hidden = true;
      button.setAttribute('aria-label', `第 ${view.index + 1} 格 空`);
      return;
    }

    const icon = createItemIcon(view.iconId ?? '', { className: 'hotbar__icon' });
    if (view.tint) icon.style.color = view.tint;
    slot.figure.replaceChildren(icon);

    slot.quantity.hidden = false;
    slot.quantity.textContent = String(view.quantity);

    button.setAttribute(
      'aria-label',
      `第 ${view.index + 1} 格 ${view.displayName ?? ''} ×${view.quantity}`
      + (view.ammo ? `，装着 ${view.ammo.quantity} 发${view.ammo.displayName}` : '')
      + (view.active ? '，正拿在手上' : ''),
    );
  }
}

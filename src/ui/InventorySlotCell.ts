import { createItemIcon } from './icons/ItemIconSprite';
import type { AmmoLoadView, HotbarSlotView, InventoryStackView } from '../inventory/index';

/**
 * 背包和物品栏共用的那一格。
 *
 * 界面上它们是上下两片区域，实质是**同一种东西的两个去处**：物品栏是一条特殊的
 * 背包。所以格子只有一套——同一份 DOM、同一套点击与拖拽、同一个菜单入口。两边
 * 各写一遍的话，「点一下弹菜单」这种事迟早只在其中一边成立，而玩家看到的是两个
 * 长得一样却行为不同的方格。
 *
 * 差别只剩尺寸和角标：物品栏那一条要塞进页脚，所以画成小方格、左上角带数字键
 * 序号、拿在手上的那一格描粗；这些由 `variant` 决定，不是另一套实现。
 */

/** 这一格指的是哪本账上的哪一格。菜单和拖拽说的都是它。 */
export type InventorySlotRef =
  | { readonly kind: 'backpack'; readonly itemType: string }
  | { readonly kind: 'hotbar'; readonly slotIndex: number };

/** 画一格要知道的全部。两本账各自把自己的视图摊成这一份。 */
export interface InventorySlotView {
  readonly ref: InventorySlotRef;
  /** 空格时是 undefined，这一格画成虚线方框。 */
  readonly itemType?: string;
  readonly displayName?: string;
  readonly summary?: string;
  readonly iconId?: string;
  readonly tint?: string;
  readonly quantity: number;
  readonly stackLimit: number;
  readonly categoryLabel?: string;
  readonly category?: string;
  readonly contraband?: boolean;
  readonly slotCost?: number;
  readonly coinValue?: number;
  /** 已经堆到上限，同类再拾取只能另开一格。 */
  readonly full?: boolean;
  /** 数字键序号（从 1 起）；背包格没有。 */
  readonly shortcut?: number;
  /** 正拿在手上；物品栏才有。 */
  readonly active?: boolean;
  /** 能不能拿在手上。不能的话这一格拖不动，也不弹菜单。 */
  readonly holdable: boolean;
  /** 这件东西吃哪几种弹药、装几发；不吃弹药时是 undefined。 */
  readonly ammoSlot?: { readonly accepts: readonly string[]; readonly capacity: number };
  /** 现在装着什么弹药；没装时是 undefined，那时**不画**弹药小框。 */
  readonly ammo?: AmmoLoadView;
}

export interface InventorySlotCellHandlers {
  /** 点一下有货的那一格：弹出操作菜单。 */
  readonly openMenu?: (cell: HTMLElement, slot: InventorySlotView) => void;
  readonly beginDrag?: (slot: InventorySlotView) => void;
  readonly endDrag?: () => void;
  /** 拖到这一格上松手。物品栏那一条的每一格都接得住，背包整片是一个落点。 */
  readonly dropOn?: (slot: InventorySlotView) => void;
  /** 现在有没有东西正被拖着；没有就不接。 */
  readonly isDragging?: () => boolean;
}

/** 背包里的一摞摊成一格。 */
export function backpackSlotView(stack: InventoryStackView): InventorySlotView {
  return {
    ref: { kind: 'backpack', itemType: stack.itemType },
    itemType: stack.itemType,
    displayName: stack.displayName,
    summary: stack.summary,
    iconId: stack.iconId,
    tint: stack.tint,
    quantity: stack.quantity,
    stackLimit: stack.stackLimit,
    categoryLabel: stack.categoryLabel,
    category: stack.category,
    contraband: stack.contraband,
    slotCost: stack.slotCost,
    coinValue: stack.coinValue,
    full: stack.full,
    holdable: stack.holdable,
    ammoSlot: stack.ammoSlot,
    ammo: stack.ammo,
  };
}

/** 物品栏的一格摊成一格。空格也要画：那是「还能装几样」的形状。 */
export function hotbarSlotView(slot: HotbarSlotView): InventorySlotView {
  return {
    ref: { kind: 'hotbar', slotIndex: slot.index },
    itemType: slot.itemType,
    displayName: slot.displayName,
    summary: slot.summary,
    iconId: slot.iconId,
    tint: slot.tint,
    quantity: slot.quantity,
    stackLimit: slot.stackLimit,
    shortcut: slot.index + 1,
    active: slot.active,
    full: slot.stackLimit > 0 && slot.quantity >= slot.stackLimit,
    holdable: true,
    ammoSlot: slot.ammoSlot,
    ammo: slot.ammo,
  };
}

function describe(slot: InventorySlotView): string {
  if (!slot.itemType) {
    return slot.shortcut === undefined ? '空格子' : `物品栏第 ${slot.shortcut} 格 空`;
  }
  const where = slot.shortcut === undefined ? '' : `物品栏第 ${slot.shortcut} 格 `;
  const category = slot.categoryLabel ? `${slot.categoryLabel} ` : '';
  const held = slot.active ? '，正拿在手上' : '';
  // 装着什么念出来：弹药小框是个视觉记号，读屏的人只有这一句能知道弓里还有几发。
  const ammo = slot.ammo
    ? `，装着 ${slot.ammo.quantity} / ${slot.ammo.capacity} ${slot.ammo.displayName}`
    : '';
  return `${where}${category}${slot.displayName ?? ''}，${slot.quantity} 个，上限 ${slot.stackLimit}${held}${ammo}`;
}

/**
 * 造一格。
 *
 * `<li role="button">` 而不是真的 `<button>`：格子里要放图标、名字、数量和角标，
 * 按钮的默认排版会把它们挤成一行。`data-common-ui-receiver` 是 `CommonUIManager`
 * 认「这次点击是给 DOM 的」的显式入口——它只按标签名认按钮，认不出这一格就会在
 * 捕获阶段把点击拦掉，表现是点了毫无反应。
 */
export function createInventorySlotCell(
  slot: InventorySlotView,
  handlers: InventorySlotCellHandlers = {},
): HTMLElement {
  const cell = document.createElement('li');
  const hotbar = slot.ref.kind === 'hotbar';
  cell.className = hotbar ? 'inventory__cell inventory__cell--hotbar' : 'inventory__cell';
  cell.dataset.state = slot.itemType ? 'ready' : 'empty';
  if (hotbar) {
    cell.dataset.slotIndex = String(slot.ref.slotIndex);
    cell.dataset.active = String(slot.active === true);
  }
  if (slot.category) cell.dataset.category = slot.category;
  if (slot.itemType) cell.dataset.itemType = slot.itemType;
  if (slot.contraband) cell.dataset.contraband = 'true';
  cell.setAttribute('aria-label', describe(slot));

  if (handlers.dropOn) makeDropZone(cell, slot, handlers);

  if (!slot.itemType) {
    cell.classList.add('inventory__cell--empty');
    if (slot.shortcut !== undefined) cell.append(createShortcut(slot.shortcut));
    return cell;
  }

  if (slot.summary) cell.setAttribute('title', `${slot.displayName}　${slot.summary}`);

  if (slot.shortcut !== undefined) cell.append(createShortcut(slot.shortcut));

  const swatch = document.createElement('span');
  swatch.className = 'inventory__swatch';
  // 物品自己的颜色画在底衬上，图标保持描边跟随文字色，选中态不用换图。
  swatch.setAttribute('style', `--item-tint:${slot.tint ?? '#b9b4a8'}`);
  swatch.append(createItemIcon(slot.iconId ?? '', { className: 'inventory__icon' }));
  cell.append(swatch);

  // 物品栏那一条的格子只有 46 像素见方，塞不下名字；名字在 aria-label 和 title 上。
  if (!hotbar) {
    const name = document.createElement('span');
    name.className = 'inventory__name';
    name.textContent = slot.displayName ?? '';
    cell.append(name);
  }

  const count = document.createElement('span');
  count.className = slot.full ? 'inventory__count is-full' : 'inventory__count';
  count.textContent = hotbar || slot.stackLimit <= 1
    ? String(slot.quantity)
    : `${slot.quantity} / ${slot.stackLimit}`;
  cell.append(count);

  if (slot.ammo) cell.append(createAmmoBox(slot.ammo));

  if (!hotbar) cell.append(...createBadges(slot));

  // 点一下弹菜单，按住拖动直接搬。两条入口指向同一件事：快的那条不用打开菜单，
  // 慢的那条不用先学会拖拽。
  if (slot.holdable) {
    cell.classList.add('inventory__cell--actionable');
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-haspopup', 'menu');
    cell.dataset.commonUiReceiver = '';
    cell.addEventListener('click', () => handlers.openMenu?.(cell, slot));
    cell.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      handlers.openMenu?.(cell, slot);
    });
    if (handlers.beginDrag) makeDraggable(cell, slot, handlers);
  }
  return cell;
}

function createShortcut(shortcut: number): HTMLElement {
  const element = document.createElement('span');
  element.className = 'inventory__shortcut';
  element.textContent = String(shortcut);
  return element;
}

/**
 * 右下角那个弹药小框：装着的弹药图标 + 还剩几发。
 *
 * **没装弹药时整个不画**。一个空框看起来像坏了，而不像「没装」——而「这件东西
 * 吃弹药」这件事，玩家在把石头拖上去的时候自然会知道。
 */
function createAmmoBox(ammo: AmmoLoadView): HTMLElement {
  const box = document.createElement('span');
  box.className = 'inventory__ammo';
  box.setAttribute('style', `--item-tint:${ammo.tint}`);
  box.setAttribute('aria-hidden', 'true');
  box.append(createItemIcon(ammo.iconId, { className: 'inventory__ammo-icon' }));
  const count = document.createElement('span');
  count.className = 'inventory__ammo-count';
  count.textContent = String(ammo.quantity);
  box.append(count);
  box.setAttribute('title', `${ammo.displayName} ${ammo.quantity} / ${ammo.capacity}`);
  return box;
}

function createBadges(slot: InventorySlotView): HTMLElement[] {
  const badges: HTMLElement[] = [];
  if ((slot.slotCost ?? 1) > 1) {
    badges.push(createBadge('inventory__badge', `${slot.slotCost} 格`));
  } else if (slot.slotCost === 0) {
    badges.push(createBadge('inventory__badge inventory__badge--pooled', '不占格'));
  }
  if (slot.coinValue !== undefined) {
    badges.push(createBadge('inventory__badge inventory__badge--coin', `${slot.coinValue} 金币`));
  }
  return badges;
}

function createBadge(className: string, text: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = className;
  badge.textContent = text;
  return badge;
}

/**
 * 让一格拖得动。
 *
 * `dragend` 无条件清掉来源：拖到界面外面松手不会触发 `drop`，不清的话下一次
 * 拖拽会带着上一次的来源落地，搬错一摞货。
 */
function makeDraggable(
  cell: HTMLElement,
  slot: InventorySlotView,
  handlers: InventorySlotCellHandlers,
): void {
  cell.draggable = true;
  cell.dataset.commonUiReceiver = '';
  cell.addEventListener('dragstart', (event) => {
    handlers.beginDrag?.(slot);
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) transfer.effectAllowed = 'move';
  });
  cell.addEventListener('dragend', () => handlers.endDrag?.());
}

/**
 * 让一格接得住。
 *
 * `dragover` 必须 `preventDefault`，否则浏览器根本不会派发 `drop`——这是 HTML
 * 拖放里最容易漏、漏了之后表现为「拖过去没反应」的一步。
 */
function makeDropZone(
  cell: HTMLElement,
  slot: InventorySlotView,
  handlers: InventorySlotCellHandlers,
): void {
  cell.addEventListener('dragover', (event) => {
    if (handlers.isDragging?.() === false) return;
    event.preventDefault();
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) transfer.dropEffect = 'move';
  });
  cell.addEventListener('drop', (event) => {
    event.preventDefault();
    handlers.dropOn?.(slot);
  });
}

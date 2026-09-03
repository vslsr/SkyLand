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
  private readonly capacityText: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly ledgerText: HTMLElement;
  private readonly slotGrid: HTMLElement;
  private readonly pooledSection: HTMLElement;
  private readonly pooledGrid: HTMLElement;
  private readonly emptyNotice: HTMLElement;
  private closeHintText = 'Esc 关闭';
  private readonly closeHint: HTMLElement;

  public constructor() {
    super({
      id: 'player-inventory',
      kicker: 'BACKPACK',
      title: '背包',
      description: '角色只带得走一次收获：大宗资源存进船舱，弹药和基础工具不占货位。',
      size: 'wide',
    });
    this.element.className += ' inventory-window';

    const summary = document.createElement('section');
    summary.className = 'inventory__summary';
    this.capacityText = document.createElement('p');
    this.capacityText.className = 'inventory__capacity';
    const meter = document.createElement('div');
    meter.className = 'inventory__meter';
    this.meterFill = document.createElement('span');
    this.meterFill.className = 'inventory__meter-fill';
    meter.append(this.meterFill);
    this.ledgerText = document.createElement('p');
    this.ledgerText.className = 'inventory__ledger';
    this.ledgerText.setAttribute('role', 'status');
    summary.append(this.capacityText, meter, this.ledgerText);

    this.emptyNotice = document.createElement('p');
    this.emptyNotice.className = 'inventory__empty-notice';
    this.emptyNotice.textContent = '进入房间后才有随身物品。';
    this.emptyNotice.hidden = true;

    const slotSection = document.createElement('section');
    slotSection.className = 'inventory__section';
    const slotHeading = document.createElement('h3');
    slotHeading.textContent = '随身货位';
    this.slotGrid = document.createElement('ul');
    this.slotGrid.className = 'inventory__grid';
    this.slotGrid.setAttribute('role', 'list');
    slotSection.append(slotHeading, this.slotGrid);

    this.pooledSection = document.createElement('section');
    this.pooledSection.className = 'inventory__section';
    this.pooledSection.hidden = true;
    const pooledHeading = document.createElement('h3');
    pooledHeading.textContent = '不占货位';
    const pooledNote = document.createElement('p');
    pooledNote.className = 'inventory__note';
    pooledNote.textContent = '弹药与基础工具各有上限，但不挤压随身货位。';
    this.pooledGrid = document.createElement('ul');
    this.pooledGrid.className = 'inventory__grid inventory__grid--pooled';
    this.pooledGrid.setAttribute('role', 'list');
    this.pooledSection.append(pooledHeading, pooledNote, this.pooledGrid);

    this.bodyElement.append(summary, this.emptyNotice, slotSection, this.pooledSection);

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

  /** 画一份背包；传 undefined 表示还没有权威数据（没进房间或角色已销毁）。 */
  public setInventory(view: InventoryView | undefined): void {
    this.emptyNotice.hidden = view !== undefined;
    if (!view) {
      this.capacityText.textContent = '货位 —';
      this.setMeter(0);
      this.ledgerText.textContent = '';
      this.slotGrid.replaceChildren();
      this.pooledSection.hidden = true;
      this.pooledGrid.replaceChildren();
      return;
    }

    this.capacityText.textContent = `货位 ${view.usedSlots} / ${view.slotCapacity}`;
    this.setMeter(view.slotCapacity > 0 ? view.usedSlots / view.slotCapacity : 0);
    this.ledgerText.textContent = this.describeLedger(view);

    const cells = view.slots.map((stack) => this.createStackCell(stack));
    for (let index = 0; index < view.freeSlots; index += 1) {
      cells.push(this.createEmptyCell());
    }
    this.slotGrid.replaceChildren(...cells);

    this.pooledSection.hidden = view.pooled.length === 0;
    this.pooledGrid.replaceChildren(...view.pooled.map((stack) => this.createStackCell(stack)));
  }

  private describeLedger(view: InventoryView): string {
    const parts: string[] = [];
    if (view.cargoValue > 0) parts.push(`待兑现 ${view.cargoValue} 金币`);
    if (view.contrabandCount > 0) parts.push(`携带 ${view.contrabandCount} 件违禁品，位置会被公开`);
    if (view.freeSlots === 0) parts.push('货位已满，再采只能留在原地');
    return parts.join(' · ');
  }

  private setMeter(ratio: number): void {
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    this.meterFill.setAttribute('style', `width:${percent}%`);
  }

  private createEmptyCell(): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory__cell inventory__cell--empty';
    cell.setAttribute('aria-label', '空货位');
    return cell;
  }

  private createStackCell(stack: InventoryStackView): HTMLElement {
    const cell = document.createElement('li');
    cell.className = 'inventory__cell';
    cell.dataset.itemType = stack.itemType;
    cell.dataset.category = stack.category;
    if (stack.contraband) cell.dataset.contraband = 'true';
    cell.setAttribute('title', `${stack.displayName}　${stack.summary}`);
    cell.setAttribute(
      'aria-label',
      `${stack.categoryLabel} ${stack.displayName}，${stack.quantity} 个，上限 ${stack.stackLimit}`,
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

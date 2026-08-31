import { ActorComponent } from '../ActorComponent.mjs';

export const INVENTORY_COMPONENT = 'inventory';

/** 最小权威背包：当前只保存 itemType -> quantity，足以闭合掉落拾取链路。 */
export class InventoryComponent extends ActorComponent {
  constructor() {
    super(INVENTORY_COMPONENT);
    this.quantities = new Map();
    this.revision = 0;
  }

  quantityOf(itemType) {
    return this.quantities.get(itemType) ?? 0;
  }

  add(itemType, quantity) {
    const accepted = Math.max(0, Math.floor(Number(quantity) || 0));
    if (accepted === 0) return 0;
    this.quantities.set(itemType, this.quantityOf(itemType) + accepted);
    this.revision += 1;
    return accepted;
  }

  snapshot() {
    return Array.from(this.quantities, ([itemType, quantity]) => ({ itemType, quantity }))
      .sort((left, right) => left.itemType.localeCompare(right.itemType));
  }
}

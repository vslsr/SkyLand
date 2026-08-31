import { ActorComponent } from '../ActorComponent.mjs';

export const ITEM_STACK_COMPONENT = 'itemStack';

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** 多个同类物品共享一个 Actor 身份，数量变化才增加复制 revision。 */
export class ItemStackComponent extends ActorComponent {
  constructor(definition = {}) {
    super(ITEM_STACK_COMPONENT);
    if (typeof definition.itemType !== 'string' || definition.itemType.length === 0) {
      throw new TypeError('ItemStack.itemType 必须是非空字符串');
    }
    this.itemType = definition.itemType;
    this.displayName = definition.displayName ?? definition.itemType;
    this.compatibilityKey = definition.compatibilityKey ?? definition.itemType;
    this.maximumQuantity = positiveInteger(definition.maximumQuantity, 999);
    this.quantity = Math.min(
      positiveInteger(definition.quantity ?? definition.defaultQuantity, 1),
      this.maximumQuantity,
    );
    this.revision = 0;
  }

  get remainingCapacity() {
    return this.maximumQuantity - this.quantity;
  }

  isCompatible(other) {
    return Boolean(
      other
      && other.itemType === this.itemType
      && other.compatibilityKey === this.compatibilityKey,
    );
  }

  add(quantity) {
    const requested = Math.max(0, Math.floor(Number(quantity) || 0));
    const accepted = Math.min(requested, this.remainingCapacity);
    if (accepted > 0) {
      this.quantity += accepted;
      this.revision += 1;
    }
    return accepted;
  }

  remove(quantity) {
    const requested = Math.max(0, Math.floor(Number(quantity) || 0));
    const removed = Math.min(requested, this.quantity);
    if (removed > 0) {
      this.quantity -= removed;
      this.revision += 1;
    }
    return removed;
  }
}

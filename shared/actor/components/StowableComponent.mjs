import { ActorComponent } from '../ActorComponent.mjs';

export const STOWABLE_COMPONENT = 'stowable';

/**
 * 这个世界物件被收进背包时算哪种物品。
 *
 * 蘑菇、以后的花草贝壳都是「长在世界里、能叼在嘴上」的东西：它们有自己的位置、
 * 刚体和交互，不是物品堆。但玩家长按交互键要把它们揣走时，背包里只认物品。
 *
 * 这个映射写在**物件自己身上**，而不是写在背包或某张转换表里：一株蘑菇装进包里
 * 算什么，是这株蘑菇的属性。背包只需要问它，不需要认识世界上所有能被揣走的东西。
 * 没挂这个 Component 的物件就是揣不走的，长按会回退成放下。
 */
export class StowableComponent extends ActorComponent {
  constructor(definition = {}) {
    super(STOWABLE_COMPONENT);
    if (typeof definition.itemType !== 'string' || definition.itemType.length === 0) {
      throw new TypeError('Stowable.itemType 必须是非空字符串');
    }
    this.itemType = definition.itemType;
    const quantity = Number(definition.quantity);
    this.quantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  }
}

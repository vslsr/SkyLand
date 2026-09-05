import rawItemCatalog from '../../config/items/item-catalog.json' with { type: 'json' };
import { ItemCatalog } from './ItemCatalog.mjs';

export {
  ItemCatalog,
  ITEM_CATEGORIES,
  ITEM_USE_ACTIONS,
  ITEM_USE_MODES,
} from './ItemCatalog.mjs';
export {
  resolveWeaponStrike,
  weaponChargeRatioForDistance,
  tagMultiplier,
  weaponDamage,
  weaponImpactPoint,
} from './weaponStrike.mjs';
export {
  createItemUseAbility,
  holdRatio,
  itemAbilityId,
  itemCooldownGroup,
  resolveItemUse,
  ITEM_USE_ABILITY_SLOT,
  ITEM_USE_STATE_TAG,
} from './ItemAbility.mjs';

/**
 * 全局物品定义表。
 *
 * 服务端与客户端读同一份 JSON，所以「木头堆到几个」「蘑菇一格装几朵」
 * 两端永远是同一个答案，不需要为物品参数再走一次复制。
 */
export const itemCatalog = new ItemCatalog(rawItemCatalog);

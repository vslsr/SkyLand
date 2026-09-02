import rawItemCatalog from '../../config/items/item-catalog.json' with { type: 'json' };
import { ItemCatalog } from './ItemCatalog.mjs';

export { ItemCatalog, ITEM_CATEGORIES } from './ItemCatalog.mjs';

/**
 * 全局物品定义表。
 *
 * 服务端与客户端读同一份 JSON，所以「木材堆到几个」「王冠遗物占几个货位」
 * 两端永远是同一个答案，不需要为物品参数再走一次复制。
 */
export const itemCatalog = new ItemCatalog(rawItemCatalog);

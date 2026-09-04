import { SvgSprite } from './svgSprite';

/**
 * 物品图标。
 *
 * 和地形图标同一套语言：24×24 视口、纯描边、`stroke="currentColor"`，
 * 所以格子在悬停/选中翻成深底浅字时图标不需要单独换色；物品自己的
 * 颜色由目录里的 `tint` 画在格子底衬上，而不是画进图标。
 *
 * 新增一种物品：往 `config/items/item-catalog.json` 加一条，再往这里加一枚
 * 同名图标即可。忘了加图标也不会碎——`createItemIcon` 会退回通用货箱。
 */
const ITEM_ICON_PATHS = {
  /** 忘记登记图标时的兜底：一只普通货箱。 */
  'item-generic': `
    <path d="M4.2 7.6 12 4.4l7.8 3.2v8.8L12 19.6l-7.8-3.2Z" />
    <path d="M4.2 7.6 12 10.8l7.8-3.2" />
    <path d="M12 10.8v8.8" />
  `,
  /** 木头：躺着的一段六棱柱，端面画成六边形，和世界里那根是同一样东西。 */
  'item-wood': `
    <path d="M8.4 7.2h7.8l3 2.4v4.8l-3 2.4H8.4" />
    <path d="M8.4 7.2 5.4 9.6v4.8l3 2.4 3-2.4V9.6Z" />
    <path d="M8.4 10.6a1.6 1.6 0 0 0 0 2.8" />
  `,
  /** 石头：一颗压扁的多边形石子，和掉在地上的那颗同一个轮廓。 */
  'item-stone': `
    <path d="m4.6 13.4 3-3.6 5-1.2 5.4 2.2 1.4 3.4-3.2 3-8.4.4Z" />
    <path d="m7.6 9.8 1.8 5.4" />
    <path d="m18 10.8-3.4 4.6" />
  `,
  /** 果子：一颗带梗带叶的苹果。 */
  'item-fruit': `
    <path d="M12 8.6c1.4-1.6 4-1.4 5.2.6 1.5 2.5.2 6.4-2.4 8.4-1.6 1.2-3.9 1.2-5.5 0-2.6-2-4-5.9-2.4-8.4 1.2-2 3.7-2.2 5.1-.6Z" />
    <path d="M12 8.6V5.4" />
    <path d="M12.2 7c1.1-1.9 2.7-2.5 4.1-2.2-.1 1.7-1.2 2.9-2.8 3.2" />
  `,
  /** 弹弓：一把 Y 形树杈，两端牵着皮筋，皮筋中间兜着一颗石子。 */
  'item-slingshot': `
    <path d="M7.2 4.8v3.4l1.9 2.2v8.8h5.8v-8.8l1.9-2.2V4.8" />
    <path d="M7.2 6.2c-1.7 1.1-2.2 3.1-1 4.4l3.6 2.6" />
    <path d="M16.8 6.2c1.7 1.1 2.2 3.1 1 4.4l-3.6 2.6" />
    <circle cx="12" cy="12.6" r="1.5" />
  `,
  /** 蘑菇：菌盖加菌柄，和地里长着的那朵同一副样子。 */
  'item-mushroom': `
    <path d="M4.2 11.2a6.8 6.8 0 0 1 13.6 0Z" />
    <path d="M9.4 11.2v4.9a1.8 1.8 0 0 0 3.2 0v-4.9" />
    <circle cx="8.4" cy="8.6" r="1.1" />
    <circle cx="13.4" cy="9.2" r="0.8" />
  `,
} as const;

/** 已登记的物品图标 id。 */
export type ItemIconId = keyof typeof ITEM_ICON_PATHS;

/** 目录里没画图标的物品统一退回这枚货箱。 */
export const FALLBACK_ITEM_ICON_ID: ItemIconId = 'item-generic';

const sprite = new SvgSprite<ItemIconId>({
  elementId: 'ui-item-icon-sprite',
  symbolIdPrefix: 'item-icon-',
  paths: ITEM_ICON_PATHS,
});

export const ITEM_ICON_IDS = sprite.ids;

/** @returns 目录里登记的 iconId 是否真的画了图标。 */
export function hasItemIcon(iconId: string): iconId is ItemIconId {
  return sprite.has(iconId);
}

export function itemIconSymbolId(iconId: ItemIconId): string {
  return sprite.symbolId(iconId);
}

export function ensureItemIconSprite(host: Document = document): SVGSVGElement {
  return sprite.ensure(host);
}

/**
 * 造一枚物品图标。
 *
 * 传进来的是目录里的 `iconId` 字符串而不是联合类型：物品是数据，
 * 目录随时可能先于图标更新，这时退回通用货箱比让界面炸掉合适。
 */
export function createItemIcon(
  iconId: string,
  options: { className?: string } = {},
): SVGSVGElement {
  return sprite.createElement(
    hasItemIcon(iconId) ? iconId : FALLBACK_ITEM_ICON_ID,
    options,
  );
}

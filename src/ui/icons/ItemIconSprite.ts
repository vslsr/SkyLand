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
  'item-wood': `
    <rect x="3.6" y="7.4" width="16.8" height="3.7" rx="0.7" />
    <rect x="3.6" y="12.9" width="16.8" height="3.7" rx="0.7" />
    <path d="M8.8 7.4v3.7" />
    <path d="M15.2 12.9v3.7" />
  `,
  'item-wood-log': `
    <path d="M8 6.5h8.4a5.5 5.5 0 0 1 0 11H8" />
    <ellipse cx="8" cy="12" rx="2.7" ry="5.5" />
    <circle cx="8" cy="12" r="1.1" />
  `,
  'item-mushroom': `
    <path d="M4.2 11.2a6.8 6.8 0 0 1 13.6 0Z" />
    <path d="M9.4 11.2v4.9a1.8 1.8 0 0 0 3.2 0v-4.9" />
    <circle cx="8.4" cy="8.6" r="1.1" />
    <circle cx="13.4" cy="9.2" r="0.8" />
  `,
  'item-stone': `
    <path d="M3.6 18.4h16.8" />
    <path d="m5.6 18.4-1.3-3.7 3.2-2.7 3.7 1.5.6 3.4-1.5 1.5Z" />
    <path d="m13.8 18.4-.7-3 2.6-1.9 3 1.6-.4 3.3Z" />
  `,
  'item-rope': `
    <circle cx="11" cy="13" r="6.4" />
    <circle cx="11" cy="13" r="3.1" />
    <path d="M16.4 9.6c1.5-2.2 2.8-3.5 4-4" />
  `,
  'item-gunpowder': `
    <path d="M6.6 9c0-1.2 2.4-2.1 5.4-2.1s5.4.9 5.4 2.1v7.6c0 1.2-2.4 2.1-5.4 2.1s-5.4-.9-5.4-2.1Z" />
    <path d="M6.6 9c0 1.2 2.4 2.1 5.4 2.1s5.4-.9 5.4-2.1" />
    <path d="M6.9 13.8h10.2" />
    <path d="M12.8 6.8c.5-1.7 1.7-2.6 3.5-2.7" />
  `,
  'item-fruit': `
    <path d="M12 8.6c1.4-1.6 4-1.4 5.2.6 1.5 2.5.2 6.4-2.4 8.4-1.6 1.2-3.9 1.2-5.5 0-2.6-2-4-5.9-2.4-8.4 1.2-2 3.7-2.2 5.1-.6Z" />
    <path d="M12 8.6V5.4" />
    <path d="M12.2 7c1.1-1.9 2.7-2.5 4.1-2.2-.1 1.7-1.2 2.9-2.8 3.2" />
  `,
  'item-bandage': `
    <rect x="3.8" y="8.4" width="16.4" height="7.2" rx="3.6" />
    <path d="M9.6 8.4 6.2 15.6" />
    <path d="M14.4 8.4 11 15.6" />
    <path d="M18.6 9.7 16.6 14" />
  `,
  'item-medkit': `
    <rect x="3.6" y="7.6" width="16.8" height="10.8" rx="1.6" />
    <path d="M9 7.6V5.9a1.1 1.1 0 0 1 1.1-1.1h3.8A1.1 1.1 0 0 1 15 5.9v1.7" />
    <path d="M12 10.4v5.2" />
    <path d="M9.4 13h5.2" />
  `,
  'item-armor-patch': `
    <path d="M12 4.4 18.8 6.7v5.4c0 3.5-2.6 6.3-6.8 7.5-4.2-1.2-6.8-4-6.8-7.5V6.7Z" />
    <path d="M8.8 12.3h6.4" />
    <path d="M10.2 9.9v4.9" />
    <path d="M13.8 9.9v4.9" />
  `,
  'item-firebomb': `
    <path d="M10.4 6.2h3.2v2.6l2.4 3.4a4.9 4.9 0 0 1-4 7.6 4.9 4.9 0 0 1-4-7.6l2.4-3.4Z" />
    <path d="M10.4 6.2c-.7-1.6-.2-2.7 1.3-3.2" />
    <path d="M9.5 14.8c1.7.8 3.3.8 5 0" />
  `,
  'item-net-shell': `
    <circle cx="12" cy="12" r="7.4" />
    <path d="M12 4.6v14.8" />
    <path d="M4.6 12h14.8" />
    <path d="M6.8 6.8 17.2 17.2" />
    <path d="M17.2 6.8 6.8 17.2" />
  `,
  'item-smoke-canister': `
    <rect x="7.4" y="10" width="8.8" height="9.2" rx="1.6" />
    <path d="M9.6 10V8.2h4.4V10" />
    <path d="M17.4 8.8c1.9-.6 2.8-1.9 2.7-3.9" />
    <path d="M15.7 5.8c1.5-.4 2.2-1.3 2.1-2.6" />
  `,
  'item-light-ammo': `
    <path d="M5.8 19.4v-6.6c0-1.8.7-3.5 2-4.8l.9-.9.9.9c1.3 1.3 2 3 2 4.8v6.6Z" />
    <path d="M13.4 19.4v-6.6c0-1.8.7-3.5 2-4.8l.9-.9.9.9c1.3 1.3 2 3 2 4.8v6.6Z" />
    <path d="M5.8 14.8h5.8" />
    <path d="M13.4 14.8h5.8" />
  `,
  'item-special-ammo': `
    <path d="M8.6 19.4v-5.9c0-1.8.7-3.5 2-4.8l1-1 1 1c1.3 1.3 2 3 2 4.8v5.9Z" />
    <path d="M8.6 15.2h6" />
    <path d="m18 4.6 2.4 2.4L18 9.4 15.6 7Z" />
  `,
  'item-harvest-hammer': `
    <rect x="6" y="4.6" width="12" height="4.8" rx="0.8" />
    <path d="M10.6 9.4h2.8v10h-2.8z" />
    <path d="M9 4.6v4.8" />
    <path d="M15 4.6v4.8" />
  `,
  'item-spice-bundle': `
    <path d="M9.2 9h5.6c2.3 1.8 3.7 4.2 3.7 6.4 0 2.2-2.9 3.9-6.5 3.9s-6.5-1.7-6.5-3.9c0-2.2 1.4-4.6 3.7-6.4Z" />
    <path d="M8.6 9h6.8" />
    <path d="M10 9c-.7-1.7-.4-3 .9-3.9" />
    <path d="M14 9c.7-1.7.4-3-.9-3.9" />
  `,
  'item-ancient-coin-case': `
    <rect x="3.6" y="8.6" width="16.8" height="10.4" rx="1.4" />
    <path d="M3.6 12.2h16.8" />
    <path d="M10.2 8.6V6.4h3.6v2.2" />
    <circle cx="12" cy="15.6" r="1.9" />
  `,
  'item-crown-relic': `
    <path d="M4.6 17.4 3.4 7.2l4.8 3.4L12 4.8l3.8 5.8 4.8-3.4-1.2 10.2Z" />
    <path d="M5 20.2h14" />
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

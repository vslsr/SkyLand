import { SvgSprite } from './svgSprite';

/**
 * 地形图标共用的底图：一条地平线加一段山脊。
 *
 * 整套地形图标都是「同一片地形 + 右上角一个表示操作的徽标」，所以底图只写一份。
 * 徽标固定占据 x 14–21、y 5–11 这块空地，避免和山脊叠在一起。
 */
const TERRAIN_BASE = `
    <path d="M2.5 18.5h19" />
    <path d="m3 18.5 4.5-6 3 3.5 2.5-3 5 5.5" />
  `;

/**
 * 图标定义。
 *
 * 全部按 24×24 视口、纯描边绘制，`stroke="currentColor"` 让颜色跟着按钮的
 * 文字色走——选中态把按钮变成深底浅字时，图标不需要单独换色。
 */
const ICON_PATHS = {
  'terrain-raise': `
    ${TERRAIN_BASE}
    <path d="M17.5 11.5V5" />
    <path d="m15 7.5 2.5-2.5L20 7.5" />
  `,
  'terrain-lower': `
    ${TERRAIN_BASE}
    <path d="M17.5 5v6.5" />
    <path d="m15 9 2.5 2.5L20 9" />
  `,
  'terrain-flatten': `
    ${TERRAIN_BASE}
    <rect x="14.3" y="6.6" width="6.4" height="3.6" rx="1.1" />
    <path d="M17.5 8.4h.01" />
  `,
  'terrain-water': `
    ${TERRAIN_BASE}
    <path d="M14.5 6.5c1-1 2-1 3 0s2 1 3 0" />
    <path d="M14.5 10c1-1 2-1 3 0s2 1 3 0" />
  `,
  'terrain-ground': `
    ${TERRAIN_BASE}
    <rect x="14.3" y="5.8" width="6.4" height="5.4" rx="1.1" fill="currentColor" />
  `,
  'terrain-panel': `
    ${TERRAIN_BASE}
    <path d="M15 8h5" />
    <path d="M17.5 5.5v5" />
  `,
  'terrain-reset': `
    ${TERRAIN_BASE}
    <path d="M20.5 8.5a3 3 0 1 1-1-2.3" />
    <path d="M20.8 5.2v3h-3" />
  `,
  /** 建造栏标签：一柄锤子。 */
  'build-panel': `
    <path d="m5 19 7.5-7.5" />
    <path d="m10.5 9.5 4-4 4 4-4 4Z" />
    <path d="m14.5 5.5 2-2 2 2" />
  `,
  /** 地基（静态 / 水上）：一块斜放的平板。 */
  'build-foundation': `
    <path d="M3.5 12 12 7.5l8.5 4.5L12 16.5Z" />
    <path d="M3.5 12v2.5L12 19l8.5-4.5V12" />
    <path d="M12 16.5V19" />
  `,
  /** 墙：错缝砌的砖。 */
  'build-wall': `
    <rect x="4" y="7" width="16" height="11" />
    <path d="M4 12.5h16" />
    <path d="M9.5 7v5.5" />
    <path d="M14.5 7v5.5" />
    <path d="M7 12.5V18" />
    <path d="M12 12.5V18" />
    <path d="M17 12.5V18" />
  `,
  /** 物件：一堆篝火，三根柴上一簇火苗。 */
  'build-fixture': `
    <path d="m5.5 18.5 13-4" />
    <path d="m5.5 14.5 13 4" />
    <path d="M12 15.5c-2.2-1.4-2.6-3.6-1.2-5.6.3 1.1.9 1.6 1.6 1.8-.4-1.9.3-3.6 2-4.7-.1 2 .8 3 1.7 4 .9 1.7.4 3.5-1.3 4.5" />
  `,
  /** 拆除：撬起来的一块板。 */
  'build-remove': `
    <path d="M4 18.5h16" />
    <path d="m6 15.5 8-6" />
    <path d="M5 11.5 8.5 8l4.5 1.5" />
    <path d="M14.5 6.5 19 11" />
    <path d="m16.75 4.25 4.5 4.5" />
  `,
} as const;

/** 可用图标 ID。新增图标只要往 ICON_PATHS 里加一项。 */
export type IconId = keyof typeof ICON_PATHS;

const sprite = new SvgSprite<IconId>({
  elementId: 'ui-icon-sprite',
  symbolIdPrefix: 'icon-',
  paths: ICON_PATHS,
});

export const ICON_IDS = sprite.ids;

/** @returns 这个图标在 sprite 里的 symbol id，供 `<use href="#...">` 引用。 */
export function iconSymbolId(id: IconId): string {
  return sprite.symbolId(id);
}

/** 把 sprite 注入文档，重复调用只做一次。 */
export function ensureIconSprite(host: Document = document): SVGSVGElement {
  return sprite.ensure(host);
}

/** 造一个引用 sprite 的图标元素。 */
export function createIcon(id: IconId, options: { className?: string } = {}): SVGSVGElement {
  return sprite.createElement(id, options);
}

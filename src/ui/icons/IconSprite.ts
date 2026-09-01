const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SPRITE_ELEMENT_ID = 'ui-icon-sprite';
const SYMBOL_ID_PREFIX = 'icon-';

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
} as const;

/** 可用图标 ID。新增图标只要往 ICON_PATHS 里加一项。 */
export type IconId = keyof typeof ICON_PATHS;

export const ICON_IDS = Object.keys(ICON_PATHS) as readonly IconId[];

/** @returns 这个图标在 sprite 里的 symbol id，供 `<use href="#...">` 引用。 */
export function iconSymbolId(id: IconId): string {
  return `${SYMBOL_ID_PREFIX}${id}`;
}

/**
 * 把 sprite 注入文档，重复调用只做一次。
 *
 * 每个图标的路径数据只出现一份，用到几次都是 `<use>` 引用——按钮多起来
 * 也不会把同样的 path 复制很多遍。
 */
export function ensureIconSprite(host: Document = document): SVGSVGElement {
  const existing = host.getElementById(SPRITE_ELEMENT_ID);
  if (existing) return existing as unknown as SVGSVGElement;

  const sprite = host.createElementNS(SVG_NAMESPACE, 'svg');
  sprite.id = SPRITE_ELEMENT_ID;
  sprite.setAttribute('aria-hidden', 'true');
  // 不能用 display:none：那样 Safari 里 <use> 会引用不到。
  sprite.setAttribute(
    'style',
    'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none',
  );
  for (const [id, markup] of Object.entries(ICON_PATHS)) {
    const symbol = host.createElementNS(SVG_NAMESPACE, 'symbol');
    symbol.id = iconSymbolId(id as IconId);
    symbol.setAttribute('viewBox', '0 0 24 24');
    symbol.setAttribute('fill', 'none');
    symbol.setAttribute('stroke', 'currentColor');
    symbol.setAttribute('stroke-width', '1.6');
    symbol.setAttribute('stroke-linecap', 'round');
    symbol.setAttribute('stroke-linejoin', 'round');
    symbol.innerHTML = markup;
    sprite.append(symbol);
  }
  host.body.append(sprite);
  return sprite;
}

/**
 * 造一个引用 sprite 的图标元素。
 *
 * 默认 `aria-hidden`：图标旁边通常已经有 aria-label 或可见文字，
 * 再读一遍只会让读屏重复。
 */
export function createIcon(id: IconId, options: { className?: string } = {}): SVGSVGElement {
  ensureIconSprite();
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (options.className) svg.setAttribute('class', options.className);
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `#${iconSymbolId(id)}`);
  svg.append(use);
  return svg;
}

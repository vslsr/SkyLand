const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SPRITE_ELEMENT_ID = 'ui-icon-sprite';
const SYMBOL_ID_PREFIX = 'icon-';

/**
 * 图标定义。
 *
 * 全部按 24×24 视口、纯描边绘制，`stroke="currentColor"` 让颜色跟着按钮的
 * 文字色走——选中态把按钮变成深底浅字时，图标不需要单独换色。
 */
const ICON_PATHS = {
  'terrain-raise': `
    <path d="M4 17.5h16" />
    <path d="M12 4.5v8" />
    <path d="M8 8.5 12 4.5l4 4" />
  `,
  'terrain-lower': `
    <path d="M4 6.5h16" />
    <path d="M12 19.5v-8" />
    <path d="M8 15.5 12 19.5l4-4" />
  `,
  'terrain-flatten': `
    <path d="M3 14.5h18" />
    <path d="M6 10.5h4" />
    <path d="M14 10.5h4" />
  `,
  'terrain-water': `
    <path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
    <path d="M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
  `,
  'terrain-ground': `
    <path d="M3.5 8.5h17v11h-17z" />
    <path d="M3.5 12.5h17" />
    <path d="M9.5 12.5v7" />
    <path d="M15.5 12.5v7" />
    <path d="M3.5 8.5 7 5h10l3.5 3.5" />
  `,
  'terrain-reset': `
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4.5h-4.5" />
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

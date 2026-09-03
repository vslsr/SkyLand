const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export interface SvgSpriteOptions {
  /** sprite 容器的 DOM id；同一个 id 只会注入一次。 */
  readonly elementId: string;
  /** symbol id 前缀，避免两套图标撞名。 */
  readonly symbolIdPrefix: string;
  /** 图标 id -> `<symbol>` 内部的 SVG 源码。 */
  readonly paths: Readonly<Record<string, string>>;
  /** 描边粗细；线描图标统一 1.6，密一点的图形可以调细。 */
  readonly strokeWidth?: string;
}

/**
 * 一组 `<symbol>` 图标的注入与引用。
 *
 * 每个图标的路径数据只出现一份，用到几次都是 `<use>` 引用——地形工具栏和
 * 背包格子各有十几枚图标，复制 path 会让 DOM 迅速膨胀。
 */
export class SvgSprite<Id extends string> {
  public readonly ids: readonly Id[];

  public constructor(private readonly options: SvgSpriteOptions) {
    this.ids = Object.keys(options.paths) as Id[];
  }

  /** @returns 这个图标在 sprite 里的 symbol id，供 `<use href="#...">` 引用。 */
  public symbolId(id: Id): string {
    return `${this.options.symbolIdPrefix}${id}`;
  }

  public has(id: string): id is Id {
    return Object.hasOwn(this.options.paths, id);
  }

  /** 把 sprite 注入文档，重复调用只做一次。 */
  public ensure(host: Document = document): SVGSVGElement {
    const existing = host.getElementById(this.options.elementId);
    if (existing) return existing as unknown as SVGSVGElement;

    const sprite = host.createElementNS(SVG_NAMESPACE, 'svg');
    sprite.id = this.options.elementId;
    sprite.setAttribute('aria-hidden', 'true');
    // 不能用 display:none：那样 Safari 里 <use> 会引用不到。
    sprite.setAttribute(
      'style',
      'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none',
    );
    for (const [id, markup] of Object.entries(this.options.paths)) {
      const symbol = host.createElementNS(SVG_NAMESPACE, 'symbol');
      symbol.id = this.symbolId(id as Id);
      symbol.setAttribute('viewBox', '0 0 24 24');
      symbol.setAttribute('fill', 'none');
      symbol.setAttribute('stroke', 'currentColor');
      symbol.setAttribute('stroke-width', this.options.strokeWidth ?? '1.6');
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
  public createElement(id: Id, options: { className?: string } = {}): SVGSVGElement {
    this.ensure();
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (options.className) svg.setAttribute('class', options.className);
    const use = document.createElementNS(SVG_NAMESPACE, 'use');
    use.setAttribute('href', `#${this.symbolId(id)}`);
    svg.append(use);
    return svg;
  }
}

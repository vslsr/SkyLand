/**
 * 背包 / 容器界面测试共用的一棵假 DOM。
 *
 * 只实现界面真正用到的那点接口：`dataset`、`classList`、`append` / `replaceChildren`、
 * 以及 `collect`（代替 querySelectorAll）。两份界面画的是同一种格子，测试也就不该
 * 各自造一棵树——那样一个 fake 的疏漏只会在其中一边暴露。
 */
export class FakeElement extends EventTarget {
  public className = '';
  public hidden = false;
  public id = '';
  public textContent = '';
  public innerHTML = '';
  public tabIndex = 0;
  public type = '';
  public disabled = false;
  /** 拖拽用：界面给拖得动的格子写 true，测试要读得回来。 */
  public draggable = false;
  /** 菜单摆位会写 left/top；没有排版引擎，这里只要写得进去。 */
  public readonly style: Record<string, string> = {};
  public readonly dataset: Record<string, string> = {};
  public children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly classes = new Set<string>();

  public constructor(public readonly tagName: string) {
    super();
  }

  /** 只实现界面真正用到的三个方法；className 与它保持同步，断言两种写法都读得到。 */
  public readonly classList = {
    add: (name: string) => { this.classes.add(name); this.syncClassName(); },
    remove: (name: string) => { this.classes.delete(name); this.syncClassName(); },
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      this.syncClassName();
    },
    contains: (name: string) => this.classes.has(name) || this.className.split(' ').includes(name),
  };

  private syncClassName(): void {
    const base = this.className.split(' ').filter((name) => name && !this.classes.has(name));
    this.className = [...base, ...this.classes].join(' ');
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public remove(): void {
    // 这些测试只造一棵树，不需要真的从父节点上摘下来。
  }

  /** 菜单靠它判断「点的是不是自己」。 */
  public contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** 深度优先收集子树里符合条件的元素，代替 querySelectorAll。 */
  public collect(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      found.push(...child.collect(predicate));
    }
    return found;
  }

  public get text(): string {
    return this.textContent || this.children.map((child) => child.text).join('');
  }
}

export class FakeDocument extends EventTarget {
  public readonly body = new FakeElement('body');
  private readonly byId = new Map<string, FakeElement>();

  public createElement(tagName: string): HTMLElement {
    return new FakeElement(tagName) as unknown as HTMLElement;
  }

  public createElementNS(_namespace: string, tagName: string): SVGElement {
    const element = new FakeElement(tagName);
    // sprite 注入时按 id 查重，所以这里要能查回去。
    Object.defineProperty(element, 'id', {
      get: () => this.idOf(element),
      set: (value: string) => this.register(element, value),
      configurable: true,
    });
    return element as unknown as SVGElement;
  }

  public getElementById(id: string): HTMLElement | null {
    return (this.byId.get(id) ?? null) as unknown as HTMLElement | null;
  }

  private readonly ids = new WeakMap<FakeElement, string>();

  private idOf(element: FakeElement): string {
    return this.ids.get(element) ?? '';
  }

  private register(element: FakeElement, value: string): void {
    this.ids.set(element, value);
    this.byId.set(value, element);
  }
}

/**
 * 顶掉 `document` 与 `window`。
 *
 * `window` 也要有：弹出的动作菜单会在它上面挂一个 resize 关闭监听——菜单是按当时
 * 的格子位置摆的，窗口一变它就指错地方。
 */
export function withFakeDocument<T>(run: (document: FakeDocument) => T): T {
  const previousDocument = globalThis.document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const fake = new FakeDocument();
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  define('document', fake);
  define('window', new EventTarget());
  try {
    return run(fake);
  } finally {
    define('document', previousDocument);
    define('window', previousWindow);
  }
}

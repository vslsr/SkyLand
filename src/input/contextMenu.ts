/**
 * 屏蔽浏览器右键菜单。
 *
 * 右键在游戏画面里是一个输入，不是「打开系统菜单」的手势：按下去弹出菜单会挡住
 * 画面、吃掉后续的 pointermove，右键拖拽这类操作根本没法做完整。
 *
 * 这里只拦 `contextmenu` 的默认行为，不拦 `pointerdown`/`pointerup`——
 * `Mouse.Button2` 照常进 `KeyboardMouseInputDevice`，玩法随时可以绑上去。
 *
 * 文本输入控件默认放行：房间名这类输入框还要靠原生菜单做复制粘贴。
 */

export interface BrowserContextMenuOptions {
  /** 监听目标，默认整份文档：画布、HUD、CommonUI 都在同一份策略下。 */
  readonly target?: Document | HTMLElement;
  /** 文本输入控件上保留原生菜单，默认开启。 */
  readonly allowTextEntry?: boolean;
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * 只读 `tagName` 与 `isContentEditable`，不做 `instanceof HTMLInputElement`：
 * 判断逻辑因此在没有 DOM 构造函数的测试环境里同样成立。
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === 'string' && TEXT_ENTRY_TAGS.has(element.tagName.toUpperCase());
}

/** 安装右键菜单拦截，返回卸载函数。 */
export function suppressBrowserContextMenu(options: BrowserContextMenuOptions = {}): () => void {
  const target = options.target ?? document;
  const allowTextEntry = options.allowTextEntry ?? true;

  // 捕获阶段：CommonUI 栈在 `#app-shell` 上守着同一个事件，先于它拿到默认行为的
  // 决定权；这里不 stopPropagation，事件照旧走完原有的分发链路。
  const handleContextMenu = (event: Event): void => {
    if (allowTextEntry && isTextEntryTarget(event.target)) return;
    if (event.cancelable) event.preventDefault();
  };

  const listenerOptions: AddEventListenerOptions = { capture: true };
  target.addEventListener('contextmenu', handleContextMenu, listenerOptions);
  return () => target.removeEventListener('contextmenu', handleContextMenu, listenerOptions);
}

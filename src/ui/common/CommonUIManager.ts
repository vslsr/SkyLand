import type { CommonUICloseReason, CommonUIPage } from './CommonUIPage';

export interface CommonUIManagerOptions {
  sceneRoot: HTMLElement;
  baseLayer: HTMLElement;
  overlayRoot: HTMLElement;
}

type StackChangeListener = (top: CommonUIPage | undefined, size: number) => void;
type BaseEventHandler = (event: Event) => boolean;

const POINTER_EVENTS = [
  'pointerdown',
  'pointerup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
] as const;

const DOM_EVENT_RECEIVER_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable="true"]',
  '[data-common-ui-receiver]',
].join(',');

export class CommonUIManager {
  private readonly sceneRoot: HTMLElement;
  private readonly baseLayer: HTMLElement;
  private readonly overlayRoot: HTMLElement;
  private readonly pages: CommonUIPage[] = [];
  private readonly listeners = new Set<StackChangeListener>();
  private baseEventHandler?: BaseEventHandler;
  private active = false;

  public constructor(options: CommonUIManagerOptions) {
    this.sceneRoot = options.sceneRoot;
    this.baseLayer = options.baseLayer;
    this.overlayRoot = options.overlayRoot;

    for (const eventName of POINTER_EVENTS) {
      this.sceneRoot.addEventListener(eventName, this.guardPointerEvent, true);
    }
    document.addEventListener('keydown', this.guardKeyboardEvent, true);
  }

  public get size(): number {
    return this.pages.length;
  }

  public get top(): CommonUIPage | undefined {
    return this.pages.at(-1);
  }

  public get allowsGameInteraction(): boolean {
    return this.active && this.pages.length === 0;
  }

  public activate(): void {
    if (this.active) return;
    this.active = true;
    this.syncLayers();
  }

  public deactivate(): void {
    if (!this.active && this.pages.length === 0) return;
    this.active = false;
    this.clear('scene-switch');
    this.syncLayers();
  }

  public push(page: CommonUIPage): void {
    if (this.pages.includes(page)) {
      throw new Error(`CommonUI 页面 ${page.id} 已经在栈中`);
    }

    if (!this.overlayRoot.contains(page.element)) {
      this.overlayRoot.append(page.element);
    }

    if (document.pointerLockElement) document.exitPointerLock();
    page.element.hidden = false;
    this.pages.push(page);
    this.syncLayers();
    page.onOpen?.();
  }

  public pop(expectedTop?: CommonUIPage): CommonUIPage | undefined {
    const page = this.top;
    if (!page || (expectedTop && page !== expectedTop)) return undefined;

    this.pages.pop();
    this.hidePage(page);
    page.onClose?.('pop');
    this.syncLayers();
    return page;
  }

  public clear(reason: CommonUICloseReason = 'clear'): void {
    while (this.pages.length > 0) {
      const page = this.pages.pop();
      if (!page) continue;
      this.hidePage(page);
      page.onClose?.(reason);
    }
    this.syncLayers();
  }

  public onStackChange(listener: StackChangeListener): () => void {
    this.listeners.add(listener);
    listener(this.top, this.size);
    return () => this.listeners.delete(listener);
  }

  public setBaseEventHandler(handler: BaseEventHandler | undefined): void {
    this.baseEventHandler = handler;
  }

  public dispose(): void {
    this.deactivate();
    for (const eventName of POINTER_EVENTS) {
      this.sceneRoot.removeEventListener(eventName, this.guardPointerEvent, true);
    }
    document.removeEventListener('keydown', this.guardKeyboardEvent, true);
    this.listeners.clear();
  }

  private readonly guardPointerEvent = (event: Event): void => {
    if (!this.active || this.pages.length === 0) return;
    if (this.isReceivedByTopDom(event)) return;
    this.routeUnhandledEvent(event);
  };

  private readonly guardKeyboardEvent = (event: KeyboardEvent): void => {
    if (!this.active || this.pages.length === 0) return;

    if (event.key === 'Escape' && this.top?.closeOnEscape !== false) {
      this.rejectEvent(event);
      this.pop();
      return;
    }

    if (this.isReceivedByTopDom(event)) return;
    this.routeUnhandledEvent(event);
  };

  private isReceivedByTopDom(event: Event): boolean {
    const target = event.target;
    const top = this.top;
    if (!(target instanceof Element) || !top?.element.contains(target)) return false;
    if (event.type === 'wheel') return true;
    const receiver = target.closest(DOM_EVENT_RECEIVER_SELECTOR);
    return Boolean(receiver && top.element.contains(receiver));
  }

  private routeUnhandledEvent(event: Event): void {
    for (let index = this.pages.length - 1; index >= 0; index -= 1) {
      const page = this.pages[index];
      if (page.handleInputEvent?.(event)) {
        this.rejectEvent(event);
        return;
      }
      if (page.passUnhandledEvents !== true) {
        this.rejectEvent(event);
        return;
      }
    }

    this.baseEventHandler?.(event);
    this.rejectEvent(event);
  }

  private rejectEvent(event: Event): void {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  private hidePage(page: CommonUIPage): void {
    page.element.hidden = true;
    page.element.inert = true;
    page.element.setAttribute('inert', '');
    page.element.setAttribute('aria-hidden', 'true');
    page.element.classList.remove('is-common-ui-top', 'is-common-ui-covered');
  }

  private syncLayers(): void {
    const hasCommonUI = this.active && this.pages.length > 0;
    this.baseLayer.inert = !this.active || hasCommonUI;
    this.baseLayer.toggleAttribute('inert', !this.active || hasCommonUI);
    this.baseLayer.classList.toggle('is-input-blocked', hasCommonUI);
    this.overlayRoot.classList.toggle('has-common-ui', hasCommonUI);

    this.pages.forEach((page, index) => {
      const isTop = index === this.pages.length - 1;
      page.element.hidden = false;
      page.element.inert = !isTop;
      page.element.toggleAttribute('inert', !isTop);
      page.element.setAttribute('aria-hidden', String(!isTop));
      page.element.classList.toggle('is-common-ui-top', isTop);
      page.element.classList.toggle('is-common-ui-covered', !isTop);
    });

    for (const listener of this.listeners) listener(this.top, this.size);
  }
}

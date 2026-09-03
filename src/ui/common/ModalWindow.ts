import type { CommonUIPage } from './CommonUIPage';

export interface ModalWindowOptions {
  id: string;
  kicker?: string;
  title: string;
  description?: string;
  closeLabel?: string;
  closeOnEscape?: boolean;
  passUnhandledEvents?: boolean;
  showCloseButton?: boolean;
  size?: 'compact' | 'wide';
}

export class ModalWindow implements CommonUIPage {
  public readonly id: string;
  public readonly element: HTMLElement;
  public readonly bodyElement: HTMLElement;
  public readonly footerElement: HTMLElement;
  public readonly closeOnEscape: boolean;
  /** 标题在构造后还能改：容器界面要写当前这个箱子的名字，而不是一个泛称。 */
  protected readonly titleElement: HTMLElement;
  public readonly passUnhandledEvents: boolean;

  private closeHandler?: () => void;

  public constructor(options: ModalWindowOptions) {
    this.id = options.id;
    this.closeOnEscape = options.closeOnEscape ?? true;
    this.passUnhandledEvents = options.passUnhandledEvents ?? false;
    this.element = document.createElement('section');
    this.element.className = `common-ui-page modal-window modal-window--${options.size ?? 'compact'}`;
    this.element.dataset.commonUiId = options.id;
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');

    const header = document.createElement('header');
    header.className = 'modal-window__header';

    const heading = document.createElement('div');
    if (options.kicker) {
      const kicker = document.createElement('p');
      kicker.className = 'modal-window__kicker';
      kicker.textContent = options.kicker;
      heading.append(kicker);
    }

    const title = document.createElement('h2');
    title.textContent = options.title;
    const titleId = `${options.id}-title`;
    title.id = titleId;
    this.element.setAttribute('aria-labelledby', titleId);
    heading.append(title);
    this.titleElement = title;

    if (options.description) {
      const description = document.createElement('p');
      description.className = 'modal-window__description';
      description.textContent = options.description;
      heading.append(description);
    }
    header.append(heading);

    if (options.showCloseButton !== false) {
      const closeButton = document.createElement('button');
      closeButton.className = 'modal-window__close';
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', options.closeLabel ?? '关闭窗口');
      closeButton.textContent = '×';
      closeButton.addEventListener('click', () => this.requestClose());
      header.append(closeButton);
    }

    this.bodyElement = document.createElement('div');
    this.bodyElement.className = 'modal-window__body';
    this.footerElement = document.createElement('footer');
    this.footerElement.className = 'modal-window__footer';
    this.element.append(header, this.bodyElement, this.footerElement);
  }

  public onRequestClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  protected requestClose(): void {
    this.closeHandler?.();
  }
}

import { AdminUnauthorizedError } from './adminApi';
import { createElement, createPanelHeader } from './dom';

/**
 * 后台面板基类：一块纸面 + 标题栏 + 底部状态行。
 *
 * 错误分两类处理：会话失效（AdminUnauthorizedError）交给控制台退回登录页；
 * 其余错误留在本面板的状态行里，别的面板照常能用。面板自己从不把异常继续往上抛——
 * 刷新大多是在定时器或事件回调里发起的，抛出去只会变成没人接的 unhandledrejection。
 */
export abstract class AdminPanel {
  public readonly element = createElement('section', { className: 'admin-panel' });
  protected readonly actionsElement: HTMLElement;
  protected readonly bodyElement = createElement('div', { className: 'admin-panel__body' });
  private readonly statusElement = createElement('p', { className: 'admin-panel__status' });
  private unauthorizedHandler?: () => void;

  public constructor(
    public readonly id: string,
    public readonly label: string,
    title: string,
    description: string,
  ) {
    const { header, actions } = createPanelHeader(title, description);
    this.actionsElement = actions;
    this.element.append(header, this.bodyElement, this.statusElement);
    this.element.setAttribute('aria-label', title);
  }

  public abstract refresh(): Promise<void>;

  /** 面板切走时的清理钩子（默认什么都不做）。 */
  public deactivate(): void {}

  /** 由控制台注入：本面板遇到 401 时回到登录页。 */
  public onUnauthorized(handler: () => void): void {
    this.unauthorizedHandler = handler;
  }

  protected setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle('is-error', tone === 'error');
  }

  /** 包一次异步操作：会话失效交给控制台，其余错误写进状态行。 */
  protected async run(task: () => Promise<void>, failureMessage: string): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (this.reportUnauthorized(error)) return;
      this.setStatus(`${failureMessage}：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  /** 会话失效则通知控制台并返回 true，调用方据此跳过自己的错误提示。 */
  protected reportUnauthorized(error: unknown): boolean {
    if (!(error instanceof AdminUnauthorizedError)) return false;
    this.unauthorizedHandler?.();
    return true;
  }
}

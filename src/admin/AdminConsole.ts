import { adminApi, AdminUnauthorizedError } from './adminApi';
import type { AdminPanel } from './AdminPanel';
import { createButton, createElement, createField } from './dom';
import { LogsPanel } from './panels/LogsPanel';
import { OverviewPanel } from './panels/OverviewPanel';
import { RoomsPanel } from './panels/RoomsPanel';
import { ScenesPanel } from './panels/ScenesPanel';
import { SettingsPanel } from './panels/SettingsPanel';

const AUTO_REFRESH_MS = 5000;

/**
 * 运维后台控制台：登录页与面板壳子。
 *
 * 面板只管自己那一屏的数据，控制台负责三件事：登录态、当前显示哪个面板、以及自动刷新节奏。
 * 自动刷新只刷**当前可见**的那个面板：后台常年开在一块屏幕上，
 * 每 5 秒把五个面板全拉一遍等于给自己的服务器加一个恒定负载。
 */
export class AdminConsole {
  private readonly root: HTMLElement;
  private readonly loginView = createElement('section', { className: 'admin-login' });
  private readonly loginStatus = createElement('p', { className: 'admin-panel__status' });
  private readonly passwordInput = createElement('input', { className: 'admin-input' });
  private readonly shellView = createElement('div', { className: 'admin-shell' });
  private readonly tabBar = createElement('nav', { className: 'admin-tabs', attributes: { 'aria-label': '后台分区' } });
  private readonly panelHost = createElement('div', { className: 'admin-panel-host' });
  private readonly panels: AdminPanel[] = [
    new OverviewPanel(),
    new RoomsPanel(),
    new ScenesPanel(),
    new LogsPanel(),
    new SettingsPanel(),
  ];
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private activePanel?: AdminPanel;
  private refreshTimer?: number;

  public constructor(root: HTMLElement) {
    this.root = root;
    this.root.append(this.buildLoginView(), this.buildShellView());
    for (const panel of this.panels) panel.onUnauthorized(() => this.showLogin('后台登录已过期，请重新登录。'));
  }

  /** 启动：先问服务端「后台开没开、我登录了没」，据此直接进面板或停在登录页。 */
  public async start(): Promise<void> {
    try {
      const session = await adminApi.session();
      if (!session.enabled) {
        this.showLogin('后台未启用：请在服务端配置 SKYLAND_ADMIN_PASSWORD 后重启。', { disabled: true });
        return;
      }
      if (session.authenticated) {
        await this.showShell();
        return;
      }
      this.showLogin('');
    } catch (error) {
      this.showLogin(`无法连接后台服务：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildLoginView(): HTMLElement {
    const card = createElement('div', { className: 'admin-card admin-login__card' });
    card.append(
      createElement('p', { className: 'admin-kicker', text: 'SKYLAND OPERATIONS' }),
      createElement('h1', { text: '运维后台' }),
      createElement('p', { className: 'admin-panel__description', text: '仅限服务器管理员，登录态与玩家侧完全隔离。' }),
    );

    this.passwordInput.type = 'password';
    this.passwordInput.autocomplete = 'current-password';
    const submitButton = createButton('登录', 'primary');
    // 必须是 submit：否则按钮点下去不触发 form 的 submit，回车登录也失效。
    submitButton.type = 'submit';

    const form = createElement('form', { className: 'admin-login__form' });
    form.append(createField('管理口令', this.passwordInput), submitButton, this.loginStatus);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.login(submitButton);
    });

    card.append(form);
    this.loginView.append(card);
    return this.loginView;
  }

  private buildShellView(): HTMLElement {
    const header = createElement('header', { className: 'admin-topbar' });
    const titles = createElement('div');
    titles.append(
      createElement('p', { className: 'admin-kicker', text: 'SKYLAND OPERATIONS' }),
      createElement('h1', { text: '运维后台' }),
    );

    const logoutButton = createButton('退出登录');
    logoutButton.addEventListener('click', () => void this.logout());

    const openGameLink = createElement('a', { className: 'paper-button paper-button--quiet', text: '打开游戏' });
    openGameLink.href = '/';

    const tools = createElement('div', { className: 'admin-topbar__tools' });
    tools.append(openGameLink, logoutButton);
    header.append(titles, tools);

    for (const panel of this.panels) {
      const tab = createElement('button', { className: 'admin-tab', text: panel.label });
      tab.type = 'button';
      tab.addEventListener('click', () => void this.activate(panel.id));
      this.tabButtons.set(panel.id, tab);
      this.tabBar.append(tab);
    }

    this.shellView.append(header, this.tabBar, this.panelHost);
    this.shellView.hidden = true;
    return this.shellView;
  }

  private async login(trigger: HTMLButtonElement): Promise<void> {
    trigger.disabled = true;
    this.setLoginStatus('正在登录…');
    try {
      await adminApi.login(this.passwordInput.value);
      this.passwordInput.value = '';
      await this.showShell();
    } catch (error) {
      const message = error instanceof AdminUnauthorizedError ? '口令错误' : String((error as Error).message ?? error);
      this.setLoginStatus(message, 'error');
    } finally {
      trigger.disabled = false;
    }
  }

  private async logout(): Promise<void> {
    try {
      await adminApi.logout();
    } catch {
      // 退出失败也照样回登录页：会话票要么已经没了，要么会自己过期。
    }
    this.showLogin('已退出登录。');
  }

  private async showShell(): Promise<void> {
    this.loginView.hidden = true;
    this.shellView.hidden = false;
    await this.activate(this.activePanel?.id ?? this.panels[0]!.id);
  }

  private showLogin(message: string, options: { disabled?: boolean } = {}): void {
    this.stopAutoRefresh();
    this.activePanel?.deactivate();
    this.activePanel = undefined;
    this.shellView.hidden = true;
    this.loginView.hidden = false;
    this.passwordInput.disabled = options.disabled === true;
    this.setLoginStatus(message, options.disabled === true ? 'error' : 'info');
  }

  private setLoginStatus(message: string, tone: 'info' | 'error' = 'info'): void {
    this.loginStatus.textContent = message;
    this.loginStatus.classList.toggle('is-error', tone === 'error');
  }

  private async activate(panelId: string): Promise<void> {
    const panel = this.panels.find((candidate) => candidate.id === panelId) ?? this.panels[0]!;
    if (this.activePanel && this.activePanel !== panel) this.activePanel.deactivate();
    this.activePanel = panel;

    for (const [id, tab] of this.tabButtons) {
      tab.setAttribute('aria-pressed', String(id === panel.id));
    }
    this.panelHost.replaceChildren(panel.element);
    this.startAutoRefresh();
    await panel.refresh();
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshTimer = window.setInterval(() => {
      // 页面在后台标签页时不刷：既省服务器，也免得切回来时补一串堆积的请求。
      if (document.hidden || !this.activePanel) return;
      void this.activePanel.refresh();
    }, AUTO_REFRESH_MS);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

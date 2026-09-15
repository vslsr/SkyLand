import { adminApi, type AdminLogEntry, type AdminLogLevel } from '../adminApi';
import { AdminPanel } from '../AdminPanel';
import { createButton, createElement, createField } from '../dom';
import { formatClock, logLevelLabel } from '../adminFormat';

const LEVELS: Array<{ value: AdminLogLevel | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
];

/**
 * 服务器日志：网关进程的 console 输出（固定容量的环形缓冲）。
 * 房间进程的输出直接继承到终端，不在这里；房间异常退出由父进程记一条，能看到。
 */
export class LogsPanel extends AdminPanel {
  private readonly levelSelect = createElement('select', { className: 'admin-input' });
  private readonly queryInput = createElement('input', { className: 'admin-input' });
  private readonly console = createElement('div', { className: 'admin-console', attributes: { role: 'log' } });
  private readonly emptyNotice = createElement('p', { className: 'admin-note', text: '没有匹配的日志。' });
  private pinnedToBottom = true;

  public constructor() {
    super('logs', '服务器日志', '服务器日志', '网关进程最近的日志，重启后清空。');

    for (const level of LEVELS) {
      this.levelSelect.append(createElement('option', { text: level.label, attributes: { value: level.value } }));
    }
    this.levelSelect.addEventListener('change', () => void this.refresh());

    this.queryInput.type = 'search';
    this.queryInput.placeholder = '按关键字过滤';
    this.queryInput.addEventListener('change', () => void this.refresh());

    const refreshButton = createButton('刷新');
    refreshButton.addEventListener('click', () => void this.refresh());
    this.actionsElement.append(refreshButton);

    const toolbar = createElement('div', { className: 'admin-toolbar' });
    toolbar.append(createField('级别', this.levelSelect), createField('关键字', this.queryInput));

    // 用户往回翻历史时不再自动贴底，否则每次刷新都把他拽回最新一行。
    this.console.addEventListener('scroll', () => {
      const distance = this.console.scrollHeight - this.console.scrollTop - this.console.clientHeight;
      this.pinnedToBottom = distance < 24;
    });

    this.bodyElement.append(toolbar, this.console, this.emptyNotice);
  }

  public async refresh(): Promise<void> {
    await this.run(async () => {
      const level = this.levelSelect.value as AdminLogLevel | 'all';
      const { entries, total, capacity } = await adminApi.logs(level, this.queryInput.value.trim());
      this.console.replaceChildren(...entries.map((entry) => this.createRow(entry)));
      this.emptyNotice.hidden = entries.length > 0;
      if (this.pinnedToBottom) this.console.scrollTop = this.console.scrollHeight;
      this.setStatus(`显示 ${entries.length} / ${total} 条 · 缓冲容量 ${capacity} 条`);
    }, '读取日志失败');
  }

  private createRow(entry: AdminLogEntry): HTMLElement {
    const row = createElement('p', { className: `admin-console__line is-${entry.level}` });
    row.append(
      createElement('time', { className: 'admin-console__time', text: formatClock(entry.time) }),
      createElement('span', { className: 'admin-console__level', text: logLevelLabel(entry.level) }),
      createElement('span', { className: 'admin-console__message', text: entry.message }),
    );
    return row;
  }
}

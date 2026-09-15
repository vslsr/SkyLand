import { adminApi, type AdminConnection } from '../adminApi';
import { AdminPanel } from '../AdminPanel';
import { createButton, createElement } from '../dom';
import { formatTimestamp, formatUptime } from '../adminFormat';

/**
 * 在线玩家：一条 WebSocket 连接一行，含还停在大厅、没进房的那些。
 * 「断开」踢的是连接本身——先告诉对面为什么，再关掉传输。
 */
export class PlayersPanel extends AdminPanel {
  private readonly list = createElement('div', { className: 'admin-card-grid' });
  private readonly emptyNotice = createElement('p', { className: 'admin-note', text: '当前没有连接。' });

  public constructor() {
    super('players', '在线玩家', '在线玩家', '当前 WebSocket 连接；还没进房的也在里面。');
    const refreshButton = createButton('刷新');
    refreshButton.addEventListener('click', () => void this.refresh());
    this.actionsElement.append(refreshButton);
    this.bodyElement.append(this.list, this.emptyNotice);
  }

  public async refresh(): Promise<void> {
    await this.run(async () => {
      const { connections, inRoom } = await adminApi.connections();
      this.list.replaceChildren(...connections.map((connection) => this.createCard(connection)));
      this.emptyNotice.hidden = connections.length > 0;
      this.setStatus(`共 ${connections.length} 条连接 · 其中 ${inRoom} 条已进房`);
    }, '读取连接失败');
  }

  private createCard(connection: AdminConnection): HTMLElement {
    const card = createElement('article', { className: 'admin-card' });
    const head = createElement('div', { className: 'admin-card__head' });
    head.append(
      createElement('h3', { text: connection.playerName ?? '（大厅中，未进房）' }),
      createElement('span', {
        className: 'admin-card__badge',
        text: connection.roomId === null ? '大厅' : `席位 ${(connection.slot ?? 0) + 1}`,
      }),
    );

    const meta = createElement('dl', { className: 'admin-card__meta' });
    const rows: Array<[string, string]> = [
      ['房间', connection.roomName ? `${connection.roomName}（${connection.sceneName ?? '—'}）` : '—'],
      ['来源', connection.remoteAddress],
      ['连接于', formatTimestamp(connection.connectedAt)],
      ['在线时长', formatUptime(connection.onlineSeconds)],
      ['进房于', formatTimestamp(connection.joinedAt)],
      ['连接 ID', connection.id],
    ];
    if (connection.recordingTransformLog) rows.push(['诊断', '正在录 Transform 日志']);
    for (const [term, value] of rows) {
      meta.append(createElement('dt', { text: term }), createElement('dd', { text: value }));
    }

    const kickButton = createButton('断开连接', 'danger');
    kickButton.addEventListener('click', () => void this.kick(connection, kickButton));
    const footer = createElement('div', { className: 'admin-card__footer' });
    footer.append(kickButton);

    card.append(head, meta, footer);
    return card;
  }

  private async kick(connection: AdminConnection, trigger: HTMLButtonElement): Promise<void> {
    const who = connection.playerName ?? connection.remoteAddress;
    if (!window.confirm(`确定断开「${who}」的连接吗？对方会看到被管理员断开的提示。`)) return;
    trigger.disabled = true;
    await this.run(async () => {
      await adminApi.kickConnection(connection.id);
      this.setStatus(`已断开「${who}」的连接`);
      await this.refresh();
    }, '断开连接失败');
    trigger.disabled = false;
  }
}

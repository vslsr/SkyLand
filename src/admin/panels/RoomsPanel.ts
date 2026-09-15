import { adminApi, type AdminRoom } from '../adminApi';
import { AdminPanel } from '../AdminPanel';
import { createButton, createElement } from '../dom';
import { describeRoomLimit, formatCountdown, formatTimestamp } from '../adminFormat';

/** 房间管理：列出所有运行中的房间进程，必要时手动关掉一个。 */
export class RoomsPanel extends AdminPanel {
  private readonly list = createElement('div', { className: 'admin-card-grid' });
  private readonly emptyNotice = createElement('p', { className: 'admin-note', text: '当前没有运行中的房间。' });

  public constructor() {
    super('rooms', '房间管理', '房间管理', '每个房间都是一个独立的房间进程，关闭会立刻断开房内玩家。');
    const refreshButton = createButton('刷新');
    refreshButton.addEventListener('click', () => void this.refresh());
    this.actionsElement.append(refreshButton);
    this.bodyElement.append(this.list, this.emptyNotice);
  }

  public async refresh(): Promise<void> {
    await this.run(async () => {
      const { rooms, maxRooms } = await adminApi.rooms();
      this.list.replaceChildren(...rooms.map((room) => this.createCard(room)));
      this.emptyNotice.hidden = rooms.length > 0;
      this.setStatus(`共 ${rooms.length} 个房间 · 上限 ${describeRoomLimit(maxRooms)}`);
    }, '读取房间失败');
  }

  private createCard(room: AdminRoom): HTMLElement {
    const card = createElement('article', { className: 'admin-card' });
    const head = createElement('div', { className: 'admin-card__head' });
    head.append(
      createElement('h3', { text: room.name }),
      createElement('span', { className: 'admin-card__badge', text: `${room.playerCount}/${room.capacity}` }),
    );

    const meta = createElement('dl', { className: 'admin-card__meta' });
    const rows: Array<[string, string]> = [
      ['地图', `${room.sceneName}（${room.sceneId}）`],
      ['世界种子', String(room.worldSeed)],
      ['创建于', formatTimestamp(room.createdAt)],
      ['空房回收', formatCountdown(room.idleExpiresAt)],
      ['房间 ID', room.id],
    ];
    for (const [term, value] of rows) {
      meta.append(
        createElement('dt', { text: term }),
        createElement('dd', { text: value }),
      );
    }

    const players = createElement('p', {
      className: 'admin-card__players',
      text: room.players.length > 0
        ? room.players.map((player) => `${player.slot + 1}. ${player.name}`).join(' · ')
        : '房内暂无玩家',
    });

    const closeButton = createButton('关闭房间', 'danger');
    closeButton.addEventListener('click', () => void this.closeRoom(room, closeButton));

    const footer = createElement('div', { className: 'admin-card__footer' });
    footer.append(closeButton);
    card.append(head, meta, players, footer);
    return card;
  }

  private async closeRoom(room: AdminRoom, trigger: HTMLButtonElement): Promise<void> {
    const occupancy = room.playerCount > 0 ? `房内还有 ${room.playerCount} 名玩家，` : '';
    if (!window.confirm(`${occupancy}确定关闭房间「${room.name}」吗？`)) return;
    trigger.disabled = true;
    await this.run(async () => {
      await adminApi.closeRoom(room.id);
      this.setStatus(`已关闭房间「${room.name}」`);
      await this.refresh();
    }, '关闭房间失败');
    trigger.disabled = false;
  }
}

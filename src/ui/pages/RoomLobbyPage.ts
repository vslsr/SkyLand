import type { RoomSummary } from '../../network/RoomClient';
import { ModalWindow } from '../common/ModalWindow';

type JoinHandler = (room: RoomSummary, temporaryName: string) => void;

function createTemporaryName(): string {
  return `旅人-${Math.floor(1000 + Math.random() * 9000)}`;
}

export class RoomLobbyPage extends ModalWindow {
  private readonly roomGrid = document.createElement('div');
  private readonly statusElement = document.createElement('p');
  private readonly nameInput = document.createElement('input');
  private readonly refreshButton = document.createElement('button');
  private readonly createButton = document.createElement('button');
  private joinHandler?: JoinHandler;
  private createHandler?: (temporaryName: string) => void;
  private refreshHandler?: () => void;

  public constructor() {
    super({
      id: 'room-lobby',
      kicker: 'SKYLAND NETWORK',
      title: '选择房间',
      description: '使用临时名称进入一个独立运行的场景房间。',
      closeOnEscape: false,
      showCloseButton: false,
      size: 'wide',
    });
    this.element.classList.add('room-lobby');

    const toolbar = document.createElement('div');
    toolbar.className = 'room-toolbar';

    const nameField = document.createElement('label');
    nameField.className = 'field-control field-control--inline';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '临时名称';
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 20;
    this.nameInput.value = createTemporaryName();
    this.nameInput.autocomplete = 'off';
    nameField.append(nameLabel, this.nameInput);

    this.refreshButton.className = 'paper-button paper-button--quiet';
    this.refreshButton.type = 'button';
    this.refreshButton.textContent = '刷新';
    this.refreshButton.addEventListener('click', () => this.refreshHandler?.());
    toolbar.append(nameField, this.refreshButton);

    this.roomGrid.className = 'room-grid';
    this.roomGrid.setAttribute('aria-label', '房间列表');
    this.statusElement.className = 'room-list-status';
    this.bodyElement.append(toolbar, this.roomGrid, this.statusElement);

    this.createButton.className = 'paper-button paper-button--primary';
    this.createButton.type = 'button';
    this.createButton.innerHTML = '<span>＋</span> 创建新房间';
    this.createButton.addEventListener('click', () => this.createHandler?.(this.getTemporaryName()));
    this.footerElement.append(this.createButton);
  }

  public onJoin(handler: JoinHandler): void {
    this.joinHandler = handler;
  }

  public onCreate(handler: (temporaryName: string) => void): void {
    this.createHandler = handler;
  }

  public onRefresh(handler: () => void): void {
    this.refreshHandler = handler;
  }

  public setLoading(loading: boolean): void {
    this.refreshButton.disabled = loading;
    this.statusElement.textContent = loading ? '正在读取房间…' : '';
    if (loading) this.roomGrid.replaceChildren();
  }

  public setError(message: string): void {
    this.statusElement.textContent = message;
    this.statusElement.classList.add('is-error');
  }

  public setRooms(rooms: RoomSummary[]): void {
    this.statusElement.classList.remove('is-error');
    this.statusElement.textContent = rooms.length === 0 ? '现在还没有房间，创建第一个吧。' : '';
    this.roomGrid.replaceChildren(...rooms.map((room) => this.createRoomCard(room)));
    this.refreshButton.disabled = false;
  }

  public setBusy(busy: boolean, message = ''): void {
    this.createButton.disabled = busy;
    this.refreshButton.disabled = busy;
    this.nameInput.disabled = busy;
    for (const button of this.roomGrid.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = busy || button.dataset.full === 'true';
    }
    this.statusElement.textContent = message;
  }

  public getTemporaryName(): string {
    return this.nameInput.value.trim() || createTemporaryName();
  }

  private createRoomCard(room: RoomSummary): HTMLButtonElement {
    const full = room.playerCount >= room.capacity;
    const card = document.createElement('button');
    card.className = 'room-card';
    card.type = 'button';
    card.disabled = full;
    card.dataset.full = String(full);

    const index = document.createElement('span');
    index.className = 'room-card__index';
    index.textContent = room.id.slice(0, 4).toUpperCase();

    const name = document.createElement('strong');
    name.className = 'room-card__name';
    name.textContent = room.name;

    const meta = document.createElement('span');
    meta.className = 'room-card__meta';
    meta.textContent = `${room.playerCount} / ${room.capacity} 人`;

    const action = document.createElement('span');
    action.className = 'room-card__action';
    action.textContent = full ? '已满' : '加入 →';
    card.append(index, name, meta, action);
    card.addEventListener('click', () => this.joinHandler?.(room, this.getTemporaryName()));
    return card;
  }
}

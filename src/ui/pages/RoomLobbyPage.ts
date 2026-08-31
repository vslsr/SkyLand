import type { RoomSummary } from '../../network/RoomClient';
import { createTemporaryName } from '../../../shared/temporaryName.mjs';
import { ModalWindow } from '../common/ModalWindow';

type JoinHandler = (room: RoomSummary, temporaryName: string) => void;

export class RoomLobbyPage extends ModalWindow {
  private readonly roomGrid = document.createElement('div');
  private readonly statusElement = document.createElement('p');
  private readonly nameInput = document.createElement('input');
  private readonly refreshButton = document.createElement('button');
  private readonly createButton = document.createElement('button');
  private joinHandler?: JoinHandler;
  private createHandler?: (temporaryName: string) => void;
  private refreshHandler?: () => void;
  private readonly expiredRoomRefreshes = new Set<string>();

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
    window.setInterval(() => this.updateIdleCountdowns(), 250);
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
    this.createButton.disabled = loading;
    this.statusElement.classList.remove('is-error');
    this.statusElement.textContent = loading ? '正在读取房间…' : '';
    if (loading) this.roomGrid.replaceChildren();
  }

  public setError(message: string): void {
    this.statusElement.textContent = message;
    this.statusElement.classList.add('is-error');
    // 请求失败后必须允许重试；创建按钮继续保持禁用，避免把连接故障误报为场景配置为空。
    this.refreshButton.disabled = false;
  }

  public setRooms(rooms: RoomSummary[]): void {
    this.expiredRoomRefreshes.clear();
    this.statusElement.classList.remove('is-error');
    this.statusElement.textContent = rooms.length === 0 ? '现在还没有房间，创建第一个吧。' : '';
    this.roomGrid.replaceChildren(...rooms.map((room) => this.createRoomCard(room)));
    this.refreshButton.disabled = false;
    this.createButton.disabled = false;
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
    meta.textContent = `${room.sceneName} · ${room.playerCount} / ${room.capacity} 人`;

    const countdown = document.createElement('span');
    countdown.className = 'room-card__countdown';
    countdown.dataset.roomId = room.id;
    if (room.idleExpiresAt) countdown.dataset.idleExpiresAt = room.idleExpiresAt;
    countdown.textContent = room.idleExpiresAt ? this.formatIdleCountdown(room.idleExpiresAt) : '房间使用中';

    const action = document.createElement('span');
    action.className = 'room-card__action';
    action.textContent = full ? '已满' : '加入 →';
    card.append(index, name, meta, countdown, action);
    card.addEventListener('click', () => this.joinHandler?.(room, this.getTemporaryName()));
    return card;
  }

  private updateIdleCountdowns(): void {
    for (const element of this.roomGrid.querySelectorAll<HTMLElement>('[data-idle-expires-at]')) {
      const expiresAt = element.dataset.idleExpiresAt;
      const roomId = element.dataset.roomId;
      if (!expiresAt || !roomId) continue;
      element.textContent = this.formatIdleCountdown(expiresAt);
      if (Date.parse(expiresAt) <= Date.now() && !this.expiredRoomRefreshes.has(roomId)) {
        this.expiredRoomRefreshes.add(roomId);
        this.refreshHandler?.();
      }
    }
  }

  private formatIdleCountdown(expiresAt: string): string {
    const remainingSeconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = String(remainingSeconds % 60).padStart(2, '0');
    return remainingSeconds > 0 ? `空置回收 ${minutes}:${seconds}` : '正在回收…';
  }
}

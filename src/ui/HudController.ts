import type { RoomSummary } from '../network/RoomClient';

export class HudController {
  private readonly lockHint: HTMLElement;
  private readonly roomLabel: HTMLElement;
  private readonly roomPopulation: HTMLElement;
  private controlMode: 'fly' | 'topdown' = 'fly';

  public constructor() {
    this.lockHint = this.requireElement<HTMLElement>('lock-hint');
    this.roomLabel = this.requireElement<HTMLElement>('room-label');
    this.roomPopulation = this.requireElement<HTMLElement>('room-population');
  }

  public setRoom(room: RoomSummary): void {
    this.roomLabel.textContent = room.name;
    this.roomPopulation.textContent = `${room.playerCount}/${room.capacity}`;
  }

  public setDisconnected(): void {
    this.roomLabel.textContent = '未连接房间';
    this.roomPopulation.textContent = 'OFFLINE';
  }

  public setLocked(locked: boolean): void {
    document.body.classList.toggle('is-locked', locked);
    if (this.controlMode === 'fly') {
      this.lockHint.textContent = locked ? 'Esc · 释放鼠标' : '点击画面控制镜头';
    }
  }

  public setControlMode(mode: 'fly' | 'topdown'): void {
    this.controlMode = mode;
    document.body.classList.toggle('is-topdown', mode === 'topdown');
    if (mode === 'topdown') {
      document.body.classList.remove('is-locked');
      this.lockHint.textContent = 'WASD · 移动　鼠标 · 朝向';
    } else {
      this.lockHint.textContent = '点击画面控制镜头';
    }
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element as T;
  }
}

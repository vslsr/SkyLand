import type { RoomSummary } from '../network/RoomClient';
import type { InputDeviceKind } from '../input/index';

export class HudController {
  private readonly lockHint: HTMLElement;
  private readonly roomLabel: HTMLElement;
  private readonly roomPopulation: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private menuHandler?: () => void;
  private inputDeviceKind: InputDeviceKind = 'keyboardMouse';
  private locked = false;
  private controlMode: 'fly' | 'topdown' = 'fly';

  public constructor() {
    this.lockHint = this.requireElement<HTMLElement>('lock-hint');
    this.roomLabel = this.requireElement<HTMLElement>('room-label');
    this.roomPopulation = this.requireElement<HTMLElement>('room-population');
    this.menuButton = this.requireElement<HTMLButtonElement>('game-menu-button');
    this.menuButton.addEventListener('click', () => this.menuHandler?.());
  }

  public onMenuRequest(handler: () => void): void {
    this.menuHandler = handler;
  }

  public setRoom(room: RoomSummary): void {
    this.roomLabel.textContent = room.name;
    this.roomPopulation.textContent = `${room.playerCount}/${room.capacity}`;
    this.menuButton.hidden = false;
  }

  public setDisconnected(): void {
    this.roomLabel.textContent = '未连接房间';
    this.roomPopulation.textContent = 'OFFLINE';
    this.menuButton.hidden = true;
  }

  public setLocked(locked: boolean): void {
    this.locked = locked;
    document.body.classList.toggle('is-locked', locked);
    this.refreshControlHint();
  }

  public setControlMode(mode: 'fly' | 'topdown'): void {
    this.controlMode = mode;
    document.body.classList.toggle('is-topdown', mode === 'topdown');
    if (mode === 'topdown') {
      document.body.classList.remove('is-locked');
      this.locked = false;
    }
    this.refreshControlHint();
  }

  public setInputDevice(deviceKind: InputDeviceKind): void {
    this.inputDeviceKind = deviceKind;
    this.refreshControlHint();
  }

  private refreshControlHint(): void {
    if (this.controlMode === 'fly') {
      this.lockHint.textContent = this.locked
        ? 'WASD · 移动　空格/C · 升降　Shift · 加速　Esc · 释放鼠标'
        : '点击画面 · WASD 自由镜头';
      return;
    }

    if (this.inputDeviceKind === 'touch') {
      this.lockHint.textContent = '触摸摇杆 · 移动　RUN · 加速';
    } else if (this.inputDeviceKind === 'gamepad') {
      this.lockHint.textContent = '左摇杆/D-Pad · 移动　L3 · 加速';
    } else {
      this.lockHint.textContent = 'WASD · 移动　鼠标 · 朝向';
    }
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element as T;
  }
}

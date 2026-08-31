import type { RoomSummary } from '../network/RoomClient';
import type { InputDeviceKind } from '../input/index';

export type InputPromptResolver = (
  mode: 'fly' | 'topdown',
  deviceKind: InputDeviceKind,
  state: 'locked' | 'unlocked',
) => string;

export class HudController {
  private readonly lockHint: HTMLElement;
  private readonly roomLabel: HTMLElement;
  private readonly roomPopulation: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private menuHandler?: () => void;
  private inputDeviceKind: InputDeviceKind = 'keyboardMouse';
  private locked = false;
  private controlMode: 'fly' | 'topdown' = 'fly';
  private promptResolver?: InputPromptResolver;

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

  public setInputPromptResolver(resolver: InputPromptResolver): void {
    this.promptResolver = resolver;
    this.refreshInputPrompt();
  }

  public refreshInputPrompt(): void {
    this.refreshControlHint();
  }

  private refreshControlHint(): void {
    this.lockHint.textContent = this.promptResolver?.(
      this.controlMode,
      this.inputDeviceKind,
      this.locked ? 'locked' : 'unlocked',
    ) ?? '';
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element as T;
  }
}

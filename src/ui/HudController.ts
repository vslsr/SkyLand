import type { RoomSummary } from '../network/RoomClient';
import type { VesselHudState } from '../scene/SceneVisualSystem';

export class HudController {
  private readonly roomLabel: HTMLElement;
  private readonly roomPopulation: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly vesselStatus: HTMLElement;
  private readonly vesselSpeed: HTMLElement;
  private readonly vesselLoad: HTMLElement;
  private readonly vesselCondition: HTMLElement;
  private readonly vesselEvent: HTMLElement;
  private readonly interactionPrompt: HTMLElement;
  private menuHandler?: () => void;
  private vesselEventRevision = 0;
  private interactionPromptText = '';
  private interactionPromptOpacity = 0;

  public constructor() {
    this.roomLabel = this.requireElement<HTMLElement>('room-label');
    this.roomPopulation = this.requireElement<HTMLElement>('room-population');
    this.menuButton = this.requireElement<HTMLButtonElement>('game-menu-button');
    this.vesselStatus = this.requireElement<HTMLElement>('vessel-status');
    this.vesselSpeed = this.requireElement<HTMLElement>('vessel-speed');
    this.vesselLoad = this.requireElement<HTMLElement>('vessel-load');
    this.vesselCondition = this.requireElement<HTMLElement>('vessel-condition');
    this.vesselEvent = this.requireElement<HTMLElement>('vessel-event');
    this.interactionPrompt = this.requireElement<HTMLElement>('interaction-prompt');
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
    this.setVesselStatus(undefined);
    this.setInteractionPrompt(undefined);
  }

  public setLocked(locked: boolean): void {
    document.body.classList.toggle('is-locked', locked);
  }

  public setControlMode(mode: 'fly' | 'topdown'): void {
    document.body.classList.toggle('is-topdown', mode === 'topdown');
    if (mode === 'topdown') document.body.classList.remove('is-locked');
  }

  public setVesselStatus(state: VesselHudState | undefined): void {
    this.vesselStatus.hidden = !state;
    if (!state) {
      this.vesselEventRevision = 0;
      this.vesselEvent.textContent = '';
      return;
    }
    const floatLabels = {
      afloat: '正常',
      overloaded: '超载',
      flooding: '进水',
      sinking: '沉没',
    } as const;
    this.vesselSpeed.textContent = `航速 ${Math.abs(state.speed).toFixed(1)} m/s`;
    this.vesselLoad.textContent = `载重 ${Math.round(state.cargoMass)} kg`;
    this.vesselCondition.textContent = `状态 ${floatLabels[state.floatState]} · 受损 ${state.damagedPartCount}`;
    if (state.eventRevision > this.vesselEventRevision && state.lastEvent) {
      const eventLabels = {
        'cargo:add': '货物已装载',
        'cargo:remove': '货物已卸载',
        damage: '船体受到损伤',
        'structure:add': '船体已扩建',
        'structure:remove': '船上的件已拆除',
      } as const;
      this.vesselEvent.textContent = eventLabels[state.lastEvent.type];
      this.vesselEvent.classList.remove('is-updated');
      void this.vesselEvent.offsetWidth;
      this.vesselEvent.classList.add('is-updated');
    }
    this.vesselEventRevision = state.eventRevision;
  }

  /**
   * 交互提示的文字与淡入淡出进度。每帧都会被调用，所以两段状态都先比再写：
   * 改 `textContent` 会让浏览器重排这块 HUD，`opacity` 只是合成，代价差一个量级。
   *
   * 准星那圈高亮跟的是「有没有瞄到目标」，不跟淡入淡出——它是瞄准反馈，不是提示。
   */
  public setInteractionPrompt(text: string | undefined, opacity = 1): void {
    const label = text ?? '';
    // 没有文字就是没有提示：这时不透明度一律按 0 记，`hidden` 才不会漏关。
    const promptOpacity = label ? Math.min(1, Math.max(0, opacity)) : 0;
    if (label !== this.interactionPromptText) {
      this.interactionPromptText = label;
      this.interactionPrompt.textContent = label;
      document.body.classList.toggle('has-interaction-target', Boolean(label));
    }
    if (promptOpacity === this.interactionPromptOpacity) return;
    this.interactionPromptOpacity = promptOpacity;
    this.interactionPrompt.style.opacity = promptOpacity.toFixed(3);
    this.interactionPrompt.hidden = promptOpacity <= 0;
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element as T;
  }
}

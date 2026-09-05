import type {
  VirtualAimJoystickDefinition,
  VirtualControlLayoutDefinition,
} from '../config/InputSchemeTypes';
import type { VirtualInputDevice } from '../devices/VirtualInputDevice';
import {
  clampVirtualJoystickCenter,
  isVirtualAimCharging,
  sampleVirtualJoystick,
} from './virtualJoystickMath';

/**
 * 右手边那根**分两层**的瞄准摇杆（设计稿「工具、武器使用流程」的移动端那一条）。
 *
 * 内层只管朝向：推着它转，角色就朝那个方向——和 PC 端鼠标在地面上那个投影点是
 * 同一件事，只是来源不同。推进外层那一圈才开始蓄力，松手就是发射。
 *
 * 蓄力那一下发的是**主手使用键**（`chargeControl` → `IA_Player_Primary`），不是
 * 另一条新的输入语义：这样触屏上的「按下、蓄力、松手」和鼠标左键走的是同一条
 * 路径，物品栏那圈倒计时、服务端那次激活都不需要知道这一下是从哪来的。
 *
 * 摇杆是浮动的：按下哪儿哪儿就是圆心。固定圆心在触屏上意味着玩家得先找到它，
 * 而瞄准时眼睛在屏幕中间。
 */
export class VirtualAimStick {
  public readonly zone: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly knob: HTMLElement;
  private pointerId?: number;
  private centerX = 0;
  private centerY = 0;
  private layoutScale = 1;
  private charging = false;

  public constructor(
    private readonly config: VirtualAimJoystickDefinition,
    private readonly device: VirtualInputDevice,
    signal: AbortSignal,
  ) {
    this.zone = document.createElement('div');
    this.zone.id = 'virtual-aim-stick-zone';
    this.zone.className = 'virtual-joystick-zone virtual-joystick-zone--floating virtual-aim-zone';
    this.zone.setAttribute('role', 'group');
    this.zone.setAttribute('aria-label', '瞄准摇杆');

    this.stick = document.createElement('div');
    this.stick.id = 'virtual-aim-stick';
    this.stick.className = 'virtual-stick virtual-stick--aim';
    this.stick.setAttribute('aria-hidden', 'true');

    // 内层那一圈画出来：玩家要看得见「推到哪儿开始蓄力」，否则那条界线只存在于代码里。
    this.inner = document.createElement('span');
    this.inner.className = 'virtual-stick__inner-ring';
    this.inner.setAttribute('aria-hidden', 'true');

    this.knob = document.createElement('span');
    this.knob.id = 'virtual-aim-stick-knob';
    this.knob.className = 'virtual-stick__knob';
    this.knob.setAttribute('aria-hidden', 'true');

    this.stick.append(this.inner, this.knob);
    this.zone.append(this.stick);

    this.zone.addEventListener('pointerdown', this.handlePointerDown, { signal });
    this.zone.addEventListener('pointermove', this.handlePointerMove, { signal });
    this.zone.addEventListener('pointerup', this.handlePointerEnd, { signal });
    this.zone.addEventListener('pointercancel', this.handlePointerEnd, { signal });
    this.zone.addEventListener('lostpointercapture', this.handlePointerEnd, { signal });
  }

  /** 收手。松开蓄力这一步不能省：抬起来的那一下就是发射，漏掉会让弓一直拉着。 */
  public reset(timeStamp = performance.now()): void {
    this.pointerId = undefined;
    this.setKnobOffset(0, 0);
    this.zone.classList.remove('is-active');
    this.zone.classList.remove('is-charging');
    this.stick.style.left = '50%';
    this.stick.style.top = '50%';
    this.device.setAxis2D(this.config.control, { x: 0, y: 0 }, timeStamp);
    if (this.charging) {
      this.charging = false;
      this.device.setDigital(this.config.chargeControl, false, timeStamp);
    }
  }

  public applyLayout(layout: VirtualControlLayoutDefinition): void {
    this.layoutScale = layout.scale;
    const baseDiameter = this.config.baseRadiusPx * 2 * layout.scale;
    const innerDiameter = this.config.innerRadiusPx * 2 * layout.scale;
    const knobDiameter = this.config.knobRadiusPx * 2 * layout.scale;
    this.stick.style.width = `${baseDiameter}px`;
    this.stick.style.height = `${baseDiameter}px`;
    this.inner.style.width = `${innerDiameter}px`;
    this.inner.style.height = `${innerDiameter}px`;
    this.knob.style.width = `${knobDiameter}px`;
    this.knob.style.height = `${knobDiameter}px`;
    this.zone.style.right = `calc(env(safe-area-inset-right, 0px) + ${layout.edgeInsetPx}px)`;
    this.zone.style.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${layout.bottomInsetPx}px)`;
    this.zone.style.width = `calc(${this.config.activationWidthRatio * 100}vw - env(safe-area-inset-right, 0px) - ${layout.edgeInsetPx}px)`;
    this.zone.style.height = `calc(${this.config.activationHeightRatio * 100}vh - env(safe-area-inset-bottom, 0px) - ${layout.bottomInsetPx}px)`;
    this.stick.style.left = '50%';
    this.stick.style.top = '50%';
  }

  public get active(): boolean {
    return this.pointerId !== undefined;
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (
      this.pointerId !== undefined
      || (event.pointerType === 'mouse' && event.button !== 0)
      || event.defaultPrevented
      // 按钮簇压在这块热区上面，那一指由按钮自己消耗；这里只接落在空处的。
      || !(event.target === this.zone || this.stick.contains(event.target as Node | null))
    ) return;
    event.preventDefault();
    event.stopPropagation();
    this.pointerId = event.pointerId;
    this.zone.setPointerCapture(event.pointerId);
    this.zone.classList.add('is-active');

    const rect = this.zone.getBoundingClientRect();
    const center = clampVirtualJoystickCenter(
      event.clientX - rect.left,
      event.clientY - rect.top,
      { width: rect.width, height: rect.height, margin: this.config.baseRadiusPx * this.layoutScale },
    );
    this.centerX = center.x;
    this.centerY = center.y;
    this.stick.style.left = `${center.x}px`;
    this.stick.style.top = `${center.y}px`;
    this.update(event, rect);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.update(event);
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    // 松手就是发射：抬起 `chargeControl` 那一下由 reset 发出去。
    this.reset(event.timeStamp);
  };

  private update(event: PointerEvent, currentRect?: DOMRect): void {
    const rect = currentRect ?? this.zone.getBoundingClientRect();
    const sample = sampleVirtualJoystick(
      event.clientX - rect.left - this.centerX,
      event.clientY - rect.top - this.centerY,
      this.config.travelRadiusPx * this.layoutScale,
      this.config.deadZone,
      this.config.sensitivity,
    );
    this.setKnobOffset(sample.offsetX, sample.offsetY);
    this.device.setAxis2D(this.config.control, sample.value, event.timeStamp);

    const charging = isVirtualAimCharging(
      Math.hypot(sample.value.x, sample.value.y),
      this.config.innerRadiusPx / Math.max(1, this.config.travelRadiusPx),
      this.charging,
    );
    if (charging === this.charging) return;
    this.charging = charging;
    this.zone.classList.toggle('is-charging', charging);
    this.device.setDigital(this.config.chargeControl, charging, event.timeStamp);
  }

  private setKnobOffset(x: number, y: number): void {
    this.knob.style.setProperty('--virtual-knob-x', `${x}px`);
    this.knob.style.setProperty('--virtual-knob-y', `${y}px`);
  }
}

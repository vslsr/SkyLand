import type {
  VirtualButtonDefinition,
  VirtualControlLayoutDefinition,
  VirtualControlsDefinition,
} from '../config/InputSchemeTypes';
import { VirtualInputDevice } from '../devices/VirtualInputDevice';
import {
  clampVirtualJoystickCenter,
  sampleVirtualJoystick,
} from './virtualJoystickMath';

export interface VirtualControlsOptions {
  readonly root: HTMLElement;
  readonly device: VirtualInputDevice;
  readonly config: VirtualControlsDefinition;
  /** 覆盖 URL 调试开关，主要用于测试或嵌入式宿主。 */
  readonly desktopDebug?: boolean;
}

interface DigitalButtonBinding {
  readonly definition: VirtualButtonDefinition;
  readonly element: HTMLButtonElement;
  pointerId?: number;
}

/** 配置驱动的固定/浮动虚拟摇杆和多指数字按钮。 */
export class VirtualControls {
  private readonly device: VirtualInputDevice;
  private readonly config: VirtualControlsDefinition;
  private readonly container: HTMLElement;
  private readonly joystickZone: HTMLElement;
  private readonly joystick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly buttonCluster: HTMLElement;
  private readonly buttons: readonly DigitalButtonBinding[];
  private readonly eventAbortController = new AbortController();
  private readonly portraitQuery = window.matchMedia('(orientation: portrait)');
  private joystickPointerId?: number;
  private joystickCenterX = 0;
  private joystickCenterY = 0;
  private layoutScale = 1;

  public constructor(options: VirtualControlsOptions) {
    this.device = options.device;
    this.config = options.config;
    this.container = this.requireElement<HTMLElement>(options.root, 'virtual-controls');
    this.joystickZone = this.createJoystickZone();
    this.joystick = this.createJoystick();
    this.knob = this.createKnob();
    this.buttonCluster = document.createElement('div');
    this.buttonCluster.className = 'virtual-buttons';
    this.buttons = this.config.buttons.map((definition) => this.createButton(definition));

    const guide = document.createElement('span');
    guide.className = 'virtual-stick__guide';
    guide.setAttribute('aria-hidden', 'true');
    this.joystick.append(guide, this.knob);
    this.joystickZone.append(this.joystick);
    this.buttonCluster.append(...this.buttons.map((binding) => binding.element));
    this.container.replaceChildren(this.joystickZone, this.buttonCluster);
    this.container.classList.toggle(
      'is-desktop-debug',
      options.desktopDebug ?? this.readDesktopDebugFlag(),
    );
    this.applyLayout();
    this.bindEvents();
  }

  public reset(): void {
    this.joystickPointerId = undefined;
    this.setKnobOffset(0, 0);
    this.joystickZone.classList.remove('is-active');
    if (this.config.joystick.mode === 'floating') this.resetFloatingBasePosition();
    for (const binding of this.buttons) {
      binding.pointerId = undefined;
      binding.element.classList.remove('is-active');
    }
    this.device.cancel();
  }

  public dispose(): void {
    this.eventAbortController.abort();
    this.reset();
    this.container.replaceChildren();
  }

  private createJoystickZone(): HTMLElement {
    const zone = document.createElement('div');
    zone.id = 'virtual-move-stick-zone';
    zone.className = `virtual-joystick-zone virtual-joystick-zone--${this.config.joystick.mode}`;
    zone.setAttribute('role', 'group');
    zone.setAttribute('aria-label', '移动摇杆');
    return zone;
  }

  private createJoystick(): HTMLElement {
    const joystick = document.createElement('div');
    joystick.id = 'virtual-move-stick';
    joystick.className = 'virtual-stick';
    joystick.setAttribute('aria-hidden', 'true');
    return joystick;
  }

  private createKnob(): HTMLElement {
    const knob = document.createElement('span');
    knob.id = 'virtual-move-stick-knob';
    knob.className = 'virtual-stick__knob';
    knob.setAttribute('aria-hidden', 'true');
    return knob;
  }

  private createButton(definition: VirtualButtonDefinition): DigitalButtonBinding {
    const element = document.createElement('button');
    element.id = `virtual-${definition.id}-button`;
    element.className = 'virtual-button';
    element.type = 'button';
    element.textContent = definition.label;
    element.setAttribute('aria-label', definition.ariaLabel);
    return { definition, element };
  }

  private bindEvents(): void {
    const signal = this.eventAbortController.signal;
    this.joystickZone.addEventListener('pointerdown', this.handleJoystickPointerDown, { signal });
    this.joystickZone.addEventListener('pointermove', this.handleJoystickPointerMove, { signal });
    this.joystickZone.addEventListener('pointerup', this.handleJoystickPointerEnd, { signal });
    this.joystickZone.addEventListener('pointercancel', this.handleJoystickPointerEnd, { signal });
    this.joystickZone.addEventListener('lostpointercapture', this.handleJoystickPointerEnd, { signal });

    for (const binding of this.buttons) {
      binding.element.addEventListener('pointerdown', (event) => {
        if (binding.pointerId !== undefined || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        event.stopPropagation();
        binding.pointerId = event.pointerId;
        binding.element.setPointerCapture(event.pointerId);
        binding.element.classList.add('is-active');
        this.device.setDigital(binding.definition.control, true, event.timeStamp);
      }, { signal });

      const release = (event: PointerEvent): void => {
        if (binding.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        binding.pointerId = undefined;
        binding.element.classList.remove('is-active');
        this.device.setDigital(binding.definition.control, false, event.timeStamp);
      };
      binding.element.addEventListener('pointerup', release, { signal });
      binding.element.addEventListener('pointercancel', release, { signal });
      binding.element.addEventListener('lostpointercapture', release, { signal });
    }

    this.container.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
    this.portraitQuery.addEventListener('change', this.handleLayoutChange, { signal });
    window.addEventListener('resize', this.handleLayoutChange, { signal });
    window.addEventListener('blur', this.handleFocusLoss, { signal });
    document.addEventListener('visibilitychange', this.handleVisibilityChange, { signal });
  }

  private readonly handleJoystickPointerDown = (event: PointerEvent): void => {
    if (
      this.joystickPointerId !== undefined
      || (event.pointerType === 'mouse' && event.button !== 0)
    ) return;
    event.preventDefault();
    event.stopPropagation();
    this.joystickPointerId = event.pointerId;
    this.joystickZone.setPointerCapture(event.pointerId);
    this.joystickZone.classList.add('is-active');

    const rect = this.joystickZone.getBoundingClientRect();
    if (this.config.joystick.mode === 'floating') {
      const center = clampVirtualJoystickCenter(
        event.clientX - rect.left,
        event.clientY - rect.top,
        {
          width: rect.width,
          height: rect.height,
          margin: this.config.joystick.baseRadiusPx * this.layoutScale,
        },
      );
      this.joystickCenterX = center.x;
      this.joystickCenterY = center.y;
      this.joystick.style.left = `${center.x}px`;
      this.joystick.style.top = `${center.y}px`;
    } else {
      this.joystickCenterX = rect.width / 2;
      this.joystickCenterY = rect.height / 2;
    }
    this.updateJoystick(event, rect);
  };

  private readonly handleJoystickPointerMove = (event: PointerEvent): void => {
    if (this.joystickPointerId !== event.pointerId) return;
    event.preventDefault();
    this.updateJoystick(event);
  };

  private readonly handleJoystickPointerEnd = (event: PointerEvent): void => {
    if (this.joystickPointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.joystickPointerId = undefined;
    this.setKnobOffset(0, 0);
    this.joystickZone.classList.remove('is-active');
    if (this.config.joystick.mode === 'floating') this.resetFloatingBasePosition();
    this.device.setAxis2D(this.config.joystick.control, { x: 0, y: 0 }, event.timeStamp);
  };

  private readonly handleLayoutChange = (): void => {
    if (this.joystickPointerId !== undefined || this.buttons.some((button) => button.pointerId !== undefined)) {
      this.reset();
    }
    this.applyLayout();
  };

  private readonly handleFocusLoss = (): void => this.reset();

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') this.reset();
  };

  private updateJoystick(event: PointerEvent, currentRect?: DOMRect): void {
    const rect = currentRect ?? this.joystickZone.getBoundingClientRect();
    const sample = sampleVirtualJoystick(
      event.clientX - rect.left - this.joystickCenterX,
      event.clientY - rect.top - this.joystickCenterY,
      this.config.joystick.travelRadiusPx * this.layoutScale,
      this.config.joystick.deadZone,
      this.config.joystick.sensitivity,
    );
    this.setKnobOffset(sample.offsetX, sample.offsetY);
    this.device.setAxis2D(this.config.joystick.control, sample.value, event.timeStamp);
  }

  private applyLayout(): void {
    const layout = this.portraitQuery.matches
      ? this.config.layouts.portrait
      : this.config.layouts.landscape;
    this.layoutScale = layout.scale;
    this.applyJoystickLayout(layout);
    this.applyButtonLayout(layout);
  }

  private applyJoystickLayout(layout: VirtualControlLayoutDefinition): void {
    const baseDiameter = this.config.joystick.baseRadiusPx * 2 * layout.scale;
    const knobDiameter = this.config.joystick.knobRadiusPx * 2 * layout.scale;
    this.joystick.style.width = `${baseDiameter}px`;
    this.joystick.style.height = `${baseDiameter}px`;
    this.knob.style.width = `${knobDiameter}px`;
    this.knob.style.height = `${knobDiameter}px`;
    this.joystickZone.style.left = `calc(env(safe-area-inset-left, 0px) + ${layout.edgeInsetPx}px)`;
    this.joystickZone.style.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${layout.bottomInsetPx}px)`;

    if (this.config.joystick.mode === 'floating') {
      this.joystickZone.style.width = `calc(${this.config.joystick.activationWidthRatio * 100}vw - env(safe-area-inset-left, 0px) - ${layout.edgeInsetPx}px)`;
      this.joystickZone.style.height = `calc(${this.config.joystick.activationHeightRatio * 100}vh - env(safe-area-inset-bottom, 0px) - ${layout.bottomInsetPx}px)`;
      this.resetFloatingBasePosition();
    } else {
      this.joystickZone.style.width = `${baseDiameter}px`;
      this.joystickZone.style.height = `${baseDiameter}px`;
      this.joystick.style.left = '50%';
      this.joystick.style.top = '50%';
    }
  }

  private applyButtonLayout(layout: VirtualControlLayoutDefinition): void {
    const maximumButtonSize = Math.max(...this.config.buttons.map((button) => button.sizePx), 1)
      * layout.scale;
    this.buttonCluster.style.right = `calc(env(safe-area-inset-right, 0px) + ${layout.edgeInsetPx}px)`;
    this.buttonCluster.style.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${layout.bottomInsetPx}px)`;
    this.buttonCluster.style.gap = `${layout.buttonGapPx * layout.scale}px`;
    this.buttonCluster.style.gridAutoColumns = `${maximumButtonSize}px`;
    this.buttonCluster.style.gridAutoRows = `${maximumButtonSize}px`;
    for (const binding of this.buttons) {
      const size = binding.definition.sizePx * layout.scale;
      binding.element.style.width = `${size}px`;
      binding.element.style.height = `${size}px`;
      binding.element.style.gridColumn = String(binding.definition.gridColumn);
      binding.element.style.gridRow = binding.definition.rowSpan
        ? `${binding.definition.gridRow} / span ${binding.definition.rowSpan}`
        : String(binding.definition.gridRow);
      binding.element.style.alignSelf = 'center';
      binding.element.style.justifySelf = 'center';
    }
  }

  private setKnobOffset(x: number, y: number): void {
    this.knob.style.setProperty('--virtual-knob-x', `${x}px`);
    this.knob.style.setProperty('--virtual-knob-y', `${y}px`);
  }

  private resetFloatingBasePosition(): void {
    this.joystick.style.left = '50%';
    this.joystick.style.top = '50%';
  }

  private readDesktopDebugFlag(): boolean {
    const value = new URLSearchParams(window.location.search)
      .get(this.config.desktopDebugQueryParameter);
    return value !== null && value !== '0' && value !== 'false';
  }

  private requireElement<T extends HTMLElement>(root: HTMLElement, id: string): T {
    const element = root.querySelector(`#${id}`);
    if (!element) throw new Error(`缺少虚拟输入容器 #${id}`);
    return element as T;
  }
}

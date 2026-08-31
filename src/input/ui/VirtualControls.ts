import { VirtualInputDevice } from '../devices/VirtualInputDevice';

export interface VirtualControlsOptions {
  readonly root: HTMLElement;
  readonly device: VirtualInputDevice;
}

interface DigitalButtonBinding {
  readonly element: HTMLButtonElement;
  readonly control: string;
  pointerId?: number;
}

/** 将触摸摇杆和按钮转换为 Virtual.* 控制路径。 */
export class VirtualControls {
  private readonly device: VirtualInputDevice;
  private readonly joystick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly buttons: readonly DigitalButtonBinding[];
  private readonly eventAbortController = new AbortController();
  private joystickPointerId?: number;

  public constructor(options: VirtualControlsOptions) {
    this.device = options.device;
    this.joystick = this.requireElement<HTMLElement>(options.root, 'virtual-move-stick');
    this.knob = this.requireElement<HTMLElement>(options.root, 'virtual-move-stick-knob');
    this.buttons = [
      {
        element: this.requireElement<HTMLButtonElement>(options.root, 'virtual-sprint-button'),
        control: 'Virtual.SprintButton',
      },
      {
        element: this.requireElement<HTMLButtonElement>(options.root, 'virtual-interact-button'),
        control: 'Virtual.InteractButton',
      },
      {
        element: this.requireElement<HTMLButtonElement>(options.root, 'virtual-dodge-button'),
        control: 'Virtual.DodgeButton',
      },
    ];
    this.bindEvents();
  }

  public reset(): void {
    this.joystickPointerId = undefined;
    this.knob.style.transform = '';
    this.joystick.classList.remove('is-active');
    for (const binding of this.buttons) {
      binding.pointerId = undefined;
      binding.element.classList.remove('is-active');
    }
    this.device.cancel();
  }

  public dispose(): void {
    this.eventAbortController.abort();
    this.reset();
  }

  private bindEvents(): void {
    const signal = this.eventAbortController.signal;
    this.joystick.addEventListener('pointerdown', this.handleJoystickPointerDown, { signal });
    this.joystick.addEventListener('pointermove', this.handleJoystickPointerMove, { signal });
    this.joystick.addEventListener('pointerup', this.handleJoystickPointerEnd, { signal });
    this.joystick.addEventListener('pointercancel', this.handleJoystickPointerEnd, { signal });
    this.joystick.addEventListener('lostpointercapture', this.handleJoystickPointerEnd, { signal });

    for (const binding of this.buttons) {
      binding.element.addEventListener('pointerdown', (event) => {
        if (binding.pointerId !== undefined) return;
        event.preventDefault();
        event.stopPropagation();
        binding.pointerId = event.pointerId;
        binding.element.setPointerCapture(event.pointerId);
        binding.element.classList.add('is-active');
        this.device.setDigital(binding.control, true, event.timeStamp);
      }, { signal });

      const release = (event: PointerEvent): void => {
        if (binding.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        binding.pointerId = undefined;
        binding.element.classList.remove('is-active');
        this.device.setDigital(binding.control, false, event.timeStamp);
      };
      binding.element.addEventListener('pointerup', release, { signal });
      binding.element.addEventListener('pointercancel', release, { signal });
      binding.element.addEventListener('lostpointercapture', release, { signal });
    }
  }

  private readonly handleJoystickPointerDown = (event: PointerEvent): void => {
    if (this.joystickPointerId !== undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.joystickPointerId = event.pointerId;
    this.joystick.setPointerCapture(event.pointerId);
    this.joystick.classList.add('is-active');
    this.updateJoystick(event);
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
    this.knob.style.transform = '';
    this.joystick.classList.remove('is-active');
    this.device.setAxis2D('Virtual.MoveStick', { x: 0, y: 0 }, event.timeStamp);
  };

  private updateJoystick(event: PointerEvent): void {
    const rect = this.joystick.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.36);
    const deltaX = event.clientX - (rect.left + rect.width / 2);
    const deltaY = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(deltaX, deltaY);
    const scale = distance > radius ? radius / distance : 1;
    const offsetX = deltaX * scale;
    const offsetY = deltaY * scale;
    this.knob.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    this.device.setAxis2D('Virtual.MoveStick', {
      x: offsetX / radius,
      y: -offsetY / radius,
    }, event.timeStamp);
  }

  private requireElement<T extends HTMLElement>(root: HTMLElement, id: string): T {
    const element = root.querySelector(`#${id}`);
    if (!element) throw new Error(`缺少虚拟输入元素 #${id}`);
    return element as T;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardMouseInputDevice } from '../src/input/devices/KeyboardMouseInputDevice.ts';

/** 只够 KeyboardMouseInputDevice 挂监听、派发事件的最小 DOM 替身。 */
class StubEventTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  public isContentEditable = false;

  public addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  public removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  public dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

class StubTextInput extends StubEventTarget {}

interface KeyEventLog {
  readonly event: Record<string, unknown>;
  prevented: number;
}

function keyDownEvent(
  code: string,
  options: { repeat?: boolean; target?: unknown; timeStamp?: number } = {},
): KeyEventLog {
  const log: KeyEventLog = { event: {}, prevented: 0 };
  Object.assign(log.event, {
    code,
    repeat: options.repeat === true,
    cancelable: true,
    timeStamp: options.timeStamp ?? 0,
    target: options.target ?? null,
    preventDefault: () => { log.prevented += 1; },
  });
  return log;
}

/** 装上 DOM 替身跑一段，跑完把全局还原，避免污染同进程里的其它用例。 */
function withStubbedDom<T>(run: (dom: {
  keyboard: StubEventTarget;
  pointer: StubEventTarget;
}) => T): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']
    .map((key) => [key, globals[key]] as const);
  const keyboard = new StubEventTarget();
  const pointer = new StubEventTarget();
  const documentStub = Object.assign(new StubEventTarget(), { visibilityState: 'visible' });
  globals.window = new StubEventTarget();
  globals.document = documentStub;
  globals.HTMLElement = StubEventTarget;
  globals.HTMLInputElement = StubTextInput;
  globals.HTMLTextAreaElement = class StubTextArea extends StubEventTarget {};
  globals.HTMLSelectElement = class StubSelect extends StubEventTarget {};
  try {
    return run({ keyboard, pointer });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  }
}

function createDevice(keyboard: StubEventTarget, pointer: StubEventTarget) {
  return new KeyboardMouseInputDevice({
    keyboardTarget: keyboard as unknown as Document,
    pointerTarget: pointer as unknown as HTMLElement,
    preventDefaultControls: ['Keyboard.Space'],
  });
}

test('长按只产生一次按下：系统自动重复不再进入输入管线', () => {
  withStubbedDom(({ keyboard, pointer }) => {
    const device = createDevice(keyboard, pointer);
    keyboard.dispatch('keydown', keyDownEvent('Space', { timeStamp: 0 }).event);
    for (let index = 1; index <= 12; index += 1) {
      keyboard.dispatch('keydown', keyDownEvent('Space', { repeat: true, timeStamp: index * 30 }).event);
    }
    const events = device.drainEvents();
    assert.deepEqual(
      events.map((event) => [event.control, event.value]),
      [['Keyboard.Space', true]],
      '按住不放的一串 keydown 只该记一次按下',
    );

    keyboard.dispatch('keyup', keyDownEvent('Space', { timeStamp: 400 }).event);
    assert.deepEqual(
      device.drainEvents().map((event) => [event.control, event.value]),
      [['Keyboard.Space', false]],
      '松手仍然要如实落到管线里',
    );
    device.dispose();
  });
});

test('自动重复的 keydown 照样拦掉浏览器默认行为', () => {
  withStubbedDom(({ keyboard, pointer }) => {
    const device = createDevice(keyboard, pointer);
    // 少了这一条，按住空格会一路滚动页面、还会反复激活当前获得焦点的按钮。
    const first = keyDownEvent('Space');
    const repeat = keyDownEvent('Space', { repeat: true });
    keyboard.dispatch('keydown', first.event);
    keyboard.dispatch('keydown', repeat.event);
    assert.equal(first.prevented, 1);
    assert.equal(repeat.prevented, 1, '重复事件的默认行为同样要挡住');

    const unbound = keyDownEvent('KeyQ', { repeat: true });
    keyboard.dispatch('keydown', unbound.event);
    assert.equal(unbound.prevented, 0, '没绑到玩法上的键不该被抢走默认行为');
    device.dispose();
  });
});

test('文本输入框里的按键既不进管线也不被抢走默认行为', () => {
  withStubbedDom(({ keyboard, pointer }) => {
    const device = createDevice(keyboard, pointer);
    const typing = keyDownEvent('Space', { target: new StubTextInput() });
    keyboard.dispatch('keydown', typing.event);
    assert.equal(typing.prevented, 0);
    assert.equal(device.drainEvents().length, 0);
    device.dispose();
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CommonUIManager } from '../src/ui/common/CommonUIManager.ts';
import type { CommonUIPage } from '../src/ui/common/CommonUIPage.ts';

class FakeClassList {
  public toggle(): void {}
  public remove(): void {}
}

class FakeElement extends EventTarget {
  public hidden = false;
  public inert = false;
  public readonly classList = new FakeClassList();
  private readonly children = new Set<FakeElement>();

  public contains(candidate: unknown): boolean {
    return candidate === this || this.children.has(candidate as FakeElement);
  }

  public append(...children: FakeElement[]): void {
    for (const child of children) this.children.add(child);
  }

  public setAttribute(): void {}
  public toggleAttribute(): void {}
}

function createKeyboardEvent(code: string, repeat = false): KeyboardEvent {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    key: { value: code },
    repeat: { value: repeat },
  });
  return event as KeyboardEvent;
}

test('CommonUI 全局键盘入口在 Gameplay Input 暂停和页面覆盖时仍可触发', () => {
  const previousDocument = globalThis.document;
  const keyboardTarget = new EventTarget() as Document;
  Object.defineProperty(keyboardTarget, 'pointerLockElement', { value: null, configurable: true });
  Object.defineProperty(globalThis, 'document', {
    value: keyboardTarget,
    configurable: true,
    writable: true,
  });

  const sceneRoot = new FakeElement();
  const baseLayer = new FakeElement();
  const overlayRoot = new FakeElement();
  const manager = new CommonUIManager({
    sceneRoot: sceneRoot as unknown as HTMLElement,
    baseLayer: baseLayer as unknown as HTMLElement,
    overlayRoot: overlayRoot as unknown as HTMLElement,
  });

  try {
    let triggerCount = 0;
    const disposeShortcut = manager.bindGlobalKeyboardControl('Keyboard.F8', () => {
      triggerCount += 1;
    });
    manager.activate();

    keyboardTarget.dispatchEvent(createKeyboardEvent('F8'));
    assert.equal(triggerCount, 1);

    const coveringPage: CommonUIPage = {
      id: 'covering-page',
      element: new FakeElement() as unknown as HTMLElement,
    };
    manager.push(coveringPage);
    keyboardTarget.dispatchEvent(createKeyboardEvent('F8'));
    assert.equal(triggerCount, 2);
    manager.pop(coveringPage);

    keyboardTarget.dispatchEvent(createKeyboardEvent('F8', true));
    keyboardTarget.dispatchEvent(createKeyboardEvent('F7'));
    assert.equal(triggerCount, 2);

    disposeShortcut();
    keyboardTarget.dispatchEvent(createKeyboardEvent('F8'));
    assert.equal(triggerCount, 2);
  } finally {
    manager.dispose();
    Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
      writable: true,
    });
  }
});

test('CommonUI 全局键盘入口拒绝非键盘控制路径', () => {
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    value: new EventTarget(),
    configurable: true,
    writable: true,
  });
  const manager = new CommonUIManager({
    sceneRoot: new FakeElement() as unknown as HTMLElement,
    baseLayer: new FakeElement() as unknown as HTMLElement,
    overlayRoot: new FakeElement() as unknown as HTMLElement,
  });
  try {
    assert.throws(
      () => manager.bindGlobalKeyboardControl('Gamepad.ButtonNorth', () => undefined),
      /control 无效/,
    );
  } finally {
    manager.dispose();
    Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
      writable: true,
    });
  }
});

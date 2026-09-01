import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugMenuPage } from '../src/ui/pages/DebugMenuPage.ts';

class FakeElement extends EventTarget {
  public className = '';
  public hidden = false;
  public id = '';
  public textContent = '';
  public type = '';
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public focused = false;
  private readonly attributes = new Map<string, string>();

  public constructor(public readonly tagName: string) {
    super();
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public focus(): void {
    this.focused = true;
  }
}

class FakeDocument extends EventTarget {
  public readonly elements: FakeElement[] = [];

  public createElement(tagName: string): HTMLElement {
    const element = new FakeElement(tagName);
    this.elements.push(element);
    return element as unknown as HTMLElement;
  }
}

test('F8 调试菜单温度按钮切换文案、无障碍状态并派发回调', () => {
  const previousDocument = globalThis.document;
  const fakeDocument = new FakeDocument();
  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });

  try {
    const page = new DebugMenuPage();
    const temperatureButton = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.textContent === '显示 Actor 温度'
    ));
    assert.ok(temperatureButton);
    assert.equal(temperatureButton.getAttribute('aria-pressed'), 'false');

    const states: boolean[] = [];
    page.onTemperatureToggle((visible) => states.push(visible));
    temperatureButton.dispatchEvent(new Event('click'));
    assert.deepEqual(states, [true]);
    assert.equal(temperatureButton.textContent, '隐藏 Actor 温度');
    assert.equal(temperatureButton.getAttribute('aria-pressed'), 'true');

    page.setTemperatureVisible(false);
    assert.equal(temperatureButton.textContent, '显示 Actor 温度');
    assert.equal(temperatureButton.getAttribute('aria-pressed'), 'false');

    const stormButton = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.dataset.weather === 'storm'
    ));
    const sunnyButton = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.dataset.weather === 'sunny'
    ));
    assert.ok(stormButton);
    assert.ok(sunnyButton);
    assert.equal(sunnyButton.getAttribute('aria-pressed'), 'true');

    const weatherRequests: string[] = [];
    page.onWeatherSelect((weather) => weatherRequests.push(weather));
    stormButton.dispatchEvent(new Event('click'));
    assert.deepEqual(weatherRequests, ['storm']);
    // 按钮只提交意图；等服务端快照回传后才改变选中状态。
    assert.equal(sunnyButton.getAttribute('aria-pressed'), 'true');
    page.setWeather('storm');
    assert.equal(sunnyButton.getAttribute('aria-pressed'), 'false');
    assert.equal(stormButton.getAttribute('aria-pressed'), 'true');
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
      writable: true,
    });
  }
});

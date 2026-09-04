import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugMenuPage } from '../src/ui/pages/DebugMenuPage.ts';
import { itemCatalog } from '../shared/items/index.mjs';

class FakeElement extends EventTarget {
  public className = '';
  public hidden = false;
  public id = '';
  public textContent = '';
  public type = '';
  public disabled = false;
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
    const modalBody = fakeDocument.elements.find((element) => (
      element.className === 'modal-window__body'
    ));
    assert.ok(modalBody);
    assert.equal(modalBody.children[0]?.children[0]?.textContent, 'ROOM DAY / NIGHT');
    assert.equal(modalBody.children[1]?.children[0]?.textContent, 'ROOM WEATHER');

    const transformLogButton = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.textContent === '开始记录玩家 Transform'
    ));
    assert.ok(transformLogButton);
    assert.equal(transformLogButton.disabled, true);
    page.setTransformLogAvailable(true);
    assert.equal(transformLogButton.disabled, false);
    const transformLogStates: boolean[] = [];
    page.onTransformLogToggle((recording) => transformLogStates.push(recording));
    transformLogButton.dispatchEvent(new Event('click'));
    assert.deepEqual(transformLogStates, [true]);
    assert.equal(transformLogButton.textContent, '正在开启…');
    assert.equal(transformLogButton.disabled, true);
    page.setTransformLogState('recording');
    transformLogButton.dispatchEvent(new Event('click'));
    assert.deepEqual(transformLogStates, [true, false]);
    assert.equal(transformLogButton.textContent, '正在保存…');

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

    const duskButton = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.dataset.timeOfDay === '18.6'
    ));
    assert.ok(duskButton);
    const timeRequests: number[] = [];
    page.onTimeOfDaySelect((timeOfDay) => timeRequests.push(timeOfDay));
    duskButton.dispatchEvent(new Event('click'));
    assert.deepEqual(timeRequests, [18.6]);

    // 时刻同样只提交意图；显示的时钟来自房间快照。
    const clock = fakeDocument.elements.find((element) => (
      element.className.includes('debug-menu__clock')
    ));
    assert.ok(clock);
    page.setTimeOfDay(7.5, 600);
    assert.equal(clock.textContent, '07:30 · 清晨 · 一天 600 秒');
    page.setTimeOfDay(21.5, 0);
    assert.equal(clock.textContent, '21:30 · 入夜 · 时钟已冻结');
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
      writable: true,
    });
  }
});

test('F8 调试菜单的帧耗时面板开关切换文案、无障碍状态并派发回调', () => {
  const previousDocument = globalThis.document;
  const fakeDocument = new FakeDocument();
  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });

  try {
    const page = new DebugMenuPage();
    const profilerButton = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.textContent === '打开帧耗时面板'
    ));
    assert.ok(profilerButton, '调试菜单里应该有帧耗时面板的开关');
    assert.equal(profilerButton.getAttribute('aria-pressed'), 'false');

    const requests: boolean[] = [];
    page.onProfilerToggle((visible) => requests.push(visible));

    profilerButton.dispatchEvent(new Event('click'));
    assert.deepEqual(requests, [true]);
    assert.equal(profilerButton.textContent, '关闭帧耗时面板');
    assert.equal(profilerButton.getAttribute('aria-pressed'), 'true');

    profilerButton.dispatchEvent(new Event('click'));
    assert.deepEqual(requests, [true, false]);
    assert.equal(profilerButton.textContent, '打开帧耗时面板');

    // 场景那边可能已经打开了面板；重开 F8 时按钮要跟着实际状态走。
    page.setProfilerVisible(true);
    assert.equal(profilerButton.textContent, '关闭帧耗时面板');
    assert.deepEqual(requests, [true, false], 'setProfilerVisible 不该反过来触发回调');
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
      writable: true,
    });
  }
});

test('F8 里的物品那一栏：点开列表是物品目录本身，点一件报一次意图', () => {
  const previousDocument = globalThis.document;
  const fakeDocument = new FakeDocument();
  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });

  try {
    const page = new DebugMenuPage();
    const toggle = fakeDocument.elements.find((element) => (
      element.tagName === 'button' && element.textContent === '选择物品…'
    ));
    assert.ok(toggle, '那一栏该有一个点开列表的按钮');
    const menu = fakeDocument.elements.find((element) => (
      element.className.includes('debug-menu__item-menu')
    ));
    assert.ok(menu);
    assert.equal(menu.hidden, true, '默认收着：F8 一打开不该被一长条物品占满');

    // 列的是目录本身，不是一张写死的清单：目录里加一件东西这里就多一条。
    const listed = menu.children.map((child) => child.dataset.itemType);
    assert.deepEqual(listed, itemCatalog.list().map((item) => item.id));

    toggle.dispatchEvent(new Event('click'));
    assert.equal(menu.hidden, false);
    assert.equal(toggle.textContent, '收起物品列表');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    const grants: string[] = [];
    page.onItemGrant((itemType) => grants.push(itemType));
    const slingshot = menu.children.find((child) => child.dataset.itemType === 'slingshot');
    assert.ok(slingshot, '目录里的弹弓也该列出来');
    slingshot.dispatchEvent(new Event('click'));
    assert.deepEqual(grants, ['slingshot']);
    assert.equal(menu.hidden, true, '点完就收起来：一次点击给一个');

    // 给没给成由下一帧快照说了算，回执只说「已经请求了哪一件」。
    const status = fakeDocument.elements.find((element) => (
      element.className.includes('debug-menu__status') && element.textContent.includes('已请求')
    ));
    assert.ok(status);
    assert.ok(status.textContent.includes('弹弓'), status.textContent);

    // 关掉 F8 再打开，不该看见上一次翻开的那一半。
    toggle.dispatchEvent(new Event('click'));
    assert.equal(menu.hidden, false);
    page.onClose();
    assert.equal(menu.hidden, true);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
      writable: true,
    });
  }
});

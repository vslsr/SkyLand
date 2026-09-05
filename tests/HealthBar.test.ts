import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthBar } from '../src/ui/HealthBar.ts';
import type { HealthDisplayState } from '../src/health/HealthDisplay.ts';

/** 只实现生命条真正用到的那点 DOM，外加一个写次数的计数器。 */
class FakeElement {
  public className = '';
  public hidden = false;
  public textContent = '';
  public readonly dataset: Record<string, string | undefined> = {};
  public readonly children: FakeElement[] = [];
  public readonly properties: Record<string, string> = {};
  /** 自定义属性被写了几次。比对有没有生效全靠它。 */
  public writes = 0;
  public readonly style: { setProperty(name: string, value: string): void };
  private readonly attributes = new Map<string, string>();

  public constructor(public readonly tagName: string) {
    this.style = {
      setProperty: (name: string, value: string) => {
        this.properties[name] = value;
        this.writes += 1;
      },
    };
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public remove(): void {
    // 这些测试只造一棵树，不需要真的从父节点上摘下来。
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public find(className: string): FakeElement | undefined {
    for (const child of this.children) {
      if (child.className === className) return child;
      const found = child.find(className);
      if (found) return found;
    }
    return undefined;
  }
}

function withFakeDocument<T>(run: () => T): T {
  const previous = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: (tagName: string) => new FakeElement(tagName) },
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

function state(overrides: Partial<HealthDisplayState> = {}): HealthDisplayState {
  return {
    current: 100,
    maximum: 100,
    ratio: 1,
    trailingRatio: 1,
    dead: false,
    critical: false,
    ...overrides,
  };
}

function rootOf(bar: HealthBar): FakeElement {
  return bar.element as unknown as FakeElement;
}

test('没有可显示的生命值就收起来', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    assert.equal(rootOf(bar).hidden, true, '还没收到状态之前不该占着屏幕');

    bar.render(state({ current: 70, ratio: 0.7 }));
    assert.equal(rootOf(bar).hidden, false);

    bar.render(undefined);
    assert.equal(rootOf(bar).hidden, true);
  });
});

test('三层宽度写成自定义属性，读数与 aria 说同一个值', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    bar.render(state({ current: 72, ratio: 0.72, trailingRatio: 0.9 }));

    const root = rootOf(bar);
    assert.equal(root.properties['--health-ratio'], '72%');
    assert.equal(root.properties['--health-ghost'], '90%');
    assert.equal(root.find('health-bar__readout')?.textContent, '72 / 100');
    assert.equal(root.getAttribute('aria-valuenow'), '72');
    assert.equal(root.getAttribute('aria-valuemax'), '100');
    assert.equal(root.getAttribute('aria-valuetext'), '72 / 100');
    assert.equal(root.getAttribute('role'), 'meter');
  });
});

test('状态由控制器给，视图不自己判断警戒线', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    const root = rootOf(bar);

    bar.render(state({ current: 80, ratio: 0.8 }));
    assert.equal(root.dataset.state, 'normal');

    // 比例照旧很高，但控制器说这是警戒——视图照办，不拿 ratio 再判一次。
    bar.render(state({ current: 80, ratio: 0.8, critical: true }));
    assert.equal(root.dataset.state, 'critical');

    bar.render(state({ current: 0, ratio: 0, trailingRatio: 0.4, dead: true }));
    assert.equal(root.dataset.state, 'dead', '阵亡盖过警戒');
    assert.equal(root.getAttribute('aria-valuetext'), '已阵亡');
  });
});

test('闪光分治疗与伤害，浓淡按事件年龄退到 0', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    const root = rootOf(bar);

    bar.render(state({ current: 60, ratio: 0.6, lastChange: { amount: -40, ageSeconds: 0 } }));
    assert.equal(root.dataset.change, 'damage');
    assert.equal(root.properties['--health-flash'], '1.00');

    bar.render(state({ current: 60, ratio: 0.6, lastChange: { amount: -40, ageSeconds: 0.25 } }));
    assert.equal(root.properties['--health-flash'], '0.50', '半程退一半');

    bar.render(state({ current: 60, ratio: 0.6, lastChange: { amount: -40, ageSeconds: 0.9 } }));
    assert.equal(root.properties['--health-flash'], '0.00', '退完就静下来，不留一层底色');

    bar.render(state({ current: 90, ratio: 0.9, lastChange: { amount: 30, ageSeconds: 0 } }));
    assert.equal(root.dataset.change, 'heal');

    bar.render(state({ current: 90, ratio: 0.9 }));
    assert.equal(root.dataset.change, '', '没有结算就没有闪光');
  });
});

test('同一份状态不重复写 DOM：每帧都在跑，写一次就要重算一次样式', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    const root = rootOf(bar);

    const unchanged = state({ current: 55, ratio: 0.55, trailingRatio: 0.8 });
    bar.render(unchanged);
    const afterFirst = root.writes;
    assert.ok(afterFirst > 0);

    bar.render(unchanged);
    bar.render(unchanged);
    assert.equal(root.writes, afterFirst, '值没变就不该再写');

    // 0.1% 以内的抖动看不出来，也不值得写一次。
    bar.render(state({ current: 55, ratio: 0.55004, trailingRatio: 0.8 }));
    assert.equal(root.writes, afterFirst);

    bar.render(state({ current: 55, ratio: 0.552, trailingRatio: 0.8 }));
    assert.equal(root.writes, afterFirst + 1);
  });
});

test('收起来之后再显示的多半是另一条命，比对基准要作废', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    const root = rootOf(bar);
    const shown = state({ current: 40, ratio: 0.4, trailingRatio: 0.4 });
    bar.render(shown);
    bar.render(undefined);

    const before = root.writes;
    bar.render(shown);
    assert.ok(root.writes > before, '重新显示时要把每一层都写回去，不能沿用旧的比对值');
    assert.equal(root.properties['--health-ratio'], '40%');
  });
});

test('收起来时闪光的颜色一起清掉，不留给下一条命', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    const root = rootOf(bar);
    bar.render(state({ current: 20, ratio: 0.2, lastChange: { amount: -80, ageSeconds: 0 } }));
    assert.equal(root.dataset.change, 'damage');

    bar.render(undefined);
    assert.equal(root.dataset.change, '', '空串是合法取值，光清比对基准会把它留在元素上');

    bar.render(state());
    assert.equal(root.dataset.change, '');
  });
});

test('倒下那一刻读屏念的是结果，不是同一串数字', () => {
  withFakeDocument(() => {
    const bar = new HealthBar();
    const root = rootOf(bar);
    // 血已经空了但还没判死：读数和死后完全一样，只比读数就永远换不过来。
    bar.render(state({ current: 0, ratio: 0 }));
    assert.equal(root.getAttribute('aria-valuetext'), '0 / 100');

    bar.render(state({ current: 0, ratio: 0, dead: true }));
    assert.equal(root.getAttribute('aria-valuetext'), '已阵亡');
  });
});

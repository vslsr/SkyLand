import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthDisplayController } from '../src/health/HealthDisplayController.ts';
import type {
  HealthDisplayState,
  HealthReading,
  HealthView,
} from '../src/health/HealthDisplay.ts';

/**
 * 一个能被换掉的来源。整个契约就这一个方法——不需要 `HealthComponent`、不需要
 * 快照、不需要网络，测试里两行就能实现它。这本身就是解耦要的那个结果。
 */
class FakeSource {
  public reading: HealthReading | undefined;

  public readHealth(): HealthReading | undefined {
    return this.reading;
  }

  public set(overrides: Partial<HealthReading> & { current: number }): void {
    this.reading = {
      maximum: 100,
      dead: false,
      eventRevision: 0,
      lastDelta: 0,
      ...overrides,
    };
  }
}

/** 一种「画法」，只把收到的每一帧记下来。 */
class RecordingView implements HealthView {
  public readonly frames: (HealthDisplayState | undefined)[] = [];

  public render(state: HealthDisplayState | undefined): void {
    // 控制器每帧重造一份状态，所以直接存引用就够；存的是不同的对象。
    this.frames.push(state);
  }

  public get last(): HealthDisplayState | undefined {
    return this.frames.at(-1);
  }
}

function setup(): { source: FakeSource; controller: HealthDisplayController; view: RecordingView } {
  const source = new FakeSource();
  const controller = new HealthDisplayController(source);
  const view = new RecordingView();
  controller.addView(view);
  return { source, controller, view };
}

test('几种样式收到的是同一份状态：不会一条变红另一条还没有', () => {
  const source = new FakeSource();
  const controller = new HealthDisplayController(source);
  const bar = new RecordingView();
  const pips = new RecordingView();
  controller.addView(bar);
  const removePips = controller.addView(pips);

  source.set({ current: 100 });
  controller.update(0.1);
  source.set({ current: 12, eventRevision: 1, lastDelta: -88 });
  controller.update(0.1);

  assert.equal(bar.frames.length, 2);
  assert.equal(pips.frames.length, 2);
  // 同一个对象：警戒线、残影、事件年龄都只算了一遍。
  assert.equal(bar.last, pips.last);
  assert.equal(bar.last?.critical, true);

  // 摘掉一种样式之后，剩下的照常收。
  removePips();
  controller.update(0.1);
  assert.equal(bar.frames.length, 3);
  assert.equal(pips.frames.length, 2);
});

test('第一次看见一条命不闪，也不从满条退一遍', () => {
  const { source, controller, view } = setup();
  // 中途进房间：接管的这个角色早就挨过打了。
  source.set({ current: 40, eventRevision: 7, lastDelta: -30 });
  controller.update(0.1);

  const state = view.last;
  assert.equal(state?.ratio, 0.4);
  // 残影直接贴上：它过去掉的血不该在眼前补演一次。
  assert.equal(state?.trailingRatio, 0.4);
  assert.equal(state?.lastChange, undefined);
});

test('掉血：血立刻到位，残影先停一段再退，退到血就停', () => {
  const { source, controller, view } = setup();
  source.set({ current: 100 });
  controller.update(0.1);

  source.set({ current: 60, eventRevision: 1, lastDelta: -40 });
  controller.update(0.1);
  assert.equal(view.last?.ratio, 0.6, '血是权威值，不做补间');
  assert.equal(view.last?.trailingRatio, 1, '残影还停在原处');
  assert.deepEqual(view.last?.lastChange, { amount: -40, ageSeconds: 0 });

  // 停够 0.45 秒之前，残影一动不动。
  controller.update(0.3);
  assert.equal(view.last?.trailingRatio, 1);

  // 停完之后按每秒 0.55 退。
  controller.update(0.2);
  assert.ok(view.last!.trailingRatio < 1, '该开始退了');
  for (let frame = 0; frame < 60; frame += 1) controller.update(0.1);
  assert.equal(view.last?.trailingRatio, 0.6, '退到血的位置就停，不会穿过去');
});

test('连着挨打：每一下都把残影重新压住，不会退到一半又被打下去', () => {
  const { source, controller, view } = setup();
  source.set({ current: 100 });
  controller.update(0.1);
  source.set({ current: 80, eventRevision: 1, lastDelta: -20 });
  controller.update(0.5);
  const afterFirst = view.last!.trailingRatio;
  assert.ok(afterFirst < 1 && afterFirst > 0.8, '第一下已经开始退');

  source.set({ current: 60, eventRevision: 2, lastDelta: -20 });
  controller.update(0.1);
  assert.equal(view.last?.trailingRatio, afterFirst, '第二下把计时器重新压住');
});

test('治疗：残影立刻贴合，不留一条比血还短的影子', () => {
  const { source, controller, view } = setup();
  source.set({ current: 100 });
  controller.update(0.1);
  source.set({ current: 30, eventRevision: 1, lastDelta: -70 });
  controller.update(0.1);
  assert.equal(view.last?.trailingRatio, 1);

  source.set({ current: 90, eventRevision: 2, lastDelta: 60 });
  controller.update(0.1);
  assert.equal(view.last?.ratio, 0.9);
  assert.equal(view.last?.trailingRatio, 0.9, '残影只讲损失');
  assert.equal(view.last?.lastChange?.amount, 60);
});

test('结算的年龄自己往前走，过期之后不再往下发', () => {
  const { source, controller, view } = setup();
  source.set({ current: 100 });
  controller.update(0.1);
  source.set({ current: 90, eventRevision: 1, lastDelta: -10 });
  controller.update(0.1);
  assert.equal(view.last?.lastChange?.ageSeconds, 0);

  controller.update(0.4);
  assert.equal(view.last?.lastChange?.ageSeconds, 0.4, '年龄由控制器记，样式不各自计时');

  controller.update(1);
  assert.equal(view.last?.lastChange, undefined, '过久的一次不再算「刚刚」');
});

test('警戒与阵亡只有一份判定；死了不再说「快没血了」', () => {
  const { source, controller, view } = setup();
  source.set({ current: 31 });
  controller.update(0.1);
  assert.equal(view.last?.critical, false);

  source.set({ current: 30, eventRevision: 1, lastDelta: -1 });
  controller.update(0.1);
  assert.equal(view.last?.critical, true, '三成是警戒线，闭区间');

  source.set({ current: 0, dead: true, eventRevision: 2, lastDelta: -30 });
  controller.update(0.1);
  assert.equal(view.last?.dead, true);
  assert.equal(view.last?.critical, false, '倒下之后要说的是结果，不是「还剩一点」');
  assert.equal(view.last?.ratio, 0);
});

test('来源交不出东西：视图收起来，且只收一次', () => {
  const { source, controller, view } = setup();
  source.set({ current: 100 });
  controller.update(0.1);

  source.reading = undefined;
  controller.update(0.1);
  assert.equal(view.last, undefined, '角色没了，生命条自己收起来');

  const framesAfterHide = view.frames.length;
  controller.update(0.1);
  controller.update(0.1);
  assert.equal(view.frames.length, framesAfterHide, '没得显示时不必每帧再喊一遍');
});

test('换一条命：残影与闪光都不接着上一条往下走', () => {
  const { source, controller, view } = setup();
  source.set({ current: 100 });
  controller.update(0.1);
  source.set({ current: 20, eventRevision: 1, lastDelta: -80 });
  controller.update(0.1);
  assert.equal(view.last?.trailingRatio, 1);

  controller.reset();
  assert.equal(view.last, undefined);

  // 重生：满血从头开始，上一条命掉下去的那一截不该在这里接着退。
  source.set({ current: 100, eventRevision: 0, lastDelta: 0 });
  controller.update(0.1);
  assert.equal(view.last?.trailingRatio, 1);
  assert.equal(view.last?.lastChange, undefined);
});

test('异常输入不把状态算崩', () => {
  const { source, controller, view } = setup();
  // 上限为 0（还没配好的原型）与超出上限的当前值都不该算出 NaN 或负比例。
  source.set({ current: 10, maximum: 0 });
  controller.update(0.1);
  assert.equal(view.last?.ratio, 0);
  assert.equal(view.last?.current, 0);

  source.reading = undefined;
  controller.update(0.1);
  source.set({ current: 260, maximum: 100 });
  controller.update(Number.NaN);
  assert.equal(view.last?.ratio, 1);
  assert.equal(view.last?.current, 100);

  // 视图会把 current 直接印在屏幕上，所以 NaN 要在这里就夹掉，不能指望每一种
  // 样式各自防一遍。
  source.set({ current: Number.NaN });
  controller.update(0.1);
  assert.equal(view.last?.current, 0);
  assert.equal(view.last?.ratio, 0);
});

test('可选口径能改，而且改的是所有样式共用的那一份', () => {
  const source = new FakeSource();
  const controller = new HealthDisplayController(source, {
    criticalRatio: 0.6,
    trailingDelaySeconds: 0,
    trailingSpeed: 1,
  });
  const view = new RecordingView();
  controller.addView(view);

  source.set({ current: 100 });
  controller.update(0.1);
  source.set({ current: 50, eventRevision: 1, lastDelta: -50 });
  controller.update(0.1);
  assert.equal(view.last?.critical, true, '警戒线抬到六成');
  // 不停顿、每秒退一整条：这一帧就退了 0.1。
  assert.ok(Math.abs(view.last!.trailingRatio - 0.9) < 1e-9);
});

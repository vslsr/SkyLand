import assert from 'node:assert/strict';
import test from 'node:test';
import { SlimeSurfaceDragController } from '../src/controllers/SlimeSurfaceDragController';
import {
  toProxyId,
  type ProxyId,
  type SlimeSurfaceDragListener,
  type SlimeSurfaceDragRay,
} from '../src/render/RenderScene';
import { BufferedInputDevice } from '../src/input/devices/BufferedInputDevice';
import { createPlayerInputScheme, InputSubsystem } from '../src/input/index';
import type { CameraFrame } from '../src/camera/CameraTransform';

/**
 * 蒙皮拖拽这条通道的**异步形态**（实现路径文档 §3）。
 *
 * `beginSlimeSurfaceDrag` 曾经返回「抓住了没有」，是这条边界上最后一次等对面回话。
 * 单线程下它同步就有答案，所以现有的 `TopDownController.test.ts` 那条端到端用例
 * 看不出区别——**这一组专门把回报押后**，模拟渲染循环在另一条线程上的情形。
 *
 * 盯住的是那条易手规则：**在收到回报之前不认领这次手势**。认早了，点空地的那一下
 * 会被拖拽吃掉，相机转不动；认晚了没关系，因为按下那一帧指针还没动过。
 */

class TestMouse extends BufferedInputDevice {
  public constructor(private readonly now: () => number) {
    super('keyboardMouse');
  }

  public emit(control: string, value: boolean): void {
    this.setDigital(control, value, this.now());
  }
}

function createCanvas() {
  const listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  const captured = new Set<number>();
  const canvas = {
    addEventListener(type: string, listener: (event: PointerEvent) => void): void {
      const matching = listeners.get(type) ?? new Set();
      matching.add(listener);
      listeners.set(type, matching);
    },
    removeEventListener(type: string, listener: (event: PointerEvent) => void): void {
      listeners.get(type)?.delete(listener);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    captured,
    pointer(type: string, clientX: number, clientY: number): void {
      for (const listener of listeners.get(type) ?? []) {
        listener({
          type, clientX, clientY, pointerId: 1, button: 0,
          cancelable: true, preventDefault: () => undefined,
        } as unknown as PointerEvent);
      }
    },
  };
}

/** 一条把回报押后的渲染世界：命令记下来，`deliver()` 时才回话。 */
function createDeferredSurface() {
  const commands: string[] = [];
  let listener: SlimeSurfaceDragListener | undefined;
  return {
    commands,
    surface: {
      beginSlimeSurfaceDrag: (id: ProxyId, ray: SlimeSurfaceDragRay) => {
        commands.push(`begin:${id}:${ray.direction.every(Number.isFinite)}`);
      },
      updateSlimeSurfaceDrag: (id: ProxyId) => commands.push(`update:${id}`),
      endSlimeSurfaceDrag: (id: ProxyId) => commands.push(`end:${id}`),
      setSlimeSurfaceDragListener: (next?: SlimeSurfaceDragListener) => { listener = next; },
    },
    deliver(id: ProxyId, dragging: boolean): void {
      listener?.(id, dragging);
    },
    get hasListener(): boolean {
      return listener !== undefined;
    },
  };
}

const CAMERA: CameraFrame = {
  position: [0, 6, 8],
  axes: {
    forward: [0, -0.6, -0.8],
    right: [1, 0, 0],
    up: [0, 0.8, -0.6],
  },
};

function createHarness() {
  let now = 0;
  const scheme = createPlayerInputScheme({ includeDevelopmentMappings: false });
  const device = new TestMouse(() => now);
  const input = new InputSubsystem({
    actions: scheme.actions,
    config: scheme.config,
    contexts: scheme.contexts,
    devices: [device],
  });
  const dom = createCanvas();
  const render = createDeferredSurface();
  const proxyId = toProxyId(3);
  const claims: boolean[] = [];
  const drag = new SlimeSurfaceDragController(
    dom.canvas,
    input,
    render.surface,
    proxyId,
    () => CAMERA,
    (active) => claims.push(active),
  );
  return {
    drag, dom, render, proxyId, claims, device, input,
    tick(): void {
      now += 16;
      input.update(now);
    },
  };
}

test('按下只发命令，不认领手势——回报到之前相机照样归自己', () => {
  const h = createHarness();
  assert.ok(h.render.hasListener, '控制器要在装配时就把回报口子接上');

  h.dom.pointer('pointerdown', 500, 500);
  h.device.emit('Mouse.Button0', true);
  h.tick();

  assert.deepEqual(h.render.commands, ['begin:3:true'], '按下这一帧只该发一条命令');
  assert.deepEqual(h.claims, [], '还没回报就认领，点空地那一下会被拖拽吃掉');
  assert.equal(h.dom.captured.has(1), false, '指针捕获也要等回报');

  // 这一帧里指针动了：拖拽还没成立，所以一条 update 都不该发。
  h.dom.pointer('pointermove', 520, 480);
  h.drag.update();
  assert.deepEqual(h.render.commands, ['begin:3:true']);
});

test('回报说抓住了才易手，并补上按下到回报之间那段位移', () => {
  const h = createHarness();
  h.dom.pointer('pointerdown', 500, 500);
  h.device.emit('Mouse.Button0', true);
  h.tick();
  h.dom.pointer('pointermove', 620, 430);

  h.render.deliver(h.proxyId, true);

  assert.deepEqual(h.claims, [true], '回报到了才认领这次手势');
  assert.equal(h.dom.captured.has(1), true);
  assert.deepEqual(
    h.render.commands,
    ['begin:3:true', 'update:3'],
    '易手时要补一次目标，别丢掉按下到回报之间的位移',
  );
});

test('回报说没抓住，则一切照旧：不认领、不捕获、不发 update', () => {
  const h = createHarness();
  h.dom.pointer('pointerdown', 500, 500);
  h.device.emit('Mouse.Button0', true);
  h.tick();

  h.render.deliver(h.proxyId, false);
  h.dom.pointer('pointermove', 900, 200);
  h.drag.update();

  assert.deepEqual(h.claims, [], '没抓住就不该动过玩法侧那个布尔');
  assert.equal(h.dom.captured.has(1), false);
  assert.deepEqual(h.render.commands, ['begin:3:true']);
});

test('别人的 proxy 回报与我无关', () => {
  const h = createHarness();
  h.dom.pointer('pointerdown', 500, 500);
  h.device.emit('Mouse.Button0', true);
  h.tick();

  h.render.deliver(toProxyId(9), true);

  assert.deepEqual(h.claims, [], '回报带着 ProxyId，认错人就会有两个手势所有者');
});

test('松手发 end；渲染世界不回话时这一侧也要把手势还回去', () => {
  const h = createHarness();
  h.dom.pointer('pointerdown', 500, 500);
  h.device.emit('Mouse.Button0', true);
  h.tick();
  h.render.deliver(h.proxyId, true);
  assert.deepEqual(h.claims, [true]);

  h.device.emit('Mouse.Button0', false);
  h.tick();

  assert.equal(h.render.commands.at(-1), 'end:3');
  assert.deepEqual(h.claims, [true, false], '换场景时渲染世界可能已经没了，兜底也要归还');
  assert.equal(h.dom.captured.has(1), false);
});

test('proxy 在拖拽途中消失，回报一条 false 就能把手势收回来', () => {
  const h = createHarness();
  h.dom.pointer('pointerdown', 500, 500);
  h.device.emit('Mouse.Button0', true);
  h.tick();
  h.render.deliver(h.proxyId, true);

  // 渲染世界销毁了这个 proxy（换场景、Actor 死亡）。
  h.render.deliver(h.proxyId, false);

  assert.deepEqual(h.claims, [true, false]);
  assert.equal(h.dom.captured.has(1), false);
});

test('装配解除时把回报口子还回去，不给下一任控制器留下旧监听器', () => {
  const h = createHarness();
  h.drag.dispose();
  assert.equal(h.render.hasListener, false);
});

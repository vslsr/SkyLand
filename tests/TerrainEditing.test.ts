import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainEditController } from '../src/controllers/TerrainEditController.ts';
import { TerrainEditorPanel } from '../src/ui/TerrainEditorPanel.ts';
import type { TerrainEditOperation } from '../src/network/messages.ts';

class FakeElement extends EventTarget {
  public className = '';
  public hidden = false;
  public id = '';
  public textContent = '';
  public type = '';
  public title = '';
  public innerHTML = '';
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly classes = new Set<string>();

  public constructor(public readonly tagName: string) {
    super();
  }

  public readonly classList = {
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string) => this.classes.has(name),
  };

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument extends EventTarget {
  public readonly created: FakeElement[] = [];
  public readonly body = new FakeElement('body');
  private readonly byId = new Map<string, FakeElement>();

  public constructor(ids: readonly string[]) {
    super();
    for (const id of ids) {
      const element = new FakeElement('div');
      element.id = id;
      this.byId.set(id, element);
    }
  }

  public getElementById(id: string): HTMLElement | null {
    return (this.byId.get(id) ?? null) as unknown as HTMLElement | null;
  }

  public createElement(tagName: string): HTMLElement {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element as unknown as HTMLElement;
  }

  public createElementNS(_namespace: string, tagName: string): HTMLElement {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element as unknown as HTMLElement;
  }
}

function withFakeDocument<T>(run: (document: FakeDocument) => T): T {
  const previous = globalThis.document;
  const fake = new FakeDocument(['terrain-editor', 'terrain-editor-toggle', 'terrain-editor-tools']);
  Object.defineProperty(globalThis, 'document', {
    value: fake,
    configurable: true,
    writable: true,
  });
  try {
    return run(fake);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

function toolButton(document: FakeDocument, operation: TerrainEditOperation): FakeElement {
  const button = document.created.find((element) => (
    element.tagName === 'button' && element.dataset.operation === operation
  ));
  assert.ok(button, `没有找到 ${operation} 按钮`);
  return button;
}

test('地形编辑栏：选中的按钮是深色，再点一次退出该模式', () => {
  withFakeDocument((document) => {
    const panel = new TerrainEditorPanel();
    const changes: Array<TerrainEditOperation | undefined> = [];
    panel.onOperationChange((operation) => changes.push(operation));
    panel.setAvailable(true);
    panel.setExpanded(true);

    const raise = toolButton(document, 'raise');
    assert.equal(raise.classList.contains('is-active'), false);
    raise.dispatchEvent(new Event('click'));
    assert.equal(panel.operation, 'raise');
    assert.equal(raise.classList.contains('is-active'), true);
    assert.equal(raise.getAttribute('aria-pressed'), 'true');

    // 再点同一个按钮就退出，不用先收起整条栏。
    raise.dispatchEvent(new Event('click'));
    assert.equal(panel.operation, undefined);
    assert.equal(raise.classList.contains('is-active'), false);
    assert.deepEqual(changes, ['raise', undefined]);
  });
});

test('地形编辑栏：换一个工具时上一个自动取消', () => {
  withFakeDocument((document) => {
    const panel = new TerrainEditorPanel();
    panel.setAvailable(true);
    panel.setExpanded(true);
    toolButton(document, 'raise').dispatchEvent(new Event('click'));
    toolButton(document, 'water').dispatchEvent(new Event('click'));
    assert.equal(panel.operation, 'water');
    assert.equal(toolButton(document, 'raise').classList.contains('is-active'), false);
    assert.equal(toolButton(document, 'water').classList.contains('is-active'), true);
  });
});

test('收起栏目会关闭编辑功能，而不只是把按钮藏起来', () => {
  withFakeDocument((document) => {
    const panel = new TerrainEditorPanel();
    const changes: Array<TerrainEditOperation | undefined> = [];
    panel.setAvailable(true);
    panel.setExpanded(true);
    toolButton(document, 'lower').dispatchEvent(new Event('click'));
    panel.onOperationChange((operation) => changes.push(operation));

    panel.setExpanded(false);
    assert.equal(panel.operation, undefined, '收起必须清掉当前工具');
    assert.deepEqual(changes, [undefined], '场景那边要收到关闭通知');

    const tools = document.getElementById('terrain-editor-tools')!;
    assert.equal((tools as unknown as FakeElement).hidden, true);
  });
});

test('非流式地图整条栏不出现，且不会留下已选工具', () => {
  withFakeDocument((document) => {
    const panel = new TerrainEditorPanel();
    panel.setAvailable(true);
    panel.setExpanded(true);
    toolButton(document, 'flatten').dispatchEvent(new Event('click'));

    panel.setAvailable(false);
    assert.equal(panel.operation, undefined);
    assert.equal((document.getElementById('terrain-editor') as unknown as FakeElement).hidden, true);
  });
});

/** 只实现 TerrainEditController 用到的那两个成员。 */
function createFakeInput() {
  const triggers: Array<() => void> = [];
  return {
    enabled: true,
    bind(_tag: unknown, handler: () => void) {
      triggers.push(handler);
      return () => {};
    },
    click() {
      for (const trigger of triggers) trigger();
    },
  };
}

const FRAME = {
  position: [0, 2, 0] as const,
  axes: { forward: [0, -1, 0] as const },
};

function createController(cell?: { cellX: number; cellZ: number }) {
  const input = createFakeInput();
  const highlights: Array<{ cellX: number; cellZ: number } | undefined> = [];
  const sent: Array<{ cellX: number; cellZ: number; operation: TerrainEditOperation }> = [];
  const controller = new TerrainEditController(input as never, {
    pickCell: () => cell,
    highlight: (value) => highlights.push(value),
    sendEdit: (cellX, cellZ, operation) => sent.push({ cellX, cellZ, operation }),
  });
  return { controller, input, highlights, sent };
}

test('没有选中工具时既不高亮也不发请求', () => {
  const { controller, input, highlights, sent } = createController({ cellX: 3, cellZ: 4 });
  input.click();
  controller.update(FRAME as never);
  assert.deepEqual(sent, []);
  assert.deepEqual(highlights, [undefined]);
});

test('选中工具后高亮指向的格子，点击提交一次修改', () => {
  const { controller, input, highlights, sent } = createController({ cellX: 3, cellZ: 4 });
  controller.setOperation('raise');
  controller.update(FRAME as never);
  assert.deepEqual(highlights.at(-1), { cellX: 3, cellZ: 4 });
  assert.deepEqual(sent, []);

  input.click();
  controller.update(FRAME as never);
  assert.deepEqual(sent, [{ cellX: 3, cellZ: 4, operation: 'raise' }]);

  // 一次点击只算一次：下一帧不该重复提交。
  controller.update(FRAME as never);
  assert.equal(sent.length, 1);
});

test('切换工具会丢掉还没兑现的那次点击', () => {
  const { controller, input, sent } = createController({ cellX: 1, cellZ: 1 });
  controller.setOperation('raise');
  input.click();
  controller.setOperation('lower');
  controller.update(FRAME as never);
  assert.deepEqual(sent, [], '换工具那一下不该顺手改一格');
});

test('射线没打到地形时不发请求', () => {
  const { controller, input, sent } = createController(undefined);
  controller.setOperation('raise');
  input.click();
  controller.update(FRAME as never);
  assert.deepEqual(sent, []);
});

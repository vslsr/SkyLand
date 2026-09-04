import assert from 'node:assert/strict';
import test from 'node:test';
import { BuildPanel } from '../src/ui/BuildPanel.ts';
import type { BuildSelection } from '../src/controllers/BuildController.ts';
import type { ActorArchetypeDefinition } from '../src/scenes/data/SceneDefinition.ts';

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
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
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

  public remove(): void {
    // 按钮从工具栏里拿掉；这里只要不再被查到就够了。
    this.hidden = true;
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
  const fake = new FakeDocument(['build-editor', 'build-editor-toggle', 'build-editor-tools']);
  Object.defineProperty(globalThis, 'document', { value: fake, configurable: true, writable: true });
  try {
    return run(fake);
  } finally {
    Object.defineProperty(globalThis, 'document', { value: previous, configurable: true, writable: true });
  }
}

function piece(id: string, kind: 'foundation' | 'wall' | 'fixture', cost: Array<{ itemType: string; quantity: number }>): ActorArchetypeDefinition {
  return {
    schemaVersion: 1,
    id,
    components: {
      buildPiece: {
        kind, surface: kind === 'fixture' ? 'any' : 'static', label: id, reach: 6, cost, mass: 0, buoyancy: 0,
        ...(kind === 'fixture' ? { slot: 'hearth' } : {}),
      },
      render: kind === 'wall'
        ? { model: 'line-art-build-wall', width: 2, height: 1.5, thickness: 0.18, color: '#fff', accentColor: '#fff', inkColor: '#000' }
        : { model: 'line-art-build-foundation', size: 2, thickness: 0.12, plankColor: '#fff', accentColor: '#fff', inkColor: '#000' },
    },
  } as ActorArchetypeDefinition;
}

function toolButton(document: FakeDocument, key: string): FakeElement {
  const button = document.created.find((element) => (
    element.tagName === 'button' && !element.hidden && element.dataset.build === key
  ));
  assert.ok(button, `没有找到 ${key} 按钮`);
  return button;
}

test('建造栏：列出这张图的件与拆除，点一行选中、再点一次退出', () => {
  withFakeDocument((document) => {
    const panel = new BuildPanel();
    const changes: Array<BuildSelection | undefined> = [];
    panel.onSelectionChange((selection) => changes.push(selection));
    const foundation = piece('ground-foundation', 'foundation', [{ itemType: 'wood-log', quantity: 2 }]);
    panel.setPieces([foundation, piece('wood-wall', 'wall', [{ itemType: 'wood-log', quantity: 2 }])]);
    panel.setExpanded(true);

    const root = document.getElementById('build-editor') as unknown as FakeElement;
    assert.equal(root.hidden, false, '有件可建，整条栏出现');
    const button = toolButton(document, 'ground-foundation');
    assert.match(button.title, /圆木 ×2/, '每一行写着材料价');
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(panel.selection, { kind: 'piece', archetype: foundation });
    assert.equal(button.classList.contains('is-active'), true);
    assert.equal(button.getAttribute('aria-pressed'), 'true');

    toolButton(document, 'remove').dispatchEvent(new Event('click'));
    assert.deepEqual(panel.selection, { kind: 'remove' });
    assert.equal(button.classList.contains('is-active'), false, '换一行上一行自动取消');

    toolButton(document, 'remove').dispatchEvent(new Event('click'));
    assert.equal(panel.selection, undefined);
    assert.deepEqual(changes, [{ kind: 'piece', archetype: foundation }, { kind: 'remove' }, undefined]);
  });
});

test('背包里材料不够的行标红，但仍然点得动', () => {
  withFakeDocument((document) => {
    const panel = new BuildPanel();
    const wall = piece('stone-wall', 'wall', [{ itemType: 'stone', quantity: 3 }]);
    panel.setPieces([wall]);
    panel.setExpanded(true);
    panel.setInventory((itemType) => (itemType === 'stone' ? 1 : 0));
    const button = toolButton(document, 'stone-wall');
    assert.equal(button.classList.contains('is-unaffordable'), true);
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(panel.selection, { kind: 'piece', archetype: wall }, '幽灵会告诉玩家缺什么，栏里不拦');
    panel.setInventory((itemType) => (itemType === 'stone' ? 3 : 0));
    assert.equal(button.classList.contains('is-unaffordable'), false);
    panel.setInventory(undefined);
    assert.equal(button.classList.contains('is-unaffordable'), false, '没有背包（自由镜头）不标红');
  });
});

test('收起栏目就退出建造，没有件的地图整条栏不出现', () => {
  withFakeDocument((document) => {
    const panel = new BuildPanel();
    const changes: Array<BuildSelection | undefined> = [];
    panel.setPieces([piece('campfire', 'fixture', [{ itemType: 'wood-log', quantity: 3 }])]);
    panel.setExpanded(true);
    toolButton(document, 'campfire').dispatchEvent(new Event('click'));
    panel.onSelectionChange((selection) => changes.push(selection));

    panel.setExpanded(false);
    assert.equal(panel.selection, undefined, '收起必须清掉当前选择');
    assert.deepEqual(changes, [undefined], '场景那边要收到退出通知');
    assert.equal((document.getElementById('build-editor-tools') as unknown as FakeElement).hidden, true);

    panel.setExpanded(true);
    toolButton(document, 'campfire').dispatchEvent(new Event('click'));
    panel.setPieces([]);
    assert.equal(panel.selection, undefined);
    assert.equal((document.getElementById('build-editor') as unknown as FakeElement).hidden, true);
  });
});

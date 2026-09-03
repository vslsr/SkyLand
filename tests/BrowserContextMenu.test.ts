import assert from 'node:assert/strict';
import test from 'node:test';
import { suppressBrowserContextMenu } from '../src/input/contextMenu.ts';

function dispatchContextMenu(target: EventTarget, eventTarget: unknown): Event {
  const event = new Event('contextmenu', { cancelable: true });
  Object.defineProperty(event, 'target', { value: eventTarget, configurable: true });
  target.dispatchEvent(event);
  return event;
}

test('游戏画面上的右键不再弹出浏览器菜单', () => {
  const documentTarget = new EventTarget() as unknown as Document;
  const dispose = suppressBrowserContextMenu({ target: documentTarget });

  try {
    const canvasEvent = dispatchContextMenu(documentTarget, { tagName: 'CANVAS' });
    assert.equal(canvasEvent.defaultPrevented, true);
  } finally {
    dispose();
  }
});

test('文本输入控件保留原生复制粘贴菜单', () => {
  const documentTarget = new EventTarget() as unknown as Document;
  const dispose = suppressBrowserContextMenu({ target: documentTarget });

  try {
    assert.equal(dispatchContextMenu(documentTarget, { tagName: 'INPUT' }).defaultPrevented, false);
    assert.equal(
      dispatchContextMenu(documentTarget, { tagName: 'TEXTAREA' }).defaultPrevented,
      false,
    );
    assert.equal(
      dispatchContextMenu(documentTarget, { tagName: 'DIV', isContentEditable: true })
        .defaultPrevented,
      false,
    );
  } finally {
    dispose();
  }
});

test('allowTextEntry 关闭后连输入框上的菜单也一起屏蔽', () => {
  const documentTarget = new EventTarget() as unknown as Document;
  const dispose = suppressBrowserContextMenu({
    target: documentTarget,
    allowTextEntry: false,
  });

  try {
    assert.equal(dispatchContextMenu(documentTarget, { tagName: 'INPUT' }).defaultPrevented, true);
  } finally {
    dispose();
  }
});

test('卸载之后浏览器默认行为恢复', () => {
  const documentTarget = new EventTarget() as unknown as Document;
  suppressBrowserContextMenu({ target: documentTarget })();

  assert.equal(dispatchContextMenu(documentTarget, { tagName: 'CANVAS' }).defaultPrevented, false);
});

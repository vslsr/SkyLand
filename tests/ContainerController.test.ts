import assert from 'node:assert/strict';
import test from 'node:test';
import { ContainerController } from '../src/controllers/ContainerController.ts';
import { ContainerComponent, InventoryComponent } from '../shared/actor/index.mjs';
import type { InventoryCommand } from '../src/network/messages.ts';

/** 只记录调用的 View 替身：这一层测的是时序，不是 DOM。 */
function fakeView() {
  const renders: (string | undefined)[] = [];
  const handlers: { transfer?: Function; storeAll?: Function } = {};
  return {
    renders,
    handlers,
    page: {
      onTransfer(handler: Function) { handlers.transfer = handler; },
      onStoreAll(handler: Function) { handlers.storeAll = handler; },
      setContainer(view: { actorId: string } | undefined) { renders.push(view?.actorId); },
    },
  };
}

function harness(openActorId: string | undefined) {
  const container = new ContainerComponent({ slotCapacity: 24, label: '储物箱', reach: 3 });
  container.add('wood', 4);
  const state = {
    openActorId,
    open: false,
    /** 每次 setOpen 都记一笔，闪烁会表现为 [false, true, false]。 */
    opens: [] as boolean[],
    sent: [] as InventoryCommand[],
  };
  const view = fakeView();
  const controller = new ContainerController(view.page as never, {
    getInventory: () => new InventoryComponent({ slotCapacity: 8 }),
    getContainer: (actorId) => (actorId === state.openActorId ? container : undefined),
    findOpenContainerActorId: () => state.openActorId,
    isOpen: () => state.open,
    setOpen: (open) => { state.open = open; state.opens.push(open); },
    send: (command) => state.sent.push(command),
  });
  return { controller, state, view, container };
}

test('关闭时不闪：确认到达之前，快照不会把页面推回来', () => {
  const { controller, state } = harness('chest-1');
  controller.sync();
  assert.deepEqual(state.opens, [true], '第一帧快照打开');

  controller.requestClose();
  assert.deepEqual(state.opens, [true, false], '点 X 立刻收起');
  assert.deepEqual(state.sent, [{ kind: 'container:close', actorId: 'chest-1' }]);

  // 关闭还在路上：服务端这一帧仍然认为我开着它。没有在途标记的话，
  // 这一次 sync 会把页面推回来，表现就是关闭时闪一下。
  controller.sync();
  assert.deepEqual(state.opens, [true, false], '不该重新打开');

  // 服务端确认到账。
  state.openActorId = undefined;
  controller.sync();
  assert.deepEqual(state.opens, [true, false], '已经是关着的，不再多发一次');
});

test('在途关闭只压住那一个箱子，走到另一个箱子前照常打开', () => {
  const { controller, state } = harness('chest-1');
  controller.sync();
  controller.requestClose();

  // 走到另一个箱子前按 E：这次打开和刚才那次关闭无关，不该被压掉。
  state.openActorId = 'chest-2';
  controller.sync();
  assert.equal(state.open, true, '换一个箱子照常打开');

  // 而且 actorId 变了就说明上一次关闭已经到账，标记清掉；再回到 chest-1 也能开。
  state.openActorId = 'chest-1';
  controller.sync();
  assert.equal(state.open, true, '重新开同一个箱子不该被上一次的关闭压掉');
});

test('没开着任何容器时点关闭，不发无主的消息', () => {
  const { controller, state } = harness(undefined);
  controller.requestClose();
  assert.deepEqual(state.sent, []);
});

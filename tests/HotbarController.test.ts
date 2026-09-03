import assert from 'node:assert/strict';
import test from 'node:test';
import { HotbarController } from '../src/controllers/HotbarController.ts';
import { InventoryComponent } from '../shared/actor/index.mjs';
import type { InventoryCommand } from '../src/network/messages.ts';
import { PlayerInputTags } from '../src/input/config/playerInput.ts';

/** 只保留交互键那一条绑定的输入替身：这一层测的是按住时序。 */
function harness(heldActorId: string | undefined) {
  const handlers = new Map<unknown, (event: { phase: string }) => void>();
  const input = {
    enabled: true,
    bind: (tag: unknown, handler: (event: { phase: string }) => void) => {
      handlers.set(tag, handler);
      return () => handlers.delete(tag);
    },
  } as never;
  const sent: InventoryCommand[] = [];
  let clock = 0;
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 4, stowHoldSeconds: 0.6 });
  const controller = new HotbarController(input, {
    getInventory: () => inventory,
    getHeldActorId: () => heldActorId,
    isActive: () => true,
    send: (command) => sent.push(command),
    setProgress: () => undefined,
  }, () => clock);
  const press = (phase: string) => handlers.get(PlayerInputTags.WorldInteract)?.({ phase });
  return { controller, sent, press, advance: (ms: number) => { clock += ms; } };
}

test('叼着世界物件时，交互键也走按住计时——按下不结算，松手才发', () => {
  // 蘑菇不在快捷栏里，heldItemType 是 undefined。按 itemType 判断「手上有没有东西」
  // 会让它整条漏掉计时，落回按下即触发，表现就是一按就掉。
  const { sent, press, advance } = harness('mushroom-1');

  press('started');
  assert.deepEqual(sent, [{ kind: 'stow:begin' }], '按下只开始计时');

  advance(120);
  press('completed');
  assert.deepEqual(
    sent,
    [{ kind: 'stow:begin' }, { kind: 'stow:release' }],
    '松手才结算；短按还是长按由服务端按自己的计时判定',
  );
});

test('空手时交互键不进按住路径，让就近拾取按下即触发', () => {
  const { sent, press } = harness(undefined);
  press('started');
  press('completed');
  assert.deepEqual(sent, [], '空手时这条路径完全不参与');
});

test('按住中途手上那件没了，这次按住作废', () => {
  let held: string | undefined = 'mushroom-1';
  const handlers = new Map<unknown, (event: { phase: string }) => void>();
  const input = {
    enabled: true,
    bind: (tag: unknown, handler: (event: { phase: string }) => void) => {
      handlers.set(tag, handler);
      return () => handlers.delete(tag);
    },
  } as never;
  const sent: InventoryCommand[] = [];
  const controller = new HotbarController(input, {
    getInventory: () => new InventoryComponent({ slotCapacity: 8 }),
    getHeldActorId: () => held,
    isActive: () => true,
    send: (command) => sent.push(command),
    setProgress: () => undefined,
  }, () => 0);

  handlers.get(PlayerInputTags.WorldInteract)?.({ phase: 'started' });
  assert.deepEqual(sent, [{ kind: 'stow:begin' }]);

  // 别人抢走了、或者服务端把它掉了：这次按住指向的东西已经不在手上。
  held = undefined;
  controller.update();
  assert.deepEqual(sent, [{ kind: 'stow:begin' }, { kind: 'stow:cancel' }]);
});

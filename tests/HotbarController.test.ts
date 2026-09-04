import assert from 'node:assert/strict';
import test from 'node:test';
import { HotbarController } from '../src/controllers/HotbarController.ts';
import { InventoryComponent } from '../shared/actor/index.mjs';
import type { HeldItemProgress } from '../src/controllers/HotbarController.ts';
import type { InventoryCommand } from '../src/network/messages.ts';
import { ItemUseInputTags, PlayerInputTags } from '../src/input/config/playerInput.ts';

/** 只保留交互键那一条绑定的输入替身：这一层测的是按住时序。 */
function harness(initialHeldActorId: string | undefined) {
  let heldActorId = initialHeldActorId;
  const handlers = new Map<unknown, (event: { phase: string }) => void>();
  const input = {
    enabled: true,
    bind: (tag: unknown, handler: (event: { phase: string }) => void) => {
      handlers.set(tag, handler);
      return () => handlers.delete(tag);
    },
  } as never;
  const sent: InventoryCommand[] = [];
  const progress: (HeldItemProgress | undefined)[] = [];
  let clock = 0;
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 9, stowHoldSeconds: 0.6 });
  const controller = new HotbarController(input, {
    getInventory: () => inventory,
    getHeldActorId: () => heldActorId,
    isActive: () => true,
    getInputLabel: () => 'E',
    send: (command) => sent.push(command),
    setProgress: (next) => progress.push(next),
  }, () => clock);
  const press = (phase: string) => handlers.get(PlayerInputTags.WorldInteract)?.({ phase });
  const use = (phase: string) => handlers.get(ItemUseInputTags.primary)?.({ phase });
  return {
    controller,
    inventory,
    sent,
    progress,
    press,
    use,
    /** 快照到账：服务端换手时手持表现体会换一个新 id。 */
    setHeldActorId: (next: string | undefined) => { heldActorId = next; },
    advance: (ms: number) => { clock += ms; },
  };
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
    getInputLabel: () => 'E',
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

test('按住期间把要按着的那个键交给界面：提示这时正在淡出，圈旁边得自己写', () => {
  const { controller, progress, press, advance } = harness('mushroom-1');

  press('started');
  advance(300);
  controller.update();
  const halfway = progress.at(-1);
  assert.equal(halfway?.kind, 'stow');
  assert.equal(halfway?.onHotbar, false, '叼着的蘑菇没有格子，圈画在准星下方');
  assert.equal(halfway?.inputLabel, 'E');
  assert.equal(halfway?.label, '收进背包');
  assert.ok(halfway!.ratio > 0 && halfway!.ratio < 1, `进度应当在中途，实际 ${halfway?.ratio}`);

  advance(400);
  controller.update();
  assert.equal(progress.at(-1)?.ratio, 1, '按满之后圈应当满');

  press('completed');
  assert.equal(progress.at(-1), undefined, '松手立刻收掉圈');
});

test('长按物品：圈满那一刻就结束，松手不再发第二条命令', () => {
  // 果子是 hold / 1.2 秒。激活发生在倒计时走完那一刻，服务端自己动手，
  // 客户端只负责画圈——所以松手时不该再补一条 use:release。
  const bar = harness('held-1');
  bar.inventory.add('fruit', 2);
  bar.inventory.assignHotbarSlot(0, 'fruit');
  bar.inventory.setActiveHotbarSlot(0);

  bar.use('started');
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }]);

  bar.advance(600);
  bar.controller.update();
  const halfway = bar.progress.at(-1);
  assert.equal(halfway?.kind, 'use');
  assert.equal(halfway?.action, 'eat', '这一段是在嚼，界面据此让模型抖起来');
  assert.equal(halfway?.onHotbar, true, '手持物品的圈画在物品栏那一格上');
  assert.ok(halfway!.ratio > 0.4 && halfway!.ratio < 0.6, `圈应当在中途，实际 ${halfway?.ratio}`);

  bar.advance(700);
  bar.controller.update();
  assert.equal(bar.progress.at(-1), undefined, '圈满就结束，不停在满圈上');

  bar.use('completed');
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }], '倒计时已经走完，松手没有含义');
});

test('长按物品中途松手是取消：没走完的那次由服务端按自己的计时判定', () => {
  const bar = harness('held-1');
  bar.inventory.add('fruit', 2);
  bar.inventory.assignHotbarSlot(0, 'fruit');
  bar.inventory.setActiveHotbarSlot(0);

  bar.use('started');
  bar.advance(300);
  bar.use('completed');
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }, { kind: 'use:release' }]);
});

test('没有用法的东西按使用键毫无反应', () => {
  // 木头的目录里没有 use。按键在它身上就该什么都不发生，而不是发一条服务端
  // 随后拒绝的命令，也不该画一个按下去没结果的圈。
  const bar = harness('held-1');
  bar.inventory.add('wood', 3);
  bar.inventory.assignHotbarSlot(0, 'wood');
  bar.inventory.setActiveHotbarSlot(0);

  bar.use('started');
  bar.advance(2000);
  bar.controller.update();
  assert.deepEqual(bar.sent, [], '没有用法就不发命令');
  assert.equal(bar.progress.at(-1), undefined, '也不画圈');

  bar.use('completed');
  assert.deepEqual(bar.sent, []);
});

test('背包里点出来的那件优先，而且它的圈不画在物品栏上', () => {
  const bar = harness(undefined);
  bar.inventory.add('fruit', 1);
  // 手上什么都没有，但玩家刚在背包里点了「使用」。
  bar.controller.armItem('fruit');

  bar.use('started');
  bar.advance(300);
  bar.controller.update();
  assert.equal(bar.progress.at(-1)?.onHotbar, false, '没有格子的那次要画在准星下方');

  // 换手会撤销它：那条能力已经被服务端换掉了，客户端不该继续替它画圈。
  bar.controller.armItem(undefined);
  bar.use('canceled');
  assert.deepEqual(bar.sent.at(-1), { kind: 'use:cancel' });
});

test('点「使用」之后立刻按下：不等快照就认得出用的是哪件东西', () => {
  // 快照 10Hz。菜单里点完「使用」到下一帧快照回来有 100 毫秒，玩家在这一段里按下
  // 的那一下，如果要等「物品栏账上有没有」才认，会被整条忽略——表现就是「点了使用，
  // 按下去没反应」。所以界面在点的同一刻就把这件东西交给输入层。
  const bar = harness(undefined);
  bar.controller.armItem('fruit', { onHotbar: true });

  bar.use('started');
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }]);
  bar.advance(600);
  bar.controller.update();
  const halfway = bar.progress.at(-1);
  assert.equal(halfway?.action, 'eat');
  assert.equal(halfway?.onHotbar, true, '属于物品栏的那次，圈画在那一格上');

  // 快照到了：手上多了一个新的手持表现体。这次按住说的还是同一件东西，不该作废。
  bar.setHeldActorId('held-2');
  bar.inventory.add('fruit', 1);
  bar.inventory.assignHotbarSlot(0, 'fruit');
  bar.inventory.setActiveHotbarSlot(0);
  bar.advance(300);
  bar.controller.update();
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }], '换了个表现体不是换手');
  assert.ok((bar.progress.at(-1)?.ratio ?? 0) > 0.7, '倒计时应当接着走');

  bar.advance(400);
  bar.controller.update();
  assert.equal(bar.progress.at(-1), undefined, '圈满就结束');
});

test('按住途中真的换了东西，这次使用才作废', () => {
  const bar = harness('held-1');
  bar.inventory.add('fruit', 1);
  bar.inventory.add('mushroom', 1);
  bar.inventory.assignHotbarSlot(0, 'fruit');
  bar.inventory.assignHotbarSlot(1, 'mushroom');
  bar.inventory.setActiveHotbarSlot(0);

  bar.use('started');
  bar.advance(300);
  // 玩家自己按了数字键：手上换成了另一件东西，这次按住指向的已经不在手上了。
  bar.inventory.setActiveHotbarSlot(1);
  bar.controller.update();
  assert.deepEqual(bar.sent.at(-1), { kind: 'use:cancel' });
});

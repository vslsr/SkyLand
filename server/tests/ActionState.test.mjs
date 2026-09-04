import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerScene } from '../scene/ServerScene.mjs';
import { SceneCatalog } from '../scenes/SceneCatalog.mjs';
import { ACTION_STATE_COMPONENT, INVENTORY_COMPONENT } from '../../shared/actor/index.mjs';
import { fireSeconds } from '../../shared/animation/actionStates.mjs';
import './initRapier.mjs';

/**
 * 动作表现的复制通道。
 *
 * 过网的是**状态**（谁、在做什么、从什么时候开始、多长），不是每一帧的姿态。所以
 * 这一份测的是：状态在该进的时候进、该退的时候退，以及它进了快照——别人看不看得见
 * 这段动画，全取决于这一条。
 */

function createClock(startAt = 1_000_000) {
  let current = startAt;
  return { now: () => current, advance(seconds) { current += seconds * 1000; } };
}

async function createScene(clock) {
  const catalog = await SceneCatalog.load();
  const scene = new ServerScene(catalog.require('grassland'), { now: clock.now });
  scene.addPlayer({ id: 'p1', name: '动作测试员', slot: 0 });
  const player = scene.players.get('p1');
  return {
    scene,
    player,
    inventory: player.getComponent(INVENTORY_COMPONENT),
    action: player.getComponent(ACTION_STATE_COMPONENT),
  };
}

let sequence = 0;
const send = (scene, command) => scene.applyInventoryCommand('p1', {
  sequence: (sequence += 1),
  command,
});

/** 别人看到的那一份：快照里这名玩家的动作状态。 */
function actionInSnapshot(scene, viewerId) {
  return scene.createSnapshot(viewerId).players.find((entry) => entry.id === 'p1')?.action;
}

test('按住那一段进状态，快照发给所有人——别人也看得见他在吃', async () => {
  const clock = createClock();
  const { scene, inventory, action } = await createScene(clock);
  inventory.add('fruit', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'fruit' });
  send(scene, { kind: 'select', slotIndex: 0 });
  assert.equal(action.isActive, false, '拿着还没按下去，不算在做什么');

  send(scene, { kind: 'use:begin' });
  assert.equal(action.state, 'eat.hold');
  assert.equal(action.itemType, 'fruit');
  assert.equal(action.duration, 1.2, '果子按住 1.2 秒，两端读同一个数');
  assert.equal(action.startedAt, clock.now(), '相位从权威开始时刻推导');

  // 背包只发给本人，动作发给所有人：别人在做什么本来就是看得见的事。
  const seenByOther = actionInSnapshot(scene, 'someone-else');
  assert.deepEqual(seenByOther, {
    state: 'eat.hold',
    itemType: 'fruit',
    startedAt: action.startedAt,
    duration: 1.2,
    revision: action.revision,
  });
});

test('圈满结算那一下自己是一段动作，演完回到没在做什么', async () => {
  const clock = createClock();
  const { scene, inventory, action } = await createScene(clock);
  inventory.add('fruit', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'fruit' });
  send(scene, { kind: 'select', slotIndex: 0 });
  send(scene, { kind: 'use:begin' });

  clock.advance(1.3);
  scene.update();
  assert.equal(inventory.hotbar[0].quantity, 1, '倒计时走完那一刻扣掉一个');
  assert.equal(action.state, 'eat.fire', '咽下去那一下接着演');
  assert.equal(action.duration, fireSeconds('eat'));

  // 演完自己退场，否则快照会一直说这个人在咽同一口东西。
  clock.advance(fireSeconds('eat') + 0.05);
  scene.update();
  assert.equal(action.isActive, false);
  assert.equal(actionInSnapshot(scene, 'p1'), undefined, '没在做什么时整条不下发');
});

test('打断就是回到没在做什么：不需要一条会丢的 stop 事件', async () => {
  const clock = createClock();
  const { scene, inventory, action } = await createScene(clock);
  inventory.add('fruit', 2);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'fruit' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  send(scene, { kind: 'use:cancel' });
  assert.equal(action.isActive, false, '中途松手/被盖住：状态回到 Idle');

  // 按住到一半换手也一样：那段动作不再成立。
  send(scene, { kind: 'use:begin' });
  assert.equal(action.state, 'eat.hold');
  send(scene, { kind: 'select', slotIndex: 1 });
  assert.equal(action.isActive, false, '换手之后不该还在演上一件东西');
});

test('连着做两次同一件事：状态一样，靠 revision 分得出是两次', async () => {
  const clock = createClock();
  const { scene, inventory, action } = await createScene(clock);
  inventory.add('fruit', 3);
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'fruit' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  const first = action.revision;
  send(scene, { kind: 'use:cancel' });
  send(scene, { kind: 'use:begin' });
  assert.equal(action.state, 'eat.hold');
  assert.ok(action.revision > first, 'bool 或者「状态变了没有」会把第二次漏掉');
});

test('蓄力也走同一条：弹弓拉弓那一秒别人看得见', async () => {
  const clock = createClock();
  const { scene, inventory, action } = await createScene(clock);
  inventory.add('slingshot', 1);
  inventory.add('stone', 2);
  send(scene, {
    kind: 'ammo:load',
    slot: { kind: 'backpack', itemType: 'slingshot' },
    source: { kind: 'backpack', itemType: 'stone' },
  });
  send(scene, { kind: 'assign', slotIndex: 0, itemType: 'slingshot' });
  send(scene, { kind: 'select', slotIndex: 0 });

  send(scene, { kind: 'use:begin' });
  assert.equal(action.state, 'shoot.charge');
  assert.equal(action.duration, 0.9);

  // 拉满了不自己射出去，状态也就停在 charge 上等松手。
  clock.advance(2);
  scene.update();
  assert.equal(action.state, 'shoot.charge');

  send(scene, { kind: 'use:release' });
  // 发射本身没有执行器（那是武器系统的事），这一下没做成，所以不演 fire。
  assert.equal(action.isActive, false, '空转的一次不该有动作');
});

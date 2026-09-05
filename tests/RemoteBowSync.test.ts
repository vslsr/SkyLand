import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteBowSync } from '../src/weapons/RemoteBowSync.ts';
import type { SnapshotPlayer } from '../src/network/protocol.ts';

function harness() {
  const draws: Array<{ actorId: string; charge: number }> = [];
  const cleared: (string | undefined)[] = [];
  const releases: string[] = [];
  const sync = new RemoteBowSync({
    localPlayerId: () => 'me',
    setBowDraw: (actorId, charge) => draws.push({ actorId, charge }),
    clearBowDraw: (actorId) => cleared.push(actorId),
    releaseBow: (actorId) => releases.push(actorId),
  });
  return { sync, draws, cleared, releases };
}

function player(overrides: Partial<SnapshotPlayer>): SnapshotPlayer {
  return {
    id: 'other', name: '别人', x: 0, y: 1, z: 0, yaw: 0, speed: 0,
    ackTick: 0, sequence: 0, heldActorId: 'held-other-1',
    ...overrides,
  } as SnapshotPlayer;
}

test('别人拉弓：比例由这一侧按同一个 holdRatio 算出来', () => {
  const bar = harness();
  bar.sync.apply([player({ charge: { startedAt: 1_000, holdSeconds: 1 } })], 1_500);
  assert.deepEqual(bar.draws.at(-1), { actorId: 'held-other-1', charge: 0.5 });

  // 服务端下发的是起止，不是算好的比例，所以时间自己往前走就够了。
  bar.sync.apply([player({ charge: { startedAt: 1_000, holdSeconds: 1 } })], 2_400);
  assert.equal(bar.draws.at(-1)?.charge, 1, '拉满了就停在满');
});

test('别人松手：弓归零，弦只抖一次', () => {
  const bar = harness();
  const shot = { revision: 3 };
  // 第一次看见他就带着这一发：不补抖——他进屋之前射的箭早就落地了。
  bar.sync.apply([player({ weaponShot: shot })], 1_000);
  assert.deepEqual(bar.releases, []);
  assert.deepEqual(bar.cleared.at(-1), 'held-other-1', '没在蓄力就是松着的');

  // 快照里那条留着不撤，所以同一个计数再来几次也只是同一发。
  bar.sync.apply([player({ weaponShot: shot })], 1_100);
  assert.deepEqual(bar.releases, []);

  bar.sync.apply([player({ weaponShot: { revision: 4 } })], 1_200);
  assert.deepEqual(bar.releases, ['held-other-1'], '计数变了才是新的一发，弦跟着回弹');
  // 箭不在这一侧生：它是复制过来的 Actor，落在哪儿由它自己说了算。
});

test('自己那一份不从快照来：本地按住已经驱动过一次了', () => {
  const bar = harness();
  bar.sync.apply([
    player({ id: 'me', heldActorId: 'held-me-1', charge: { startedAt: 0, holdSeconds: 1 },
      weaponShot: { revision: 1 } }),
  ], 500);
  assert.deepEqual(bar.draws, [], '自己的弓由本地按住驱动，等一趟网络回来会慢半拍');
  assert.deepEqual(bar.releases, [], '自己撒手那一下也是本地驱动的');
});

test('AI 射的那一发走同一条路：接收方不问射手是不是玩家', () => {
  const bar = harness();
  // Actor 快照上的形状和玩家那条一模一样，只是没有 heldActorId——AI 手上还没有
  // 一把画出来的弓，所以它那一发只看得见箭，没有弓的形变。
  const archer = { id: 'legged-slime-archer-01' } as never;
  bar.sync.apply([{ ...archer, weaponShot: { revision: 1 } }], 1_000);
  bar.sync.apply([{ ...archer, weaponShot: { revision: 2 } }], 1_100);
  // 计数确实认了（同一条去重表），但没有手持体就没有弦可弹。箭本身是复制过来的
  // Actor，不由这一侧生。
  assert.deepEqual(bar.releases, []);
  assert.deepEqual(bar.cleared.at(-1), undefined, 'Actor 没有手持体');
});

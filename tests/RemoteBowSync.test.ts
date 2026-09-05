import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteBowSync } from '../src/weapons/RemoteBowSync.ts';
import type { SnapshotPlayer } from '../src/network/protocol.ts';

function harness() {
  const draws: Array<{ actorId: string; charge: number }> = [];
  const cleared: (string | undefined)[] = [];
  const releases: string[] = [];
  const arrows: unknown[] = [];
  const sync = new RemoteBowSync({
    localPlayerId: () => 'me',
    setBowDraw: (actorId, charge) => draws.push({ actorId, charge }),
    clearBowDraw: (actorId) => cleared.push(actorId),
    releaseBow: (actorId) => releases.push(actorId),
    sampleGroundHeight: () => 0,
    spawnArrow: (state) => arrows.push(state),
  }, { muzzleHeight: 0.62 });
  return { sync, draws, cleared, releases, arrows };
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

test('别人松手：弓归零，箭只射一次', () => {
  const bar = harness();
  const shot = { revision: 3, x: 2, y: 1, z: 3, impactX: 2, impactZ: 20, ratio: 1 };
  // 第一次看见他就带着这一发：不补射——他进屋之前射的箭早就落地了。
  bar.sync.apply([player({ weaponShot: shot })], 1_000);
  assert.deepEqual(bar.arrows, []);
  assert.deepEqual(bar.cleared.at(-1), 'held-other-1', '没在蓄力就是松着的');

  // 快照里那条留着不撤，所以同一个计数再来几次也只是同一发。
  bar.sync.apply([player({ weaponShot: shot })], 1_100);
  assert.deepEqual(bar.arrows, []);

  bar.sync.apply([player({ weaponShot: { ...shot, revision: 4 } })], 1_200);
  assert.equal(bar.arrows.length, 1, '计数变了才是新的一发');
  assert.deepEqual(bar.releases, ['held-other-1'], '弦跟着回弹');
  assert.deepEqual(bar.arrows[0], {
    originX: 2,
    // 出手点和射手自己那条弧同一个高度，不是从脚底出去。
    originY: 1.62,
    originZ: 3,
    impactX: 2,
    impactY: 0,
    impactZ: 20,
    ratio: 1,
  });
});

test('自己那一份不从快照来：本地按住已经驱动过一次了', () => {
  const bar = harness();
  bar.sync.apply([
    player({ id: 'me', heldActorId: 'held-me-1', charge: { startedAt: 0, holdSeconds: 1 },
      weaponShot: { revision: 1, x: 0, y: 0, z: 0, impactX: 0, impactZ: 5, ratio: 1 } }),
  ], 500);
  assert.deepEqual(bar.draws, [], '自己的弓由本地按住驱动，等一趟网络回来会慢半拍');
  assert.deepEqual(bar.arrows, []);
});

test('AI 射的那一箭走同一条路：接收方不问射手是不是玩家', () => {
  const bar = harness();
  // Actor 快照上的形状和玩家那条一模一样，只是没有 heldActorId——AI 手上还没有
  // 一把画出来的弓，所以它只有箭、没有弓的形变。
  const archer = { id: 'legged-slime-archer-01' } as never;
  const shot = { revision: 1, x: 9, y: 0, z: 3, impactX: 0, impactZ: 0, ratio: 0.4 };
  bar.sync.apply([{ ...archer, weaponShot: shot }], 1_000);
  assert.deepEqual(bar.arrows, [], '第一次看见它不补射');

  bar.sync.apply([{ ...archer, weaponShot: { ...shot, revision: 2 } }], 1_100);
  assert.equal(bar.arrows.length, 1);
  assert.deepEqual(bar.arrows[0], {
    originX: 9, originY: 0.62, originZ: 3,
    impactX: 0, impactY: 0, impactZ: 0, ratio: 0.4,
  });
  assert.deepEqual(bar.releases, [], '没有手持体就没有弦可弹');
});

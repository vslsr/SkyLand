import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientActorSystem } from '../src/actors/ClientActorSystem';
import type { SnapshotActor } from '../src/network/protocol';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';
import { INTERPOLATION_DELAY_MS } from '../shared/networkTuning.mjs';

/**
 * 分帧建 Replica（实现路径文档 §2 的第 1 项）。
 *
 * 打点量到进房间那一帧 `render-spawn` 是 31–146 ms：第一份快照里视野内的 Actor
 * 会在同一帧里被一次性建出来，而每个 Replica 都要程序化生成一整棵模型。
 * 这组用例锁住分帧之后的三条性质：预算、进度、以及「快照顺序不影响层级」。
 *
 * 时钟是注入的：真实的 `performance.now()` 会让「这一帧还剩多少预算」变成计时竞态。
 */
const CRATE = {
  model: 'line-art-cargo-crate',
  width: 0.8,
  height: 0.6,
  depth: 0.8,
  bodyColor: '#c8b79a',
  strapColor: '#8a6238',
  inkColor: '#171614',
} as const;

const definition = {
  schemaVersion: 1,
  id: 'spawn-budget',
  displayName: 'spawn',
  description: 'spawn budget test',
  capacity: 8,
  sceneComponents: [],
  actors: [],
  actorArchetypes: [
    { schemaVersion: 1, id: 'crate', components: { render: CRATE } },
    { schemaVersion: 1, id: 'raft', components: { render: CRATE } },
  ],
  renderer: {},
  gameplay: {
    playerActor: { archetypeId: 'player-slime' },
    worldProps: {},
    bounds: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 },
  },
} as unknown as SceneDefinition;

function crate(id: string, parentActorId: string | null = null): SnapshotActor {
  return {
    id,
    archetypeId: 'crate',
    parentActorId,
    revision: 1,
    transform: { x: 0, y: 0, z: 0, yaw: 0 },
    localTransform: { x: 0, y: 0, z: 0, yaw: 0 },
  } as unknown as SnapshotActor;
}

/** 每次 `spawnClock()` 前进 1 ms：预算 N 毫秒就正好放行 N 个。 */
function createSpawnClock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

interface SpawnHarness {
  readonly system: ClientActorSystem;
  /** 快照时间轴。和 `spawnClock` 是两回事：那个只管这一帧的建模预算。 */
  setNow(milliseconds: number): void;
  /** 断言只看有没有——`Actor` 有指回世界的引用，交给 assert 去做 diff 会卡死。 */
  exists(actorId: string): boolean;
}

function createSystem(spawnBudgetMilliseconds: number): SpawnHarness {
  let now = 1_000;
  const system = new ClientActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => now,
    spawnBudgetMilliseconds,
    spawnClock: createSpawnClock(),
  } as never);
  return {
    system,
    setNow: (milliseconds: number) => { now = milliseconds; },
    exists: (actorId: string) => system.getActor(actorId) !== undefined,
  };
}

test('一帧只建预算之内的 Replica，剩下的下一帧接着建', () => {
  const harness = createSystem(3);
  const snapshots = [crate('c1'), crate('c2'), crate('c3'), crate('c4'), crate('c5')];
  harness.system.syncSnapshots(snapshots, 1_000, 1_000);

  harness.system.update(1 / 60, 0);
  const first = snapshots.filter((entry) => harness.exists(entry.id)).length;
  assert.ok(first > 0 && first < snapshots.length, `第一帧建了 ${first} 个，应当既有进度又没建完`);

  // 快照集合每帧都完整重放，所以不需要待建队列：没轮到的下一帧自己会再来。
  for (let frame = 1; frame <= 5; frame += 1) harness.system.update(1 / 60, frame / 60);
  for (const entry of snapshots) {
    assert.ok(harness.exists(entry.id), `${entry.id} 始终没有被建出来`);
  }
  harness.system.dispose();
});

test('预算为 0 也保证每帧建一个，不会永远排不上', () => {
  const harness = createSystem(0);
  const snapshots = [crate('c1'), crate('c2')];
  harness.system.syncSnapshots(snapshots, 1_000, 1_000);

  harness.system.update(1 / 60, 0);
  assert.equal(snapshots.filter((entry) => harness.exists(entry.id)).length, 1);
  harness.system.update(1 / 60, 1 / 60);
  assert.equal(snapshots.filter((entry) => harness.exists(entry.id)).length, 2);
  harness.system.dispose();
});

test('这一帧没轮到的 Actor 不会留下半个状态', () => {
  const harness = createSystem(0);
  harness.system.syncSnapshots([crate('c1'), crate('c2')], 1_000, 1_000);
  harness.system.update(1 / 60, 0);
  // 只建了一个：另一个既不在世界里，也没有占住渲染世界的槽位。
  assert.equal(harness.system.getRenderScene().liveProxies().length, 1);
  harness.system.dispose();
});

test('分帧之后仍然「快照顺序不影响层级」：子节点排在父节点前也照样挂上去', () => {
  // 预算只够建一个，而子节点排在前面：必须先建父节点，两个都建不成也不能把
  // 子节点当成「挂在外部 Actor 上」建出来。
  const harness = createSystem(0);
  const child = crate('child', 'parent');
  const parent = { ...crate('parent'), archetypeId: 'raft' } as SnapshotActor;
  harness.system.syncSnapshots([child, parent], 1_000, 1_000);

  harness.system.update(1 / 60, 0);
  assert.equal(harness.exists('parent'), true, '父节点应当被优先建出来');
  assert.equal(harness.exists('child'), false, '预算用完时子节点必须整个推到下一帧');

  harness.system.update(1 / 60, 1 / 60);
  assert.equal(harness.exists('child'), true);
  assert.equal(harness.system.getActor('child')?.parent?.id, 'parent', '子节点没有挂到父节点上');
  harness.system.dispose();
});

test('排队期间 Actor 从快照里消失，就再也不会被建出来', () => {
  const harness = createSystem(0);
  harness.system.syncSnapshots([crate('c1'), crate('c2')], 1_000, 1_000);
  harness.system.update(1 / 60, 0);
  assert.equal(harness.exists('c1'), true);
  assert.equal(harness.exists('c2'), false, '预算只够建一个');

  // c2 还没轮到就离开了视野。要让新快照真的被采样到，时间轴必须越过插值延迟。
  harness.system.syncSnapshots([crate('c1')], 1_100, 1_100);
  harness.setNow(1_100 + INTERPOLATION_DELAY_MS + 10);
  for (let frame = 1; frame <= 3; frame += 1) harness.system.update(1 / 60, frame / 60);
  assert.equal(harness.exists('c2'), false, '离开快照的 Actor 不该被补建');
  harness.system.dispose();
});

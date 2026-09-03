import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../src/network/SnapshotBuffer.ts';
import { INTERPOLATION_DELAY_MS } from '../shared/networkTuning.mjs';

function snapshot(serverTime: number, players: Array<Record<string, unknown>>) {
  return { sceneId: 'grassland', tick: serverTime, serverTime, players } as never;
}

function player(id: string, x: number, z: number, yaw = 0, speed = 0, y?: number) {
  return { id, name: id, x, ...(y === undefined ? {} : { y }), z, yaw, speed, sequence: 1 };
}

/** 本地时钟与服务器完全同步时，渲染时间就是「现在减去插值延迟」。 */
function buildBuffer() {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1000, [player('a', 0, 0, 0, 0, -0.8), player('b', 10, 0)]), 1000);
  buffer.push(snapshot(1100, [player('a', 2, 4, 0, 0, -0.2), player('b', 10, 0)]), 1100);
  return buffer;
}

test('两份快照之间做线性插值', () => {
  const buffer = buildBuffer();
  const states = buffer.sample(1050 + INTERPOLATION_DELAY_MS);
  const a = states.find((state) => state.id === 'a');

  assert.ok(Math.abs(a!.x - 1) < 1e-9);
  assert.ok(Math.abs(a!.z - 2) < 1e-9);
  assert.ok(Math.abs(a!.y! + 0.5) < 1e-9, '权威浮力 Y 需要与 XZ 一起插值');
});

test('缓冲被抽干时停在最后一份状态而不是外推', () => {
  const buffer = buildBuffer();
  const states = buffer.sample(5000 + INTERPOLATION_DELAY_MS);
  const a = states.find((state) => state.id === 'a');

  assert.equal(a!.x, 2);
  assert.equal(a!.z, 4);
});

test('朝向沿最短弧插值，不会绕远路', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1000, [player('a', 0, 0, -3.0)]), 1000);
  buffer.push(snapshot(1100, [player('a', 0, 0, 3.0)]), 1100);

  const [state] = buffer.sample(1050 + INTERPOLATION_DELAY_MS);
  // 短弧要跨过 ±π，中点的绝对值必须比两端都大。
  assert.ok(Math.abs(state.yaw) > 3.0, `实际得到 ${state.yaw}`);
});

test('新加入的玩家直接出现在自己的位置上', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1000, [player('a', 0, 0)]), 1000);
  buffer.push(snapshot(1100, [player('a', 0, 0), player('c', 7, 7)]), 1100);

  const states = buffer.sample(1050 + INTERPOLATION_DELAY_MS);
  const c = states.find((state) => state.id === 'c');
  assert.equal(c!.x, 7);
});

test('离开的玩家不再出现在采样结果里', () => {
  const buffer = buildBuffer();
  buffer.push(snapshot(1200, [player('a', 4, 8)]), 1200);

  const states = buffer.sample(1200 + INTERPOLATION_DELAY_MS);
  assert.deepEqual(states.map((state) => state.id), ['a']);
});

test('重复或乱序到达的快照被忽略', () => {
  const buffer = buildBuffer();
  buffer.push(snapshot(1100, [player('a', 99, 99)]), 1100);
  buffer.push(snapshot(900, [player('a', -99, -99)]), 1100);

  const states = buffer.sample(5000 + INTERPOLATION_DELAY_MS);
  assert.equal(states.find((state) => state.id === 'a')!.x, 2);
});

test('清空之后不再返回任何状态', () => {
  const buffer = buildBuffer();
  buffer.clear();
  assert.deepEqual(buffer.sample(5000), []);
});

test('拖拽形变只在同一次抓取内插值，换抓取时直接跳到新的命中点', () => {
  const drag = (revision: number, contactX: number, pullX: number) => ({
    revision, contactX, contactY: 0.9, contactZ: 0, pullX, pullY: 0, pullZ: 0,
  });
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1000, [{ ...player('a', 0, 0), slimeDrag: drag(1, 0, 0.2) }]), 1000);
  buffer.push(snapshot(1100, [{ ...player('a', 0, 0), slimeDrag: drag(1, 0, 0.6) }]), 1100);

  const [sameGrab] = buffer.sample(1050 + INTERPOLATION_DELAY_MS);
  assert.equal(sameGrab.slimeDrag!.revision, 1);
  assert.ok(
    Math.abs(sameGrab.slimeDrag!.pullX - 0.4) < 1e-9,
    '同一次抓取里位移应平滑到中点，10Hz 快照才不会一跳一跳',
  );

  // 松手后抓到另一处：在两个命中点之间求平均会得到谁也没抓过的假位置。
  buffer.push(snapshot(1200, [{ ...player('a', 0, 0), slimeDrag: drag(2, 0.8, 0.1) }]), 1200);
  const [regrab] = buffer.sample(1150 + INTERPOLATION_DELAY_MS);
  assert.equal(regrab.slimeDrag!.revision, 2);
  assert.equal(regrab.slimeDrag!.contactX, 0.8);
  assert.equal(regrab.slimeDrag!.pullX, 0.1);

  // 松手后快照不再带该字段，远端必须据此结束拖拽而不是保持形变。
  buffer.push(snapshot(1300, [player('a', 0, 0)]), 1300);
  const [released] = buffer.sample(1300 + INTERPOLATION_DELAY_MS);
  assert.equal(released.slimeDrag, undefined);
});

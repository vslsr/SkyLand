import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../src/network/SnapshotBuffer.ts';
import { INTERPOLATION_DELAY_MS } from '../shared/networkTuning.mjs';

function snapshot(serverTime: number, players: Array<Record<string, unknown>>) {
  return { sceneId: 'grassland', tick: serverTime, serverTime, players } as never;
}

function player(id: string, x: number, z: number, yaw = 0, speed = 0) {
  return { id, name: id, x, z, yaw, speed, sequence: 1 };
}

/** 本地时钟与服务器完全同步时，渲染时间就是「现在减去插值延迟」。 */
function buildBuffer() {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1000, [player('a', 0, 0), player('b', 10, 0)]), 1000);
  buffer.push(snapshot(1100, [player('a', 2, 4), player('b', 10, 0)]), 1100);
  return buffer;
}

test('两份快照之间做线性插值', () => {
  const buffer = buildBuffer();
  const states = buffer.sample(1050 + INTERPOLATION_DELAY_MS);
  const a = states.find((state) => state.id === 'a');

  assert.ok(Math.abs(a!.x - 1) < 1e-9);
  assert.ok(Math.abs(a!.z - 2) < 1e-9);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSnapshotForViewer } from '../network/areaOfInterest.mjs';
import { AREA_OF_INTEREST_RADIUS } from '../../shared/networkTuning.mjs';

function snapshotOf(players) {
  return { sceneId: 'grassland', tick: 1, serverTime: 0, players };
}

function playerAt(id, x, z) {
  return { id, name: id, x, z, yaw: 0, speed: 0, sequence: 1 };
}

test('远处的玩家被裁掉，近处的保留', () => {
  const snapshot = snapshotOf([
    playerAt('self', 0, 0),
    playerAt('near', AREA_OF_INTEREST_RADIUS - 1, 0),
    playerAt('far', AREA_OF_INTEREST_RADIUS + 1, 0),
  ]);

  const ids = filterSnapshotForViewer(snapshot, 'self').players.map((player) => player.id);
  assert.deepEqual(ids, ['self', 'near']);
});

test('观察者自己永远保留，和解要靠它对账', () => {
  const snapshot = snapshotOf([
    playerAt('self', 0, 0),
    playerAt('other', 10_000, 10_000),
  ]);

  const ids = filterSnapshotForViewer(snapshot, 'self').players.map((player) => player.id);
  assert.deepEqual(ids, ['self']);
});

test('距离按平面直线算，不是按坐标轴', () => {
  const diagonal = AREA_OF_INTEREST_RADIUS * 0.75;
  const snapshot = snapshotOf([playerAt('self', 0, 0), playerAt('corner', diagonal, diagonal)]);

  // 两个坐标轴上都没超，但直线距离超了
  assert.ok(Math.hypot(diagonal, diagonal) > AREA_OF_INTEREST_RADIUS);
  const ids = filterSnapshotForViewer(snapshot, 'self').players.map((player) => player.id);
  assert.deepEqual(ids, ['self']);
});

test('找不到观察者时原样返回，宁可多发也不漏发', () => {
  const snapshot = snapshotOf([playerAt('a', 0, 0), playerAt('b', 1, 1)]);
  assert.equal(filterSnapshotForViewer(snapshot, undefined), snapshot);
  assert.equal(filterSnapshotForViewer(snapshot, 'missing'), snapshot);
});

test('没有人被裁掉时不复制快照对象', () => {
  const snapshot = snapshotOf([playerAt('self', 0, 0), playerAt('near', 1, 1)]);
  assert.equal(filterSnapshotForViewer(snapshot, 'self'), snapshot);
});

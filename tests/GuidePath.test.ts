import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  GuidePath,
  GuidePathGeometry,
  MAX_GUIDE_WAYPOINTS,
} from '../src/guidance/index';
import { GuidePathComponent } from '../shared/actor/components/GuidePathComponent.mjs';
import { GuidePathVisualComponent } from '../src/actors/components/GuidePathVisualComponent';

test('GuidePathGeometry 为每个采样点创建屏幕空间线带所需的成对顶点', () => {
  const geometry = new GuidePathGeometry();
  geometry.updatePath([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(3, 0, 0),
    new THREE.Vector3(3, 0, 4),
  ]);

  assert.equal(geometry.getAttribute('position').count, 6);
  assert.equal(geometry.getAttribute('aPrevious').count, 6);
  assert.equal(geometry.getAttribute('aNext').count, 6);
  assert.equal(geometry.getIndex()?.count, 12);
  assert.equal(geometry.totalDistance, 7);
  geometry.dispose();
});

test('GuidePath 逐点推进、完成和重置', () => {
  const guide = new GuidePath({
    points: [[0, 0, 0], [2, 0, 0], [4, 0, 0]],
    curve: 'linear',
  });
  const target = new THREE.Vector3();

  assert.equal(guide.currentMarkerIndex, 0);
  assert.equal(guide.getCurrentMarkerPosition(target), true);
  assert.deepEqual(target.toArray(), [0, 0, 0]);
  assert.equal(guide.advance(), false);
  assert.equal(guide.currentMarkerIndex, 1);
  assert.equal(guide.advance(), false);
  assert.equal(guide.advance(), true);
  assert.equal(guide.currentMarkerIndex, -1);
  assert.equal(guide.getCurrentMarkerPosition(target), false);
  guide.reset();
  assert.equal(guide.currentMarkerIndex, 0);
  guide.dispose();
});

test('GuidePath 拒绝会让资源随任意路点数量增长的配置', () => {
  const points = Array.from(
    { length: MAX_GUIDE_WAYPOINTS + 1 },
    (_, index) => [index, 0, 0] as const,
  );
  assert.throws(() => new GuidePath({ points }), /2-64/);
});

test('客户端视觉只应用服务器 GuidePathComponent 的离散状态', () => {
  const state = new GuidePathComponent({
    points: [[0, 0, 0], [2, 0, 0], [4, 0, 0]],
    curve: 'linear',
  });
  const visual = new GuidePathVisualComponent(state);
  visual.sync();
  assert.equal(visual.guide.currentMarkerIndex, 0);

  state.advance();
  visual.sync();
  assert.equal(visual.guide.currentMarkerIndex, 1);

  state.setPath([[1, 0, 1], [3, 0, 1]], { curve: 'catmull-rom' });
  state.setCurrentPointIndex(2);
  visual.sync();
  assert.equal(visual.guide.markerCount, 2);
  assert.equal(visual.guide.isComplete, true);
  visual.onEndPlay();
});

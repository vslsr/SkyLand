import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  GuidePath,
  GuidePathGeometry,
  MAX_GUIDE_WAYPOINTS,
} from '../src/guidance/index';
import { GuidePathComponent } from '../shared/actor/components/GuidePathComponent.mjs';
import { Actor } from '../shared/actor/Actor.mjs';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import { RenderProxyComponent } from '../src/actors/components/RenderProxyComponent';
import { ActorGuidePathSyncSystem } from '../src/actors/systems/ActorGuidePathSyncSystem';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';

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

test('GuidePath 使用 Wayfinder 单线与单层发光 Billboard，不创建线稿阴影', () => {
  const guide = new GuidePath({
    points: [[0, 0, 0], [2, 0, 0]],
    curve: 'linear',
  });

  assert.equal(guide.root.getObjectByName('guide-path-shadow'), undefined);
  assert.ok(guide.root.getObjectByName('guide-path-line'));
  const markerSprites: THREE.Sprite[] = [];
  guide.root.traverse((object) => {
    if (object.name === 'guide-path-wayfinder-marker') markerSprites.push(object as THREE.Sprite);
  });
  assert.equal(markerSprites.length, 1, '无论路点多少都只保留当前引导点的一个 Sprite');
  assert.equal(markerSprites[0].material.blending, THREE.AdditiveBlending);
  assert.equal(markerSprites[0].material.depthTest, false);
  assert.equal(markerSprites[0].material.toneMapped, false);
  guide.dispose();
});

test('多个 GuidePath 复用同一张光晕纹理，单路径资源不随路点数量增长', () => {
  const first = new GuidePath({ points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] });
  const second = new GuidePath({ points: [[0, 0, 0], [1, 0, 1]] });
  const firstMarker = first.root.getObjectByName('guide-path-wayfinder-marker') as THREE.Sprite;
  const secondMarker = second.root.getObjectByName('guide-path-wayfinder-marker') as THREE.Sprite;

  assert.equal(firstMarker.material.map, secondMarker.material.map);
  for (const guide of [first, second]) {
    let spriteCount = 0;
    guide.root.traverse((object) => {
      if (object instanceof THREE.Sprite) spriteCount += 1;
    });
    assert.equal(spriteCount, 1);
  }
  first.dispose();
  second.dispose();
});

test('GuidePath 拒绝会让资源随任意路点数量增长的配置', () => {
  const points = Array.from(
    { length: MAX_GUIDE_WAYPOINTS + 1 },
    (_, index) => [index, 0, 0] as const,
  );
  assert.throws(() => new GuidePath({ points }), /2-64/);
  assert.throws(
    () => new GuidePathComponent({ points: [[0, 0, 0], [65, 0, 0]] }),
    /绝对值不超过 64/,
  );
});

test('客户端视觉只应用服务器 GuidePathComponent 的离散状态', () => {
  const state = new GuidePathComponent({
    points: [[0, 0, 0], [2, 0, 0], [4, 0, 0]],
    curve: 'linear',
  });
  // 表现住在渲染世界里；玩法侧只在 revision 变了时推一条命令过去。
  const scene = new ThreeRenderScene(new THREE.Group(), {
    fogColor: '#ffffff', fogNear: 20, fogFar: 60,
  });
  const proxyIds = new RenderProxyTable(scene);
  const proxyId = proxyIds.acquire();
  scene.createMeshProxy(proxyId, {
    name: 'actor-guide',
    guidePath: {
      lineColor: '#fffdf4',
      markerColor: '#fffdf4',
      lineWidth: 5,
      dashLength: 0.8,
      gapLength: 0.55,
      dashSpeed: 0.5,
      markerSize: 0.55,
    },
  });
  const world = new ActorWorld();
  const actor = new Actor('guide-1', 'guide-path');
  actor.addComponent(state);
  actor.addComponent(new RenderProxyComponent(proxyId, scene));
  world.addActor(actor);
  const sync = new ActorGuidePathSyncSystem(scene);
  // 实体等第一条带路点的命令才建，所以先 sync 再取。
  assert.equal(scene.resolveGuidePath(proxyId), undefined);
  sync.update(world, 0, 0);
  const guide = scene.resolveGuidePath(proxyId)!.guide;
  assert.equal(guide.currentMarkerIndex, 0);

  state.advance();
  sync.update(world, 0, 0);
  assert.equal(guide.currentMarkerIndex, 1);

  // 换路径与设索引必须在同一条命令里落地：setPath 内部会 reset()，
  // 拆开发送会让引导线闪回起点。
  state.setPath([[1, 0, 1], [3, 0, 1]], { curve: 'catmull-rom' });
  state.setCurrentPointIndex(2);
  sync.update(world, 0, 0);
  assert.equal(guide.markerCount, 2);
  assert.equal(guide.isComplete, true);

  // revision 没变就不再发命令——这条是 on-change 通道的核心。
  const before = guide.currentMarkerIndex;
  state.setCurrentPointIndex(0);
  assert.equal(guide.currentMarkerIndex, before, 'sync 之前渲染侧不该被改到');
  sync.update(world, 0, 0);
  assert.equal(guide.currentMarkerIndex, 0);

  scene.dispose();
});

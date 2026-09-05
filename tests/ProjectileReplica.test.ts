import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEALTH_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
} from '../shared/actor/index.mjs';
import { PROJECTILE_RADIUS } from '../shared/ballistics/index.mjs';
import * as THREE from 'three';
import type { SnapshotActor } from '../src/network/protocol';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import type { ProxyId } from '../src/render/RenderScene';
import { ThreeProjectileVisual } from '../src/render/three/ThreeProjectileVisual';
import type { SceneDefinition } from '../src/scenes/data/SceneDefinition';
import { createTestActorSystem, renderProxyOf, stepActorFrame } from './renderProxyProbe';

/**
 * 射出去那支箭在客户端这一侧是什么（设计稿 `@w 木弓` 的 `A`）。
 *
 * 它以前是渲染世界池子里的一个对象：判定在松手那一刻早就结算完了，屏幕上那条轨迹
 * 和世界没有关系，所以它穿墙。现在它是一个**复制 Actor**——位置整段由服务端权威
 * 决定，客户端只负责把它画对。这一组锁住画对的两条：
 *
 * 1. 箭不装碰撞体。一支飞在空中的箭不该挡住走路的人，也不该被准星选中挡在它身后
 *    那只史莱姆前面。这条和服务端 `ServerActorFactory` 里的判断是同一条。
 * 2. 箭尖朝着它正在去的方向。俯仰不过网：渲染侧从连续两帧的位移里求切线，
 *    停下之后保持最后一次的角度（插在墙上的那一支该维持扎进去的姿态）。
 */

const ARROW_RENDER = {
  model: 'line-art-arrow',
  length: 0.62,
  shaftColor: '#c8a06a',
  headColor: '#7a6a58',
  inkColor: '#2f2419',
} as const;

const definition = {
  schemaVersion: 1,
  id: 'projectile-probe',
  displayName: 'projectile',
  description: 'projectile replica test',
  capacity: 8,
  sceneComponents: [],
  actors: [],
  actorArchetypes: [{
    schemaVersion: 1,
    id: 'wood-arrow',
    components: {
      projectile: { speed: 34, radius: PROJECTILE_RADIUS, minimumFlightSeconds: 0.12, lingerSeconds: 1.6 },
      render: ARROW_RENDER,
    },
  }],
  renderer: {
    type: 'line-art',
    background: '#ffffff',
    fog: { color: '#ffffff', near: 20, far: 60 },
    content: { ground: false, trees: false, grass: false, ocean: false },
    palette: { ground: '#ffffff', grass: '#ffffff', treeTrunk: '#ffffff', treeNeedles: '#ffffff' },
  },
  gameplay: {
    playerActor: { archetypeId: 'player-slime' },
    worldProps: {},
    bounds: { minimumX: -64, maximumX: 64, minimumZ: -64, maximumZ: 64 },
  },
} as unknown as SceneDefinition;

function arrowAt(x: number, y: number, z: number): SnapshotActor {
  return {
    id: 'projectile-1',
    archetypeId: 'wood-arrow',
    parentActorId: null,
    revision: 1,
    transform: { x, y, z, yaw: 0 },
    localTransform: { x, y, z, yaw: 0 },
  } as unknown as SnapshotActor;
}

function createSystem() {
  return createTestActorSystem({
    definition,
    environment: { fogColor: '#ffffff', fogNear: 20, fogFar: 60 },
    now: () => 1_000,
    spawnBudgetMilliseconds: Number.POSITIVE_INFINITY,
  });
}

test('箭的副本不装碰撞体：飞在空中的箭不该挡住走路的人', () => {
  const system = createSystem();
  system.syncSnapshots([arrowAt(0, 1.2, 0)], 1_000);
  stepActorFrame(system, 0, 0);

  const actor = system.getActor('projectile-1')!;
  assert.equal(actor.getComponent(SIMPLE_COLLISION_COMPONENT), undefined);
  assert.ok(renderProxyOf(system, 'projectile-1'), '但它仍然是画得出来的');
  // 没有生命值：一支箭钉在另一支箭上说不通，它也不该出现在弹药的候选目标里。
  assert.equal(actor.getComponent(HEALTH_COMPONENT), undefined);
  // 也就不在「挡住弹道的实体」这条查询里。
  assert.equal(system.sweepProjectileTargets([0, 1.2, -3], [0, 1.2, 3], PROJECTILE_RADIUS), 1);
});

test('箭尖跟着位移走：上升时仰着、下落时扎着，停下之后保持最后那个角度', () => {
  // 直接喂 transform SoA：俯仰的输入就是「渲染世界这一帧读到的世界坐标」，
  // 快照插值怎么算出那对坐标由 `SnapshotBuffer` 的用例负责。
  const transforms = new RenderTransformBuffer();
  const pitchRoot = new THREE.Group();
  const id = 3 as ProxyId;
  const visual = new ThreeProjectileVisual(id, { pitchRoot });
  const world = { x: 0, y: 0, z: 0, yaw: 0 };
  // 写面和读面是分开的：`publish()` 翻一次面才是渲染世界读得到的那一帧。
  const frame = (x: number, y: number, z: number) => {
    transforms.write(id, x, y, z, 0);
    transforms.publish();
    visual.update(transforms, world);
  };

  // 第一帧没有「上一帧」，所以还没有可信的切线：保持水平。
  frame(0, 1, 0);
  assert.equal(pitchRoot.rotation.x, 0);

  // 往前上方走一段：抬头，角度就是这一帧位移的切线。
  frame(0, 1.5, 1);
  assert.ok(Math.abs(pitchRoot.rotation.x - Math.atan2(0.5, 1)) < 1e-6);

  // 往前下方走一段：低头。
  frame(0, 0.5, 2);
  const falling = pitchRoot.rotation.x;
  assert.ok(falling < 0, `下落段该扎下去，实际 ${falling}`);

  // 插在墙上不动了：保持扎进去的姿态，而不是因为不动就弹回水平。
  frame(0, 0.5, 2);
  assert.equal(pitchRoot.rotation.x, falling);
});

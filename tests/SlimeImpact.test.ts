import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import {
  SlimeImpactTrigger,
  createSlimeImpactParams,
  resolveSlimeImpactParams,
  writeSlimeImpactParams,
} from '../src/render/RenderSlimeImpact';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import type { ProxyId } from '../src/render/RenderScene';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

/**
 * 被弓箭、别的武器弹药打中的那一下。
 *
 * 过边界的只有「哪一次、从哪个方向、多重」，凹成什么样全在渲染侧解——所以这里测的
 * 是三件事：计数怎么翻译成一次事件、软体的坑长得对不对、长腿那颗身体弹不弹。
 */

const ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 };

const PBF_SLIME = {
  model: 'line-art-pbf-slime',
  radius: 0.95,
  collisionRadius: 0.52,
  collisionHeight: 0.72,
  particleCount: 72,
  constraintIterations: 2,
  gravity: 9.8,
  centerForce: 22,
  viscosity: 10,
  bubbleCount: 9,
  bubbleSpeed: 0.1,
  surfaceColor: '#90ebcb',
  innerColor: '#3ca98e',
  coreColor: '#1d7a63',
  bubbleColor: '#eafaff',
  inkColor: '#000000',
  shadowColor: '#1e4a5a',
} as const satisfies Extract<ActorRenderDefinition, { model: 'line-art-pbf-slime' }>;

const LEGGED_SLIME = {
  model: 'line-art-legged-slime',
  radius: 0.44,
  hipHeight: 0.66,
  legSpread: 0.16,
  legCount: 2,
  thighLength: 0.42,
  shinLength: 0.42,
  legThickness: 0.028,
  footLength: 0.13,
  stepLength: 0.28,
  stepHeight: 0.13,
  stepDuration: 0.22,
  membraneColor: '#7fd4e8',
  middleColor: '#b6e9f4',
  coreColor: '#3ea9c6',
  bubbleColor: '#eafaff',
  inkColor: '#000000',
  shadowColor: '#1e4a5a',
  legColor: '#000000',
  footShadowColor: '#6f6f6f',
} as const satisfies Extract<ActorRenderDefinition, { model: 'line-art-legged-slime' }>;

// --- 从计数到一次事件 -------------------------------------------------------

test('计数变了才算挨了一下：第一次看见只记下来，不重放', () => {
  const trigger = new SlimeImpactTrigger();
  const params = createSlimeImpactParams();
  params.revision = 7;
  params.directionZ = 1;
  params.impulse = 1;

  // 中途进房间、或者一具早就挨过打的 Replica 刚进 AOI：不该当着玩家的面重演。
  assert.equal(trigger.consume(params), undefined, '第一次看见只记住计数');
  assert.equal(trigger.consume(params), undefined, '计数没变就不是新的一下');

  params.revision = 8;
  const hit = trigger.consume(params);
  assert.ok(hit, '计数变了就是眼前挨的这一下');
  assert.equal(hit.directionZ, 1);
  assert.equal(hit.impulse, 1);
  assert.equal(trigger.consume(params), undefined, '同一次只放一遍');
});

test('没有方向的事件照样把计数吃下去：治疗不该攒出下一次的误报', () => {
  const trigger = new SlimeImpactTrigger();
  const params = createSlimeImpactParams();
  params.revision = 1;
  trigger.consume(params);

  // 治疗、火、跌落：是一次血量事件，但没有来袭方向。
  params.revision = 2;
  assert.equal(trigger.consume(params), undefined, '零方向不放动画');

  // 吃下去了，所以下一次真的中箭仍然只是「变了一次」。
  params.revision = 3;
  params.directionX = 1;
  params.impulse = 0.5;
  assert.ok(trigger.consume(params), '下一箭照常触发');
});

test('计数归零是槽位被回收，不是一箭；方向归一化、冲量夹到 1', () => {
  const trigger = new SlimeImpactTrigger();
  const params = createSlimeImpactParams();
  params.revision = 5;
  params.directionZ = 1;
  params.impulse = 1;
  trigger.consume(params);

  params.revision = 0;
  params.directionZ = 0;
  params.impulse = 0;
  assert.equal(trigger.consume(params), undefined, '回收来的槽位不该替新主人挨一箭');

  params.revision = 1;
  params.directionX = 3;
  params.directionZ = 4;
  params.impulse = 9;
  const hit = trigger.consume(params)!;
  assert.ok(Math.abs(hit.directionX - 0.6) < 1e-6 && Math.abs(hit.directionZ - 0.8) < 1e-6);
  assert.equal(hit.impulse, 1, '冲量夹在 [0, 1] 里，形变预算不被一个坏数字撑爆');
});

// --- 软体史莱姆：迎面那一侧凹进去 -------------------------------------------

/** 走真实那条路：写参数段 → publish → submitTransforms → updateVisuals。 */
function createHybridHarness(): {
  scene: ThreeRenderScene;
  proxyId: ProxyId;
  impact: ReturnType<typeof createSlimeImpactParams>;
  step(frames: number, from?: number): void;
} {
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const transforms = new RenderTransformBuffer(4);
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, { name: 'shot-player', render: PBF_SLIME, walkSpeed: 3.2 });
  const impact = createSlimeImpactParams();
  return {
    scene,
    proxyId,
    impact,
    step(frames: number, from = 0): void {
      for (let frame = 0; frame < frames; frame += 1) {
        writeSlimeImpactParams(transforms, proxyId, impact);
        transforms.publish();
        scene.submitTransforms(transforms);
        scene.updateVisuals(transforms, 1 / 60, (from + frame) / 60);
      }
    },
  };
}

test('中箭把迎面那一侧的蒙皮朝里砸出一个坑，背面几乎不动', () => {
  const harness = createHybridHarness();
  const slime = harness.scene.resolveSlimeVisual(harness.proxyId)!;
  harness.step(90);
  const rest = Float32Array.from(slime.simulation.positions);

  // 箭朝 +Z 飞进来：迎着它的是外壳 -Z 那一侧，那一侧该朝 +Z 凹进去。
  harness.impact.revision = 1;
  harness.impact.directionZ = 1;
  harness.impact.impulse = 1;
  harness.step(6, 90);

  const dented = slime.simulation.positions;
  const directions = slime.rig.surfaceDirections;
  // 坑心：方向最正对着箭的那个顶点。
  let apexOffset = 0;
  let apexFacing = -Infinity;
  for (let offset = 0; offset < directions.length; offset += 3) {
    if (-directions[offset + 2] <= apexFacing) continue;
    apexFacing = -directions[offset + 2];
    apexOffset = offset;
  }
  const depth = dented[apexOffset + 2] - rest[apexOffset + 2];
  assert.ok(depth > 0.05, `坑心必须朝箭飞来的方向凹进去，实际 ${depth}`);

  // 侧壁连续：位移随「顶点方向与来袭轴的夹角」单调下降，而不是某一圈突然归零。
  // 按一块皮加权位移的那种做法，影响圈边缘那一圈就是画面上的裂缝。
  const rings = new Map<number, { total: number; count: number }>();
  let behindMaximum = 0;
  for (let offset = 0; offset < directions.length; offset += 3) {
    const facing = -directions[offset + 2];
    const moved = Math.hypot(
      dented[offset] - rest[offset],
      dented[offset + 1] - rest[offset + 1],
      dented[offset + 2] - rest[offset + 2],
    );
    if (facing < 0.2) behindMaximum = Math.max(behindMaximum, moved);
    const bucket = Math.round(facing * 10) / 10;
    const ring = rings.get(bucket) ?? { total: 0, count: 0 };
    ring.total += moved;
    ring.count += 1;
    rings.set(bucket, ring);
  }
  const profile = [...rings.entries()]
    .filter(([facing]) => facing >= 0.3)
    .sort((left, right) => right[0] - left[0])
    .map(([facing, ring]) => [facing, ring.total / ring.count] as const);
  assert.ok(profile.length >= 4, '坑里要有好几圈顶点，只有一圈动的是一根针');
  for (let index = 1; index < profile.length; index += 1) {
    assert.ok(
      profile[index][1] <= profile[index - 1][1] + 1e-3,
      `位移必须随夹角单调下降，实际 ${JSON.stringify(profile)}`,
    );
  }
  assert.ok(behindMaximum < depth * 0.35, `背面不该跟着塌，实际 ${behindMaximum}`);
  harness.scene.dispose();
});

test('一次事件只砸一下，砸完自己弹回静止外形', () => {
  const harness = createHybridHarness();
  const slime = harness.scene.resolveSlimeVisual(harness.proxyId)!;
  harness.step(90);
  const rest = Float32Array.from(slime.simulation.positions);

  harness.impact.revision = 3;
  harness.impact.directionZ = 1;
  harness.impact.impulse = 1;
  harness.step(6, 90);
  const directions = slime.rig.surfaceDirections;
  let apexOffset = 0;
  let apexFacing = -Infinity;
  for (let offset = 0; offset < directions.length; offset += 3) {
    if (-directions[offset + 2] <= apexFacing) continue;
    apexFacing = -directions[offset + 2];
    apexOffset = offset;
  }
  const depth = slime.simulation.positions[apexOffset + 2] - rest[apexOffset + 2];

  // 计数不变地再写 120 帧：坑不会越砸越深——它是一次事件，不是一直挂着的状态。
  harness.step(120, 96);
  const settled = Math.abs(slime.simulation.positions[apexOffset + 2] - rest[apexOffset + 2]);
  assert.ok(settled < depth * 0.4, `同一次事件不该被反复施力，实际残留 ${settled} / ${depth}`);
  harness.scene.dispose();
});

test('冲量越大坑越深，冲量为零的事件什么都不做', () => {
  const measure = (impulse: number): number => {
    const harness = createHybridHarness();
    const slime = harness.scene.resolveSlimeVisual(harness.proxyId)!;
    harness.step(90);
    const rest = Float32Array.from(slime.simulation.positions);
    harness.impact.revision = 1;
    harness.impact.directionZ = 1;
    harness.impact.impulse = impulse;
    harness.step(6, 90);
    let deepest = 0;
    for (let offset = 0; offset < rest.length; offset += 3) {
      deepest = Math.max(deepest, slime.simulation.positions[offset + 2] - rest[offset + 2]);
    }
    harness.scene.dispose();
    return deepest;
  };
  const light = measure(0.35);
  const full = measure(1);
  assert.ok(light > 0.01, `最轻的一发也要看得见，实际 ${light}`);
  assert.ok(full > light * 1.8, `拉满该明显更深，实际 ${full} vs ${light}`);
  assert.ok(measure(0) < 1e-6, '冲量为零的事件（治疗）不该动蒙皮');
});

// --- 长腿史莱姆：弹性形变 ---------------------------------------------------

/** 长腿那颗身体不是逐顶点求解的软体，它按公式形变——所以这里量的是那条弹簧。 */
function createLeggedHarness(yaw = 0): {
  scene: ThreeRenderScene;
  proxyId: ProxyId;
  impact: ReturnType<typeof createSlimeImpactParams>;
  step(frames: number, from?: number): void;
} {
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const transforms = new RenderTransformBuffer(4);
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, { name: 'shot-walker', render: LEGGED_SLIME, walkSpeed: 2.4 });
  const impact = createSlimeImpactParams();
  return {
    scene,
    proxyId,
    impact,
    step(frames: number, from = 0): void {
      for (let frame = 0; frame < frames; frame += 1) {
        transforms.write(proxyId, 0, 0, 0, yaw);
        writeSlimeImpactParams(transforms, proxyId, impact);
        transforms.publish();
        scene.submitTransforms(transforms);
        scene.updateVisuals(transforms, 1 / 60, (from + frame) / 60);
      }
    },
  };
}

/** 身体顶点里，局部 z 最小 / 最大那一个相对静止球面的位移（沿 z）。 */
function bodyOffsets(
  geometry: THREE.BufferGeometry,
  original: Float32Array,
): { front: number; back: number } {
  const positions = (geometry.getAttribute('position') as THREE.BufferAttribute)
    .array as Float32Array;
  let front = 0;
  let back = 0;
  let frontZ = Infinity;
  let backZ = -Infinity;
  for (let offset = 0; offset < original.length; offset += 3) {
    const z = original[offset + 2];
    // 只看赤道附近：极点上的顶点没有明确的朝向。
    if (Math.abs(original[offset + 1]) > 0.1) continue;
    if (z < frontZ) {
      frontZ = z;
      front = positions[offset + 2] - z;
    }
    if (z > backZ) {
      backZ = z;
      back = positions[offset + 2] - z;
    }
  }
  return { front, back };
}

test('长腿史莱姆挨一箭是弹性形变：先凹进去，再过冲鼓出来，最后停住', () => {
  const harness = createLeggedHarness();
  const animator = harness.scene.resolveSlimeAnimator(harness.proxyId)!;
  const { geometry, originalPositions } = animator.softBody;
  harness.step(30);
  const quiet = bodyOffsets(geometry, originalPositions);

  // 箭朝 +Z 飞进来：迎着它的是 -Z 那一侧，那一侧该朝 +Z 凹进去。
  harness.impact.revision = 1;
  harness.impact.directionZ = 1;
  harness.impact.impulse = 1;
  harness.step(8, 30);
  const dented = bodyOffsets(geometry, originalPositions);
  assert.ok(
    dented.front - quiet.front > 0.01,
    `迎面那一侧要凹进去（朝 +Z），实际 ${dented.front - quiet.front}`,
  );

  // 弹性形变的判据是**会过冲**：欠阻尼弹簧越过静止位置鼓出来，而不是慢慢趴平。
  // 过阻尼的话下面这一条永远不成立，画面上就是捏了一下橡皮泥。
  let overshoot = 0;
  for (let frame = 0; frame < 40; frame += 1) {
    harness.step(1, 38 + frame);
    overshoot = Math.min(overshoot, bodyOffsets(geometry, originalPositions).front - quiet.front);
  }
  assert.ok(overshoot < -0.002, `凹到底之后要弹过头，实际过冲 ${overshoot}`);

  // 晃两下就停：一箭不该让它一直抖下去。
  harness.step(180, 120);
  const settled = bodyOffsets(geometry, originalPositions);
  assert.ok(
    Math.abs(settled.front - quiet.front) < 0.004,
    `晃完要回到静止外形，实际 ${settled.front - quiet.front}`,
  );
  harness.scene.dispose();
});

test('来袭方向是世界轴向的：身体转过去了，坑还是开在挨箭的那一面', () => {
  // 同一支朝 +Z 的箭，打在一只转了 180° 的史莱姆身上。身体挂在被 yaw 转过的 root
  // 下面，不换算的话坑会开在背上——软体那条路线上这个 180° 的错犯过一次。
  const facing = createLeggedHarness(0);
  const turned = createLeggedHarness(Math.PI);
  for (const harness of [facing, turned]) {
    harness.step(30);
    harness.impact.revision = 1;
    harness.impact.directionZ = 1;
    harness.impact.impulse = 1;
    harness.step(8, 30);
  }
  const facingBody = facing.scene.resolveSlimeAnimator(facing.proxyId)!.softBody;
  const turnedBody = turned.scene.resolveSlimeAnimator(turned.proxyId)!.softBody;
  const front = bodyOffsets(facingBody.geometry, facingBody.originalPositions);
  const back = bodyOffsets(turnedBody.geometry, turnedBody.originalPositions);

  // 局部 -Z 那一侧朝箭：转过身之后，被砸的是局部 +Z 那一侧——世界坐标里仍是同一面。
  assert.ok(front.front > 0.01, `没转身时坑开在局部 -Z，实际 ${front.front}`);
  assert.ok(back.back < -0.01, `转了 180° 之后坑开在局部 +Z，实际 ${back.back}`);
  facing.scene.dispose();
  turned.scene.dispose();
});

// --- 复制面 → 参数段 --------------------------------------------------------

test('没有冲量的事件把计数一起写 0：玩家、远端玩家与 Replica 共用这一条规则', () => {
  const params = createSlimeImpactParams();

  resolveSlimeImpactParams(params, { eventRevision: 4, lastHitZ: 1, lastHitImpulse: 0.8 });
  assert.deepEqual(params, {
    revision: 4, directionX: 0, directionY: 0, directionZ: 1, impulse: 0.8,
  });

  // 治疗：是一次事件，但没有冲量。计数不归零的话，参数段里会留着上一箭的轴，
  // 下一次真的中箭时「和上一帧不一样」就不成立了。
  resolveSlimeImpactParams(params, { eventRevision: 5 });
  assert.deepEqual(params, {
    revision: 0, directionX: 0, directionY: 0, directionZ: 0, impulse: 0,
  });

  // 压根没有生命值的东西（树、箱子）也要每帧写：槽位会被回收。
  resolveSlimeImpactParams(params, undefined);
  assert.equal(params.revision, 0);
  assert.equal(params.impulse, 0);
});

/**
 * 坑最深的那个顶点在球面上的高度（局部 y，按半径归一化）。
 *
 * 这一条才是「斜着扎下来」看得见的地方：平射的坑压在赤道上，吊射的一箭以二十来度
 * 扎下来，坑就该偏在迎箭那一侧的上方。
 */
function deepestDentHeight(geometry: THREE.BufferGeometry, original: Float32Array): number {
  const positions = (geometry.getAttribute('position') as THREE.BufferAttribute)
    .array as Float32Array;
  let deepest = 0;
  let height = 0;
  for (let offset = 0; offset < original.length; offset += 3) {
    const dx = positions[offset] - original[offset];
    const dy = positions[offset + 1] - original[offset + 1];
    const dz = positions[offset + 2] - original[offset + 2];
    // 朝球心方向的位移才算凹：外鼓那一圈不参与。
    const inward = -(
      dx * original[offset] + dy * original[offset + 1] + dz * original[offset + 2]
    );
    if (inward <= deepest) continue;
    deepest = inward;
    height = original[offset + 1] / LEGGED_SLIME.radius;
  }
  return height;
}

test('斜着扎下来的一箭，坑偏在迎箭那一侧的上方，不是齐着赤道压一圈', () => {
  const model = (yDirection: number) => {
    const harness = createLeggedHarness();
    const animator = harness.scene.resolveSlimeAnimator(harness.proxyId)!;
    const geometry = (animator as unknown as { model: { geometry: THREE.BufferGeometry;
      originalPositions: Float32Array } }).model;
    harness.step(2);
    // 从 -Z 那一侧打进来（directionZ 是箭飞的方向，所以指向 +Z）。
    harness.impact.revision = 1;
    harness.impact.directionX = 0;
    harness.impact.directionY = yDirection;
    harness.impact.directionZ = Math.sqrt(Math.max(0, 1 - yDirection * yDirection));
    harness.impact.impulse = 1;
    harness.step(6, 2);
    return deepestDentHeight(geometry.geometry, geometry.originalPositions);
  };

  // 平射：坑压在赤道上。
  const flat = model(0);
  assert.ok(Math.abs(flat) < 0.25, `平射该压在赤道附近，实际 ${flat.toFixed(3)}`);

  // 拉满那一箭以二十来度扎下来（lastHitY ≈ -0.38）：坑抬到迎箭那一侧的上半边。
  const plunging = model(-0.38);
  assert.ok(
    plunging > flat + 0.15,
    `扎下来的一箭坑该更高，实际 ${plunging.toFixed(3)} vs 平射 ${flat.toFixed(3)}`,
  );
});

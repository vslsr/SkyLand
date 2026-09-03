import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Actor } from '../shared/actor/Actor.mjs';
import { ActorWorld } from '../shared/actor/ActorWorld.mjs';
import { TransformComponent } from '../shared/actor/components/TransformComponent.mjs';
import { LegGroundProbeComponent } from '../src/actors/components/LegGroundProbeComponent';
import { RenderProxyComponent } from '../src/actors/components/RenderProxyComponent';
import { ActorVisualParamSystem } from '../src/actors/systems/ActorVisualParamSystem';
import { RenderProxyTable } from '../src/render/RenderProxyTable';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import {
  SLIME_GROUND_PROBE_AT_REST,
  readSlimeGroundProbeParams,
  resolveSlimeLegGroundProbeLayout,
  sampleSlimeGroundProbe,
  writeSlimeGroundProbeParams,
  type SlimeGroundProbeParams,
} from '../src/render/RenderSlimeLegs';
import {
  SLIME_MOTION_AT_REST,
  writeSlimeMotionParams,
  type SlimeMotionParams,
} from '../src/render/RenderSlimeMotion';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene';
import type { ProxyId } from '../src/render/RenderScene';
import type { ActorRenderDefinition } from '../src/scenes/data/SceneDefinition';

const ENVIRONMENT = { fogColor: '#ffffff', fogNear: 20, fogFar: 60 };

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
  inkColor: '#152c36',
  shadowColor: '#1e4a5a',
  legColor: '#141210',
  footShadowColor: '#6f6f6f',
} as const satisfies Extract<ActorRenderDefinition, { model: 'line-art-legged-slime' }>;

function probeOf(overrides: Partial<SlimeGroundProbeParams>): SlimeGroundProbeParams {
  return { ...SLIME_GROUND_PROBE_AT_REST, ...overrides };
}

// --- 采样窗口 ---------------------------------------------------------------

test('五点窗口在中心与探针上还原采样值，中间按斜面插值', () => {
  const probe = probeOf({
    centerY: 1,
    eastY: 2,
    westY: 0.5,
    southY: 1.5,
    northY: 1,
    radius: 0.5,
  });

  assert.equal(sampleSlimeGroundProbe(probe, 0, 0), 1);
  assert.ok(Math.abs(sampleSlimeGroundProbe(probe, 0.5, 0) - 2) < 1e-6);
  assert.ok(Math.abs(sampleSlimeGroundProbe(probe, -0.5, 0) - 0.5) < 1e-6);
  assert.ok(Math.abs(sampleSlimeGroundProbe(probe, 0, 0.5) - 1.5) < 1e-6);
  // 半程取一半的高差，两个轴各自叠加。
  assert.ok(Math.abs(sampleSlimeGroundProbe(probe, 0.25, 0.25) - (1 + 0.5 + 0.25)) < 1e-6);
});

test('窗口之外夹回边界，不外推出一个凭空的高度', () => {
  const probe = probeOf({ centerY: 0, eastY: 4, radius: 0.5 });
  // 一路走到 100 米外也只拿到探针那一格的高度。
  assert.equal(sampleSlimeGroundProbe(probe, 100, 0), 4);
  assert.equal(sampleSlimeGroundProbe(probe, 0.5, 0), 4);
});

test('radius 为 0 表示这一槽位没有地面采样', () => {
  // 参数段的规则是「不驱动这项表现的槽位每帧写 0」。radius 若不是那个哨兵，
  // 五个 0 就会被当成「地面在世界 Y=0」。
  assert.equal(SLIME_GROUND_PROBE_AT_REST.radius, 0);
  const probe = probeOf({ centerY: 7, radius: 0 });
  assert.equal(sampleSlimeGroundProbe(probe, 3, -2), 7);
});

test('采样窗口的尺寸由腿的尺寸推出来，不需要作者再填一遍', () => {
  const layout = resolveSlimeLegGroundProbeLayout(LEGGED_SLIME);
  // 一只脚能离开身体中心的最远水平距离：站姿髋距 + 一步。
  assert.ok(Math.abs(layout.radius - (LEGGED_SLIME.legSpread + LEGGED_SLIME.stepLength)) < 1e-9);
  // 站姿下这条腿还剩的竖直余量。
  const total = LEGGED_SLIME.thighLength + LEGGED_SLIME.shinLength;
  const standing = Math.sqrt(total * total - LEGGED_SLIME.legSpread * LEGGED_SLIME.legSpread);
  assert.ok(Math.abs(layout.maximumReach - (standing - LEGGED_SLIME.hipHeight)) < 1e-9);
  assert.ok(layout.maximumReach > 0);
});

// --- 玩法侧的采样 -----------------------------------------------------------

test('地面探针每帧只采五个点，并把高差夹在腿够得着的范围里', () => {
  const sampled: [number, number][] = [];
  const probe = new LegGroundProbeComponent(
    (x, z) => {
      sampled.push([x, z]);
      // 一道朝 +X 变高的陡坡，落差远超腿的可达范围。
      return 3 + x * 10;
    },
    { radius: 0.5, maximumReach: 0.2 },
  );

  probe.refresh(0, 3, 0);
  assert.equal(sampled.length, 5, '一帧五次采样，与腿数和世界尺寸都无关');
  assert.deepEqual(sampled, [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]);
  assert.equal(probe.probe.radius, 0.5);
  assert.equal(probe.probe.centerY, 3);
  assert.equal(probe.probe.eastY, 3.2, '上坡夹在 +maximumReach');
  assert.equal(probe.probe.westY, 2.8, '下坡夹在 -maximumReach');
});

test('没有地形服务时窗口退化成 Actor 自己脚下的平面', () => {
  const probe = new LegGroundProbeComponent(undefined, { radius: 0.5, maximumReach: 0.2 });
  probe.refresh(12, 4.5, -7);
  assert.equal(probe.probe.radius, 0.5);
  for (const height of [
    probe.probe.centerY,
    probe.probe.eastY,
    probe.probe.westY,
    probe.probe.southY,
    probe.probe.northY,
  ]) {
    assert.equal(height, 4.5);
  }
});

test('没有腿的槽位每帧被写成静止值，回收后不会继承上一位的采样窗口', () => {
  const transforms = new RenderTransformBuffer(8);
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const world = new ActorWorld();
  world.addSystem(new ActorVisualParamSystem(transforms));

  const legged = new Actor('legged', 'legged-slime');
  legged.addComponent(new TransformComponent({ position: [2, 1, -3], yaw: 0 }));
  // 槽位由玩法侧分配：渲染世界不回话（见 RenderScene.createMeshProxy）。
  const proxyIds = new RenderProxyTable(scene);
  const proxyId = proxyIds.acquire();
  scene.createMeshProxy(proxyId, { name: 'legged', render: LEGGED_SLIME });
  legged.addComponent(new RenderProxyComponent(proxyId, proxyIds));
  legged.addComponent(new LegGroundProbeComponent(
    () => 1,
    resolveSlimeLegGroundProbeLayout(LEGGED_SLIME),
  ));
  world.addActor(legged);
  world.update(1 / 60, 0);
  transforms.publish();

  const readback = { ...SLIME_GROUND_PROBE_AT_REST };
  readSlimeGroundProbeParams(transforms, proxyId, readback);
  assert.ok(readback.radius > 0);
  assert.equal(readback.centerY, 1);

  // 换成一个没有腿的 Actor 占同一个槽位。
  world.removeActor(legged.id);
  const plain = new Actor('plain', 'training-dummy');
  plain.addComponent(new TransformComponent({ position: [2, 1, -3], yaw: 0 }));
  const recycled = proxyIds.acquire();
  assert.equal(recycled, proxyId, '槽位应当被回收复用，否则这条不变量测不到');
  scene.createMeshProxy(recycled, { name: 'plain' });
  plain.addComponent(new RenderProxyComponent(recycled, proxyIds));
  world.addActor(plain);
  world.update(1 / 60, 0);
  transforms.publish();

  readSlimeGroundProbeParams(transforms, recycled, readback);
  assert.deepEqual(readback, { ...SLIME_GROUND_PROBE_AT_REST });
});

// --- 渲染侧的步态 -----------------------------------------------------------

interface LegHarness {
  scene: ThreeRenderScene;
  transforms: RenderTransformBuffer;
  id: ProxyId;
  step(seconds: number, state: {
    x: number;
    z: number;
    yaw?: number;
    motion?: Partial<SlimeMotionParams>;
    groundY?: number;
    slopeAlongX?: number;
  }): void;
  elapsed: number;
}

/** 走真实那条路：写参数段 → publish → submitTransforms → updateVisuals。 */
function createLegHarness(): LegHarness {
  const transforms = new RenderTransformBuffer(8);
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, {
    name: 'legged-player',
    render: LEGGED_SLIME,
    walkSpeed: 3.2,
  });
  const layout = resolveSlimeLegGroundProbeLayout(LEGGED_SLIME);
  const harness: LegHarness = {
    scene,
    transforms,
    id: proxyId,
    elapsed: 0,
    step(seconds, state) {
      const groundY = state.groundY ?? 0;
      const slope = state.slopeAlongX ?? 0;
      transforms.write(proxyId, state.x, groundY, state.z, state.yaw ?? 0);
      writeSlimeMotionParams(transforms, proxyId, { ...SLIME_MOTION_AT_REST, ...state.motion });
      writeSlimeGroundProbeParams(transforms, proxyId, {
        centerY: groundY,
        eastY: groundY + slope * layout.radius,
        westY: groundY - slope * layout.radius,
        southY: groundY,
        northY: groundY,
        radius: layout.radius,
      });
      transforms.publish();
      scene.submitTransforms(transforms);
      harness.elapsed += seconds;
      scene.updateVisuals(transforms, seconds, harness.elapsed);
    },
  };
  return harness;
}

function feetOf(harness: LegHarness): THREE.Vector3[] {
  const proxy = harness.scene.resolve(harness.id)!;
  proxy.root.updateWorldMatrix(true, true);
  const feet: THREE.Vector3[] = [];
  proxy.root.traverse((object) => {
    if (object.name.startsWith('legged-slime-foot-shadow')) return;
    if (!object.name.startsWith('legged-slime-foot-')) return;
    feet.push(object.getWorldPosition(new THREE.Vector3()));
  });
  return feet;
}

function shadowsOf(harness: LegHarness): THREE.Vector3[] {
  const proxy = harness.scene.resolve(harness.id)!;
  proxy.root.updateWorldMatrix(true, true);
  const shadows: THREE.Vector3[] = [];
  proxy.root.traverse((object) => {
    if (!object.name.startsWith('legged-slime-foot-shadow')) return;
    shadows.push(object.getWorldPosition(new THREE.Vector3()));
  });
  return shadows;
}

function bonesOf(harness: LegHarness): { name: string; length: number }[] {
  const proxy = harness.scene.resolve(harness.id)!;
  const bones: { name: string; length: number }[] = [];
  proxy.root.traverse((object) => {
    if (!/^legged-slime-(thigh|shin)-/.test(object.name)) return;
    // 骨头几何沿 +Y 长 1，摆的时候只缩放 Y，所以 scale.y 就是骨长。
    bones.push({ name: object.name, length: object.scale.y });
  });
  return bones;
}

test('站立时两只脚踩在采样出来的地面上，膝盖是两节骨头之间的一个折角', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  const feet = feetOf(harness);
  assert.equal(feet.length, LEGGED_SLIME.legCount);
  for (const foot of feet) {
    assert.ok(Math.abs(foot.y) < 1e-3, `脚应踩在 y=0 的地面上，实际 ${foot.y}`);
  }

  for (const bone of bonesOf(harness)) {
    const expected = bone.name.includes('thigh')
      ? LEGGED_SLIME.thighLength
      : LEGGED_SLIME.shinLength;
    assert.ok(
      Math.abs(bone.length - expected) < 1e-4,
      `${bone.name} 应保持定长 ${expected}，实际 ${bone.length}`,
    );
  }

  // 「腿部具有关节」的可验证形式：膝盖离开髋点与落脚点的连线。
  //
  // 膝盖没有自己的节点——小腿这根骨头的起点就是它。这正是这次改动的要点：
  // 关节由两节骨头的夹角画出来，不再额外套一个环。
  const proxy = harness.scene.resolve(harness.id)!;
  proxy.root.updateWorldMatrix(true, true);
  assert.equal(
    proxy.root.getObjectByName('legged-slime-knee-0'),
    undefined,
    '膝盖不该再有单独的环',
  );
  const knee = proxy.root.getObjectByName('legged-slime-shin-0')!
    .getWorldPosition(new THREE.Vector3());
  const hip = new THREE.Vector3(
    LEGGED_SLIME.legSpread,
    LEGGED_SLIME.hipHeight,
    0,
  );
  const foot = feet.find((candidate) => candidate.x > 0)!;
  const axis = new THREE.Vector3().subVectors(foot, hip).normalize();
  const toKnee = new THREE.Vector3().subVectors(knee, hip);
  const bend = toKnee.clone().addScaledVector(axis, -toKnee.dot(axis)).length();
  assert.ok(bend > 0.05, `膝盖应明显偏离直线，实际偏移 ${bend}`);
});

test('身体走过去时踩住的脚留在原地，直到迈出一步才换落点', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  const before = feetOf(harness).map((foot) => foot.clone());
  // 只走一小段：不足以触发迈步，脚必须钉在地上而不是跟着身体滑。
  harness.step(1 / 60, {
    x: 0,
    z: 0.02,
    motion: { movementSpeed: 1.2, movementVelocityZ: 1.2 },
  });
  const after = feetOf(harness);
  for (const [index, foot] of after.entries()) {
    assert.ok(
      foot.distanceTo(before[index]) < 1e-4,
      `踩住的脚不该跟着身体走，位移 ${foot.distanceTo(before[index])}`,
    );
  }
});

test('走起来会抬腿落下，抬起的那只脚的灰色阴影留在接触点上', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  let z = 0;
  let maximumLift = 0;
  let sawShadowOnGround = true;
  let liftedShadowSeen = false;
  for (let frame = 0; frame < 120; frame += 1) {
    z += 2.4 / 60;
    harness.step(1 / 60, {
      x: 0,
      z,
      motion: { movementSpeed: 2.4, movementVelocityZ: 2.4, airborne: 0 },
    });
    const feet = feetOf(harness);
    const shadows = shadowsOf(harness);
    for (const [index, foot] of feet.entries()) {
      maximumLift = Math.max(maximumLift, foot.y);
      if (foot.y > 0.02) liftedShadowSeen = true;
      // 影子是画出来的接触提示：脚抬起来时它必须留在地面上。
      if (Math.abs(shadows[index].y - 0.014) > 1e-3) sawShadowOnGround = false;
    }
  }

  assert.ok(maximumLift > 0.03, `迈步时脚应离地，实际最高 ${maximumLift}`);
  assert.ok(maximumLift <= LEGGED_SLIME.stepHeight + 1e-3, '抬腿不应超过配置的弧高');
  assert.ok(liftedShadowSeen, '这段行走里应当出现过抬起的脚');
  assert.ok(sawShadowOnGround, '灰色阴影必须贴在地面上，不能跟着抬起的脚飞');
});

test('起步之后两条腿轮流迈，稳定行走时始终有一只脚踩在地上', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  let z = 0;
  const stepped = [0, 0];
  let previous = feetOf(harness).map((foot) => foot.clone());
  for (let frame = 0; frame < 180; frame += 1) {
    z += 2.4 / 60;
    harness.step(1 / 60, {
      x: 0,
      z,
      motion: { movementSpeed: 2.4, movementVelocityZ: 2.4 },
    });
    const feet = feetOf(harness);
    for (const [index, foot] of feet.entries()) {
      if (foot.y > 1e-3 && previous[index].y <= 1e-3) stepped[index] += 1;
    }
    previous = feet.map((foot) => foot.clone());

    // 前半个步幅是起步过渡：站住的那条腿会先被拉到腿长极限，这时宁可两只脚
    // 同时离地一瞬，也不要让 IK 把够不到的脚拖着走（见 startSteps 的说明）。
    if (frame < 30) continue;
    const planted = feet.filter((foot) => foot.y <= 1e-3).length;
    assert.ok(planted >= 1, `稳定行走时不该两只脚同时离地（第 ${frame} 帧）`);
  }

  assert.ok(stepped[0] > 3 && stepped[1] > 3, `两条腿都要迈：${stepped.join(' / ')}`);
  assert.ok(
    Math.abs(stepped[0] - stepped[1]) <= 1,
    `两条腿迈的次数应当接近：${stepped.join(' / ')}`,
  );
});

test('落脚高度跟着地面采样走，坡上的两只脚不在同一高度', () => {
  const harness = createLegHarness();
  // 侧向坡：+X 高、-X 低。两条腿的髋点在 ±X，落脚点必须分开。
  for (let frame = 0; frame < 60; frame += 1) {
    harness.step(1 / 60, { x: 0, z: 0, slopeAlongX: 0.5 });
  }
  const feet = feetOf(harness).sort((a, b) => a.x - b.x);
  assert.equal(feet.length, 2);
  assert.ok(feet[1].y > feet[0].y + 0.05, `上坡侧的脚应更高：${feet[0].y} / ${feet[1].y}`);
  // 采样窗口是过中心的斜面，落脚点高度应当就是窗口在该点的值。
  for (const foot of feet) {
    assert.ok(Math.abs(foot.y - foot.x * 0.5) < 0.02, `脚应踩在采样出来的坡面上：${foot.y}`);
  }
});

test('离地时脚收到髋点正下方，落地后重新踩住地面', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  // 跳起来：Actor 抬到 2 米高，脚下的地面还在原处。
  for (let frame = 0; frame < 40; frame += 1) {
    harness.step(1 / 60, { x: 0, z: 0, groundY: 2, motion: { airborne: 1 } });
  }
  const total = LEGGED_SLIME.thighLength + LEGGED_SLIME.shinLength;
  for (const foot of feetOf(harness)) {
    assert.ok(foot.y > 1.5, `悬空时脚应跟着身体升空，而不是留在地面上：${foot.y}`);
    assert.ok(
      foot.y < 2 + LEGGED_SLIME.hipHeight - total * 0.6,
      `悬空时腿应收起来而不是伸直：${foot.y}`,
    );
    assert.ok(Math.abs(Math.abs(foot.x) - LEGGED_SLIME.legSpread) < 0.05, '脚应收到髋点正下方');
  }

  for (let frame = 0; frame < 60; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });
  for (const foot of feetOf(harness)) {
    assert.ok(Math.abs(foot.y) < 1e-3, `落地后脚应重新踩住地面：${foot.y}`);
  }
});

test('没有地面采样的槽位退回 Actor 自己的脚底平面，而不是世界 Y=0', () => {
  const transforms = new RenderTransformBuffer(8);
  const scene = new ThreeRenderScene(new THREE.Group(), ENVIRONMENT);
  const proxyId = new RenderProxyTable(scene).acquire();
  scene.createPlayerProxy(proxyId, {
    name: 'legged-player',
    render: LEGGED_SLIME,
    walkSpeed: 3.2,
  });
  let elapsed = 0;
  for (let frame = 0; frame < 30; frame += 1) {
    transforms.write(proxyId, 0, 12, 0, 0);
    writeSlimeMotionParams(transforms, proxyId, SLIME_MOTION_AT_REST);
    writeSlimeGroundProbeParams(transforms, proxyId, SLIME_GROUND_PROBE_AT_REST);
    transforms.publish();
    scene.submitTransforms(transforms);
    elapsed += 1 / 60;
    scene.updateVisuals(transforms, 1 / 60, elapsed);
  }

  const proxy = scene.resolve(proxyId)!;
  proxy.root.updateWorldMatrix(true, true);
  const foot = proxy.root.getObjectByName('legged-slime-foot-0')!
    .getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(foot.y - 12) < 1e-3, `脚应停在 Actor 自己的脚底平面上：${foot.y}`);
});

test('服务端推着走的 Replica 没有速度参数，步态从 transform 差分出来', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  // 站着不动：不该无缘无故迈步。
  let lifted = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    harness.step(1 / 60, { x: 0, z: 0 });
    if (feetOf(harness).some((foot) => foot.y > 1e-3)) lifted += 1;
  }
  assert.equal(lifted, 0, '原地不动时不该迈步');

  // 巡逻 Actor 走的就是这条路：位置每帧在变，运动参数全是静止值
  // （见 ActorVisualParamSystem——Replica 不复制运动演示）。
  let z = 0;
  let maximumLift = 0;
  const stepped = [0, 0];
  let previous = feetOf(harness).map((foot) => foot.clone());
  for (let frame = 0; frame < 180; frame += 1) {
    z += 1.6 / 60;
    harness.step(1 / 60, { x: 0, z });
    const feet = feetOf(harness);
    for (const [index, foot] of feet.entries()) {
      maximumLift = Math.max(maximumLift, foot.y);
      if (foot.y > 1e-3 && previous[index].y <= 1e-3) stepped[index] += 1;
    }
    previous = feet.map((foot) => foot.clone());
  }

  assert.ok(maximumLift > 0.03, `被服务端推着走时也要抬腿，实际最高 ${maximumLift}`);
  assert.ok(stepped[0] > 2 && stepped[1] > 2, `两条腿都要迈：${stepped.join(' / ')}`);

  // 脚最终仍然踩在采样出来的地面上，没有被拖在身后。
  const bodyZ = z;
  for (const foot of feetOf(harness)) {
    assert.ok(
      Math.abs(foot.z - bodyZ) < LEGGED_SLIME.stepLength + LEGGED_SLIME.legSpread + 0.35,
      `落脚点不该被落在身后：脚 ${foot.z}，身体 ${bodyZ}`,
    );
  }
});

test('脚是从踝点朝正前方折出去的一小段，不跟着小腿方向走', () => {
  const harness = createLegHarness();
  for (let frame = 0; frame < 30; frame += 1) harness.step(1 / 60, { x: 0, z: 0 });

  const proxy = harness.scene.resolve(harness.id)!;
  proxy.root.updateWorldMatrix(true, true);
  const foot = proxy.root.getObjectByName('legged-slime-foot-0')!;
  const ankle = foot.getWorldPosition(new THREE.Vector3());
  const shin = proxy.root.getObjectByName('legged-slime-shin-0')!;

  // 骨头几何沿 +Y 长 1，摆的时候只缩放 Y，所以 scale.y 就是这一段的长度。
  assert.ok(
    Math.abs(foot.scale.y - LEGGED_SLIME.footLength) < 1e-6,
    `脚的长度应当是配置的 footLength，实际 ${foot.scale.y}`,
  );

  // 踝点就是小腿的终点：脚接在腿的末端，不是飘在旁边。
  const shinEnd = shin.localToWorld(new THREE.Vector3(0, 1, 0));
  assert.ok(shinEnd.distanceTo(ankle) < 1e-5, '脚必须接在小腿的末端');

  // 折角朝前偏外，而不是顺着小腿的方向继续往下。
  const toe = foot.localToWorld(new THREE.Vector3(0, 1, 0));
  const forward = new THREE.Vector3().subVectors(toe, ankle);
  assert.ok(forward.z > LEGGED_SLIME.footLength * 0.5, `脚尖应当朝前，实际 ${forward.z}`);
  // 只朝正前方的话，俯视相机顺着 +Z 看下来会把折角压成一个点。0 号腿的髋点在
  // +X 一侧，脚尖也该往 +X 撇。
  assert.ok(forward.x > 0, `0 号腿的脚尖应当往 +X 外撇，实际 ${forward.x}`);

  // 站着不动时脚是平的；这条和上面的 z 一起把「折角」钉死。
  assert.ok(Math.abs(forward.y) < 1e-6, `站立时脚尖应当收平，实际 ${forward.y}`);
});

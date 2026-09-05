import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { InventoryComponent } from '../shared/actor/index.mjs';
import { itemCatalog, resolveWeaponStrike, weaponImpactPoint } from '../shared/items/index.mjs';
import { HotbarController } from '../src/controllers/HotbarController.ts';
import { WeaponAimController } from '../src/controllers/WeaponAimController.ts';
import type { HeldItemProgress } from '../src/controllers/HotbarController.ts';
import type { InventoryCommand } from '../src/network/messages.ts';
import type { BallisticPreviewState } from '../src/render/RenderScene.ts';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer.ts';
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene.ts';
import { ItemUseInputTags } from '../src/input/config/playerInput.ts';
import {
  ballisticArcApex,
  ballisticArcPoint,
  ballisticArcTravel,
} from '../src/render/ballisticArc.ts';
import { ThreeBallisticPreviewVisual } from '../src/render/three/ThreeBallisticPreviewVisual.ts';
import { createWoodBowModel } from '../src/models/actors/createWoodBowModel.ts';
import { ThreeWoodBowVisual } from '../src/render/three/ThreeWoodBowVisual.ts';
import {
  BOW_LIMB_BEND_RADIANS,
  BOW_RELEASE_SECONDS,
  BOW_STRING_PULL,
  bowReleaseLimbBend,
  bowReleaseStringPull,
} from '../src/render/RenderBowDraw.ts';
import {
  PARAM_BOW_CHARGE,
  PARAM_BOW_RELEASE_REVISION,
} from '../src/render/RenderVisualParams.ts';

/** 只够 `ThreeWoodBowVisual` 读两个参数的替身。 */
class StubTransforms {
  private readonly params = new Map<number, number>();
  public set(param: number, value: number): void { this.params.set(param, value); }
  public readParam(_id: number, param: number): number { return this.params.get(param) ?? 0; }
}
import {
  createWoodBowLimbGeometry,
  woodBowStringOffset,
} from '../src/models/actors/createWoodBowModel';

const BOW = itemCatalog.require('wood-bow').weapon!;

interface AimHarness {
  controller: WeaponAimController;
  facing: Array<{ x: number; z: number } | undefined>;
  previews: Array<BallisticPreviewState | undefined>;
  /** 这一帧的弧被挡在哪儿；测试按需改它来假装前面有堵墙。 */
  blockAt: { travel: number };
  setHeld(itemType: string | undefined): void;
  setPointer(ray: { origin: [number, number, number]; direction: [number, number, number] } | undefined): void;
  /** 假装玩家把瞄准摇杆推到了这个方向（屏幕空间，y 向上为正）。 */
  pushAim(x: number, y: number): void;
  player: { x: number; y: number; z: number; yaw: number };
}

function aimHarness(): AimHarness {
  /** 只够 `WeaponAimController` 订阅一条输入的替身。 */
  const listeners: Array<(event: { phase: string; value: unknown }) => void> = [];
  const input = {
    bind: (_tag: unknown, handler: (event: { phase: string; value: unknown }) => void) => {
      listeners.push(handler);
      return () => {};
    },
  } as never;
  const pushAim = (x: number, y: number): void => {
    for (const listener of listeners) listener({ phase: 'triggered', value: { x, y } });
  };
  const facing: AimHarness['facing'] = [];
  const previews: AimHarness['previews'] = [];
  const blockAt = { travel: 1 };
  const player = { x: 0, y: 1, z: 0, yaw: 0 };
  let held: string | undefined = 'wood-bow';
  let ray: Parameters<AimHarness['setPointer']>[0] = {
    origin: [0, 9, -8],
    direction: [0, -1, 1],
  };
  const controller = new WeaponAimController({
    isActive: () => true,
    getHeldWeapon: () => {
      const weapon = held ? itemCatalog.get(held)?.weapon : undefined;
      return weapon ? { weapon } : undefined;
    },
    getPlayer: () => player,
    pointerRay: () => (ray ? { origin: ray.origin, direction: ray.direction } : undefined),
    sampleGroundHeight: () => 0,
    setFacingTarget: (target) => facing.push(target),
    setPreview: (state) => previews.push(state),
    sweepProjectile: () => blockAt.travel,
    cameraAxes: () => ({ forwardX: 0, forwardZ: 1, rightX: 1, rightZ: 0 }),
  }, input);
  return {
    controller,
    facing,
    previews,
    blockAt,
    player,
    pushAim,
    setHeld: (itemType) => { held = itemType; },
    setPointer: (next) => { ray = next; },
  };
}

test('手上不是武器就不瞄准，也不画线', () => {
  const harness = aimHarness();
  harness.setHeld('fruit');
  harness.controller.setChargeRatio(0.8);
  harness.controller.update();
  assert.deepEqual(harness.facing.at(-1), undefined);
  assert.deepEqual(harness.previews.at(-1), undefined);
});

test('手持武器时朝向对准指针在角色所在水平面上的投影点', () => {
  const harness = aimHarness();
  // 从 (0, 9, -8) 朝 (0, -1, 1) 打下来：落到 y=1 的平面上要走 8 个单位。
  harness.controller.update();
  const target = harness.facing.at(-1)!;
  assert.ok(Math.abs(target.x - 0) < 1e-9);
  assert.ok(Math.abs(target.z - 0) < 1e-9);

  // 平面是**角色脚下那一层**而不是 y=0：站在高处时按 0 平面算会偏出去一大截。
  harness.player.y = 5;
  harness.controller.update();
  const raised = harness.facing.at(-1)!;
  assert.ok(Math.abs(raised.z + 4) < 1e-9, `应当落在 z=-4，实际 ${raised.z}`);
});

test('没有指针（触屏、手柄）时把朝向交回移动方向', () => {
  const harness = aimHarness();
  harness.setPointer(undefined);
  harness.controller.update();
  assert.equal(harness.facing.at(-1), undefined);
});

test('蓄力没过空放阈值不画线，过了之后落点与服务端读同一份换算', () => {
  const harness = aimHarness();
  harness.controller.setChargeRatio(BOW.charge.minimumRatio * 0.5);
  harness.controller.update();
  assert.equal(harness.previews.at(-1), undefined, '这一箭现在松手也射不出去');

  harness.player.yaw = Math.PI / 2;
  harness.controller.setChargeRatio(1);
  harness.controller.update();
  const preview = harness.previews.at(-1)!;
  const strike = resolveWeaponStrike(BOW, 1)!;
  const impact = weaponImpactPoint(harness.player.x, harness.player.z, Math.PI / 2, strike.distance);
  assert.ok(Math.abs(preview.impactX - impact.x) < 1e-9, '落点按朝向反解，和服务端同一条公式');
  assert.ok(Math.abs(preview.impactZ - impact.z) < 1e-9);
  assert.equal(preview.impactY, 0, '线的末端落在地面上');
  assert.ok(preview.originY > harness.player.y, '线从身前偏上出去，不贴着地面爬');
});

test('松手之后收起线；换成别的东西也收起', () => {
  const harness = aimHarness();
  harness.controller.setChargeRatio(1);
  harness.controller.update();
  assert.ok(harness.previews.at(-1));

  harness.controller.setChargeRatio(undefined);
  harness.controller.update();
  assert.equal(harness.previews.at(-1), undefined);

  harness.controller.setChargeRatio(1);
  harness.controller.reset();
  assert.equal(harness.previews.at(-1), undefined);
  assert.equal(harness.facing.at(-1), undefined);
});

// --- 蓄力圈：圈满不是结算 -----------------------------------------------------

function hotbarHarness() {
  const handlers = new Map<unknown, (event: { phase: string }) => void>();
  const input = {
    enabled: true,
    bind: (tag: unknown, handler: (event: { phase: string }) => void) => {
      handlers.set(tag, handler);
      return () => handlers.delete(tag);
    },
  } as never;
  const sent: InventoryCommand[] = [];
  const progress: (HeldItemProgress | undefined)[] = [];
  let clock = 0;
  const inventory = new InventoryComponent({ slotCapacity: 8, hotbarCapacity: 9 });
  inventory.add('wood-bow', 1);
  inventory.assignHotbarSlot(0, 'wood-bow');
  inventory.setActiveHotbarSlot(0);
  const controller = new HotbarController(input, {
    getInventory: () => inventory,
    getHeldActorId: () => 'held-bow',
    isActive: () => true,
    getInputLabel: () => 'E',
    send: (command) => sent.push(command),
    setProgress: (next) => progress.push(next),
  }, () => clock);
  return {
    controller,
    sent,
    progress,
    use: (phase: string) => handlers.get(ItemUseInputTags.primary)?.({ phase }),
    advance: (ms: number) => { clock += ms; },
  };
}

test('蓄力的圈满了也不结算：线和圈都留着，松手才打出去', () => {
  const bar = hotbarHarness();
  bar.use('started');
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }]);

  bar.advance(600);
  bar.controller.update();
  const half = bar.progress.at(-1)!;
  assert.equal(half.action, 'shoot');
  assert.ok(half.ratio > 0.4 && half.ratio < 0.6, `半程比例应当在中间，实际 ${half.ratio}`);

  // 拉满：长按物品到这里就结算了，蓄力不是——圈停在满格等松手。
  bar.advance(1_000);
  bar.controller.update();
  assert.equal(bar.progress.at(-1)?.ratio, 1);
  assert.deepEqual(bar.sent, [{ kind: 'use:begin' }], '圈满不发任何东西');

  bar.use('completed');
  assert.deepEqual(
    bar.sent,
    [{ kind: 'use:begin' }, { kind: 'use:release' }],
    '松手那一下才是开火',
  );
  assert.equal(bar.progress.at(-1), undefined, '松手之后圈收起来');
});

/**
 * 把「线画多长」那一下追到底。
 *
 * 线不是一帧就画满的：起手那一跳被摊成了一小段生长（见
 * `ThreeBallisticPreviewVisual`）。这些用例问的是**画成什么形状**，
 * 所以先让它长完。
 */
function settlePreview(scene: ThreeRenderScene): void {
  scene.updateVisuals(new RenderTransformBuffer(), 1, 1);
}

// --- 渲染侧：那条白色抛物线 -------------------------------------------------

test('抛物线画在两个端点之间，中间抬起来；收起时整条线不可见', () => {
  const scene = new ThreeRenderScene(new THREE.Group(), {
    fogColor: '#ffffff',
    fogNear: 20,
    fogFar: 60,
  });
  assert.equal(scene.root.children.length, 0, '没人拉弓时不该先建一条线出来');

  scene.setBallisticPreview({
    originX: 0,
    originY: 0.6,
    originZ: 0,
    impactX: 0,
    impactY: 0,
    impactZ: 12,
    ratio: 0.5,
  });
  settlePreview(scene);
  const preview = scene.root.children.find((child) => child.name === 'ballistic-preview')!;
  assert.ok(preview, '第一条命令到了才建，建了就挂在渲染世界根下');
  const line = preview.children.find(
    (child) => child.name === 'ballistic-preview-line',
  ) as THREE.Line;
  const shadow = preview.children.find(
    (child) => child.name === 'ballistic-preview-shadow',
  ) as THREE.Line;
  assert.equal(line.visible, true);
  assert.equal(shadow.visible, true, '纸面色的地上，白线要靠这条暗边才看得见');

  const points = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  assert.ok(points.count >= 8, '弧要够平滑');
  // 两端就是玩法侧给的那两点。
  assert.ok(Math.abs(points.getX(0) - 0) < 1e-6);
  assert.ok(Math.abs(points.getY(0) - 0.6) < 1e-6);
  assert.ok(Math.abs(points.getZ(points.count - 1) - 12) < 1e-6);
  assert.ok(Math.abs(points.getY(points.count - 1) - 0) < 1e-6);
  // 中间抬起来：它是一条抛物线，不是两点之间的直线。
  const middle = Math.floor(points.count / 2);
  assert.ok(points.getY(middle) > 0.6, `弧顶应当高过出手点，实际 ${points.getY(middle)}`);
  // 暗边压在白线下面，两条线的水平位置一致。
  const shadowPoints = shadow.geometry.getAttribute('position') as THREE.BufferAttribute;
  assert.ok(shadowPoints.getY(middle) < points.getY(middle));
  assert.ok(Math.abs(shadowPoints.getX(middle) - points.getX(middle)) < 1e-9);

  scene.setBallisticPreview(undefined);
  assert.equal(line.visible, false);
  assert.equal(shadow.visible, false);
});

test('拉得越满弧越平：同样的落点，满蓄力的弧顶更低', () => {
  const scene = new ThreeRenderScene(new THREE.Group(), {
    fogColor: '#ffffff',
    fogNear: 20,
    fogFar: 60,
  });
  const apexOf = (ratio: number): number => {
    scene.setBallisticPreview({
      originX: 0, originY: 0.6, originZ: 0, impactX: 0, impactY: 0, impactZ: 12, ratio,
    });
    settlePreview(scene);
    const preview = scene.root.children.find((child) => child.name === 'ballistic-preview')!;
    const line = preview.children.find(
      (child) => child.name === 'ballistic-preview-line',
    ) as THREE.Line;
    const points = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    return points.getY(Math.floor(points.count / 2));
  };
  assert.ok(apexOf(1) < apexOf(0.2), '拉满是一条平射，轻放是一条吊射');
});

test('弓面垂直于射向：立在 YZ 上，弓臂鼓向 +Z、弦落在射手这一侧', () => {
  const definition = { model: 'line-art-wood-bow', length: 1, thickness: 0.03 } as never;
  const geometry = createWoodBowLimbGeometry(definition);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;

  // 手持体只继承玩家的 yaw，+Z 就是射出去的方向（`weaponImpactPoint` 用的同一套）。
  // 弓面因此必须立在 YZ 上：X 上只剩木头本身那点粗细，多一点就是横着端弓。
  assert.ok(box.max.x - box.min.x <= definition.thickness * 2 + 1e-6, '弓面不该占 X');
  assert.ok(box.max.y - box.min.y > definition.length * 0.9, '长轴是 Y，弓立着');
  // 鼓向目标、弦贴着射手：射手拉的是弦，弓背朝前。
  assert.ok(box.max.z > definition.length * 0.4, '弓臂鼓向 +Z');
  assert.ok(woodBowStringOffset(definition) < 0, '弦落在 -Z，也就是射手这一边');
});

test('一路无阻的那条弧不带截断：省下的是「这条线完不完整」这个问题', () => {
  const harness = aimHarness();
  harness.controller.setChargeRatio(1);
  harness.controller.update();
  const preview = harness.previews.at(-1)!;
  assert.equal(preview.travel, undefined);
  assert.equal(ballisticArcTravel(preview), 1);
});

test('前面有堵墙时预览线在墙上截断，端点仍然是没被挡住时的那一对', () => {
  const harness = aimHarness();
  harness.blockAt.travel = 0.4;
  harness.controller.setChargeRatio(1);
  harness.controller.update();
  const preview = harness.previews.at(-1)!;
  assert.equal(preview.travel, 0.4);
  // 端点不动是有意的：被挡住只把这条曲线截短，不改变它的形状。改端点会顺带把
  // 弧顶压平，画出来的线于是从墙面下方擦过去——落点对了，路径却错了。
  assert.ok(Math.abs(preview.impactZ - 22) < 1e-9, '名义落点仍然是满蓄力的 22 米');
  const at = { x: 0, y: 0, z: 0 };
  ballisticArcPoint(preview, ballisticArcTravel(preview), at);
  assert.ok(Math.abs(at.z - 22 * 0.4) < 1e-9, '线的末端落在截断处');
});

test('截断处就是白线的末端：渲染侧画到那里为止，不穿过去', () => {
  const visual = new ThreeBallisticPreviewVisual();
  const arc = {
    originX: 0, originY: 1.6, originZ: 0,
    impactX: 0, impactY: 0, impactZ: 20,
    ratio: 1,
    travel: 0.25,
  };
  visual.setState(arc);
  visual.advance(1);
  const positions = (visual as unknown as { positions: Float32Array }).positions;
  const lastZ = positions[positions.length - 1];
  assert.ok(Math.abs(lastZ - 5) < 1e-4, `线该停在 5 米处，实际 ${lastZ}`);
  // 同一条弧不截断时画满 20 米：顶点数没变，变的只是末端。
  visual.setState({ ...arc, travel: undefined });
  visual.advance(1);
  assert.ok(Math.abs(positions[positions.length - 1] - 20) < 1e-4);
});

test('线是从枪口长出来的，不是一帧蹦出 8.4 米', () => {
  // 空放阈值 0.15 加上 6 米起跳的射程：圈刚过阈值那一帧，弧从「没有」变成
  // 8.4 米——占满射程的三分之一还多，屏幕上就是先抖一下才开始逐渐变长。
  const visual = new ThreeBallisticPreviewVisual();
  const arc = {
    originX: 0, originY: 0.62, originZ: 0,
    impactX: 0, impactY: 0, impactZ: 8.4,
    ratio: 0.15,
  };
  const positions = (visual as unknown as { positions: Float32Array }).positions;
  const drawnLength = () => positions[positions.length - 1];

  visual.setState(arc);
  assert.ok(drawnLength() < 0.01, `第一帧还在枪口上，实际 ${drawnLength()}`);

  // 之后一帧一帧长，长度单调不减，且一小段时间内就长满。
  let previous = drawnLength();
  for (let frame = 0; frame < 12; frame += 1) {
    visual.setState(arc);
    visual.advance(1 / 60);
    assert.ok(drawnLength() >= previous - 1e-9, `第 ${frame} 帧缩回去了`);
    previous = drawnLength();
  }
  assert.ok(Math.abs(drawnLength() - 8.4) < 1e-4, `五分之一秒内该长满，实际 ${drawnLength()}`);
});

test('被挡住立刻缩回来：变长可以追，变短不能欠着', () => {
  const visual = new ThreeBallisticPreviewVisual();
  const arc = {
    originX: 0, originY: 0.62, originZ: 0,
    impactX: 0, impactY: 0, impactZ: 20,
    ratio: 1,
  };
  const positions = (visual as unknown as { positions: Float32Array }).positions;
  visual.setState(arc);
  visual.advance(1);
  assert.ok(Math.abs(positions[positions.length - 1] - 20) < 1e-4);

  // 半路上突然站了个东西：线这一帧就得停在它前面，多画一帧都是在说谎。
  visual.setState({ ...arc, travel: 0.2 });
  assert.ok(Math.abs(positions[positions.length - 1] - 4) < 1e-4, '截断立刻生效');
});

test('收圈就收线：换手、进建造模式都不该留下一条线', () => {
  const harness = aimHarness();
  harness.controller.setChargeRatio(0.8);
  harness.controller.update();
  harness.controller.reset();
  assert.equal(harness.previews.at(-1), undefined, '线收起来了');
});

test('弧是一条：预览线上的点和箭在同一 t 处重合，两端就是出手点与落点', () => {
  const arc = {
    originX: 0, originY: 1.6, originZ: 0,
    impactX: 0, impactY: 0, impactZ: 20,
    ratio: 0.5,
  };
  const point = { x: 0, y: 0, z: 0 };
  ballisticArcPoint(arc, 0, point);
  assert.deepEqual({ ...point }, { x: 0, y: 1.6, z: 0 }, 't=0 是出手点');
  ballisticArcPoint(arc, 1, point);
  assert.deepEqual({ ...point }, { x: 0, y: 0, z: 20 }, 't=1 正好落在落点上');
  // 中间抬起来：抬多高由蓄力比例收，但一定在两端连线之上。
  ballisticArcPoint(arc, 0.5, point);
  assert.ok(point.y > 1.6, '弧顶在出手点之上');
  assert.ok(Math.abs(point.z - 10) < 1e-9, '水平方向匀速推进');
  // 拉得越满弧越平：同一段距离，满蓄力的弧顶低于半蓄力。
  const flat = { ...arc, ratio: 1 };
  const flatApex = ballisticArcApex(flat);
  assert.ok(flatApex < ballisticArcApex(arc), '拉满时弧最平');
  assert.ok(flatApex > 0, '再平也还是一条弧');
});

test('摇杆推着的时候它说了算：朝向跟着推杆方向，不再听指针', () => {
  const harness = aimHarness();
  // 指针指着身后（+Z 的反向），摇杆推向右（屏幕 +x → 世界 +x）。
  harness.setPointer({ origin: [0, 9, 8], direction: [0, -1, -1] });
  harness.pushAim(1, 0);
  harness.controller.update();

  const target = harness.facing.at(-1)!;
  assert.ok(target.x > harness.player.x, '朝向对准了摇杆推的那一侧');
  assert.ok(Math.abs(target.z - harness.player.z) < 1e-9, '推正右时不该带上前后分量');
});

test('松开摇杆之后朝向交回指针，不定在最后一次推的方向上', () => {
  const harness = aimHarness();
  // 先记下纯指针时对准的是哪儿。
  harness.controller.update();
  const pointerOnly = harness.facing.at(-1)!;

  harness.pushAim(1, 0);
  harness.controller.update();
  assert.notDeepEqual(harness.facing.at(-1), pointerOnly, '推着杆时听杆的');

  harness.pushAim(0, 0);
  harness.controller.update();
  assert.deepEqual(harness.facing.at(-1), pointerOnly, '松开就交回指针，不定在推杆那一侧');
});

test('拉弓：弓梢向后转、弦中点后移成 V 形，两者都跟着同一个比例', () => {
  const definition = { model: 'line-art-wood-bow', length: 1, thickness: 0.03 } as never;
  const model = createWoodBowModel({ fogColor: '#fff', fogNear: 10, fogFar: 100 }, definition);
  const rig = model.woodBowRig!;
  const visual = new ThreeWoodBowVisual(0 as never, rig);
  const transforms = new StubTransforms();

  transforms.set(PARAM_BOW_CHARGE, 0);
  visual.update(transforms as never, 1 / 60);
  assert.ok(Math.abs(rig.upperLimb.rotation.x) < 1e-9, '没拉的时候弓是直的');
  const rest = rig.string.geometry.getAttribute('position').getZ(1);
  // 顶点是 float32，所以比的是「同一处」而不是同一个双精度数。
  assert.ok(Math.abs(rest - rig.stringOffsetZ) < 1e-6, '弦中点贴在两梢那条线上');

  transforms.set(PARAM_BOW_CHARGE, 1);
  visual.update(transforms as never, 1 / 60);
  // 16°，上下反号：两条弓臂在原点两侧，同样是「向后」。
  assert.ok(Math.abs(rig.upperLimb.rotation.x + BOW_LIMB_BEND_RADIANS) < 1e-9);
  assert.ok(Math.abs(rig.lowerLimb.rotation.x - BOW_LIMB_BEND_RADIANS) < 1e-9);
  const pulled = rig.string.geometry.getAttribute('position');
  assert.ok(
    Math.abs(pulled.getZ(1) - (rig.stringOffsetZ - BOW_STRING_PULL)) < 1e-6,
    '弦中点后移 0.18 米',
  );
  assert.ok(pulled.getZ(1) < pulled.getZ(0), '中点比两梢更靠后——这就是那个 V');
});

test('撒手：弦从当时的后移量回弹过冲，弓梢比弦先回正', () => {
  // 曲线本身是纯函数，所以直接问它，不必摆一把弓出来。
  assert.ok(Math.abs(bowReleaseStringPull(BOW_STRING_PULL, 0) - BOW_STRING_PULL) < 1e-9,
    '撒手那一刻正接在拉满的位置上，不跳');
  // 中途越过 0 往前过冲：这就是「弹回去」那一下。
  const samples = [];
  for (let step = 1; step <= 12; step += 1) {
    samples.push(bowReleaseStringPull(BOW_STRING_PULL, (step / 12) * BOW_RELEASE_SECONDS));
  }
  assert.ok(samples.some((value) => value < 0), '过冲到弦的前面去了');
  assert.ok(Math.abs(samples.at(-1)!) < 0.005, '这一下结束时基本收住了');

  // 弓梢在前 1/3 就回正：木头比弦硬，一起抖会让整把弓看上去是软的。
  assert.ok(bowReleaseLimbBend(1, BOW_RELEASE_SECONDS * 0.2) > 0);
  assert.equal(bowReleaseLimbBend(1, BOW_RELEASE_SECONDS * 0.34), 0);
});

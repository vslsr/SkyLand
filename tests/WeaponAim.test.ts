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
import { ThreeRenderScene } from '../src/render/three/ThreeRenderScene.ts';
import { ItemUseInputTags } from '../src/input/config/playerInput.ts';

const BOW = itemCatalog.require('wood-bow').weapon!;

interface AimHarness {
  controller: WeaponAimController;
  facing: Array<{ x: number; z: number } | undefined>;
  previews: Array<BallisticPreviewState | undefined>;
  setHeld(itemType: string | undefined): void;
  setPointer(ray: { origin: [number, number, number]; direction: [number, number, number] } | undefined): void;
  player: { x: number; y: number; z: number; yaw: number };
}

function aimHarness(): AimHarness {
  const facing: AimHarness['facing'] = [];
  const previews: AimHarness['previews'] = [];
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
  });
  return {
    controller,
    facing,
    previews,
    player,
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
    const preview = scene.root.children.find((child) => child.name === 'ballistic-preview')!;
    const line = preview.children.find(
      (child) => child.name === 'ballistic-preview-line',
    ) as THREE.Line;
    const points = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    return points.getY(Math.floor(points.count / 2));
  };
  assert.ok(apexOf(1) < apexOf(0.2), '拉满是一条平射，轻放是一条吊射');
});

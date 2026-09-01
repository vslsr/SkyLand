import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D } from 'three';
import { CameraBoom, type CameraProbe } from '../src/camera/CameraBoom';
import { TopDownController } from '../src/controllers/TopDownController';
import {
  SceneControlRouter,
  type SceneCameraController,
} from '../src/controllers/SceneControlRouter';
import { createCameraViewMatrix, type CameraAxes } from '../src/camera/cameraMath';
import type { InputSubsystem } from '../src/input/index';
import type { Vec3 } from '../src/math/vec3';

const PIVOT: Vec3 = [0, 0.25, 0];
const OFFSET: Vec3 = [5.5, 7.5, 8.5];

function createTopDownController(options: {
  cameraCollisionEnabled?: boolean;
  cameraProbe: CameraProbe;
  cameraOffset?: Vec3;
}): TopDownController {
  const canvas = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
  const input = {
    bind: () => () => undefined,
  } as unknown as InputSubsystem;
  return new TopDownController(canvas, new Object3D(), input, options);
}

test('没有探针时悬臂保持全长', () => {
  const boom = new CameraBoom();
  assert.equal(boom.solve(PIVOT, OFFSET, 0.016), 1);
  assert.equal(boom.distanceRatio, 1);
});

test('撞上遮挡立刻收回，晚一帧就是穿模一帧', () => {
  const boom = new CameraBoom();
  const ratio = boom.solve(PIVOT, OFFSET, 0.016, () => 0.4);
  assert.ok(Math.abs(ratio - 0.4) < 1e-12, `实际 ${ratio}`);
});

test('遮挡让开后平滑伸回，不会瞬间弹回去', () => {
  const boom = new CameraBoom({ extendSpeed: 2.4 });
  boom.solve(PIVOT, OFFSET, 0.016, () => 0.3);
  const afterOneFrame = boom.solve(PIVOT, OFFSET, 0.016, () => 1);
  assert.ok(afterOneFrame > 0.3, '完全没有伸回');
  assert.ok(afterOneFrame < 0.5, `一帧就弹回了太多：${afterOneFrame}`);

  let ratio = afterOneFrame;
  for (let frame = 0; frame < 240; frame += 1) {
    ratio = boom.solve(PIVOT, OFFSET, 0.016, () => 1);
  }
  assert.ok(ratio > 0.999, `最终没有收敛回全长：${ratio}`);
});

test('支点本身被埋住时收到下限，而不是贴到角色脸上或留在几何体里', () => {
  const boom = new CameraBoom({ minimumRatio: 0.2 });
  const ratio = boom.solve(PIVOT, OFFSET, 0.016, () => 0);
  assert.ok(Math.abs(ratio - 0.2) < 1e-12, `实际 ${ratio}`);
});

test('每帧都按全长扫掠，否则悬臂再也伸不回去', () => {
  const boom = new CameraBoom();
  const probed: Array<{ start: Vec3; end: Vec3; radius: number }> = [];
  const probe: CameraProbe = (start, end, radius) => {
    probed.push({ start: [...start] as Vec3, end: [...end] as Vec3, radius });
    return 0.3;
  };
  boom.solve(PIVOT, OFFSET, 0.016, probe);
  boom.solve(PIVOT, OFFSET, 0.016, probe);

  assert.equal(probed.length, 2);
  for (const call of probed) {
    assert.deepEqual(call.start, PIVOT);
    assert.deepEqual(call.end, [
      PIVOT[0] + OFFSET[0],
      PIVOT[1] + OFFSET[1],
      PIVOT[2] + OFFSET[2],
    ]);
    assert.ok(call.radius > 0, '探针半径必须为正，否则近裁剪面会切进墙里');
  }
});

test('探针返回异常值时退回全长，不把 NaN 带进相机矩阵', () => {
  const boom = new CameraBoom();
  const ratio = boom.solve(PIVOT, OFFSET, 0.016, () => Number.NaN);
  assert.equal(ratio, 1);
});

test('reset 丢掉上一处的收缩量，瞬移之后镜头不会莫名贴脸', () => {
  const boom = new CameraBoom();
  boom.solve(PIVOT, OFFSET, 0.016, () => 0.25);
  boom.reset();
  assert.equal(boom.distanceRatio, 1);
});

test('TopDown 控制器默认不判定遮挡也不收缩镜头', () => {
  let probeCount = 0;
  const controller = createTopDownController({
    cameraProbe: () => {
      probeCount += 1;
      return 0.4;
    },
  });

  controller.update(0.016);

  assert.equal(probeCount, 0);
  assert.equal(controller.cameraDistance, 1);
  controller.dispose();
});

test('TopDown 控制器显式开启后才会按碰撞结果收缩镜头', () => {
  let probeCount = 0;
  const controller = createTopDownController({
    cameraCollisionEnabled: true,
    cameraProbe: () => {
      probeCount += 1;
      return 0.4;
    },
  });

  controller.update(0.016);

  assert.equal(probeCount, 1);
  assert.ok(Math.abs(controller.cameraDistance - 0.4) < 1e-12);
  assert.equal(
    controller.frame.position[1],
    PIVOT[1] + OFFSET[1],
    '遮挡收缩不能覆盖玩法 Scene 配置的 TopDown 高度',
  );
  assert.equal(
    controller.frame.position[0],
    PIVOT[0] + OFFSET[0] * 0.4,
    '遮挡仍应收缩 XZ 平面距离',
  );
  controller.dispose();
});

test('TopDown 使用玩法 Scene 的完整 camera.position 作为焦点偏移', () => {
  const sceneOffset: Vec3 = [0, 9, 14];
  const controller = createTopDownController({
    cameraOffset: sceneOffset,
    cameraProbe: () => 1,
  });

  assert.deepEqual(
    controller.frame.position,
    [PIVOT[0] + sceneOffset[0], PIVOT[1] + sceneOffset[1], PIVOT[2] + sceneOffset[2]],
  );
  controller.dispose();
});

test('TopDown 镜头平滑追随玩家，传送重置时才立即对齐', () => {
  const controller = createTopDownController({
    cameraProbe: () => 1,
  });
  const initialX = controller.frame.position[0];
  const initialY = controller.frame.position[1];

  controller.setPosition(6, 0);
  assert.equal(controller.frame.position[0], initialX, '移动发生时镜头不能瞬切到玩家新位置');

  controller.update(1 / 60);
  const firstFrameX = controller.frame.position[0];
  assert.ok(firstFrameX > initialX, '镜头应当开始追随');
  assert.ok(firstFrameX < initialX + 6, '第一帧不能直接追到目标');

  controller.setVerticalPosition(3);
  assert.equal(controller.frame.position[1], initialY, '纵向移动发生时镜头也不能瞬切');
  controller.update(1 / 60);
  const verticalTarget = 3 + PIVOT[1] + OFFSET[1];
  assert.ok(
    controller.frame.position[1] > initialY && controller.frame.position[1] < verticalTarget,
    '跳跃或上下坡时镜头 Y 轴必须连续追随',
  );

  for (let frame = 0; frame < 120; frame += 1) controller.update(1 / 60);
  assert.ok(
    Math.abs(controller.frame.position[0] - (initialX + 6)) < 1e-6,
    '平滑追随最终必须收敛到玩家',
  );
  assert.ok(
    Math.abs(controller.frame.position[1] - verticalTarget) < 1e-6,
    '纵向平滑追随最终必须恢复玩法 Scene 配置的视角高度',
  );

  controller.setPosition(-6, 0);
  controller.resetCamera();
  assert.ok(
    Math.abs(controller.frame.position[0] - (initialX - 6)) < 1e-12,
    '传送重置必须直接对齐，不能跨世界缓慢追赶',
  );
  controller.dispose();
});

test('TopDown 长帧不会让镜头单帧瞬切到移动单位', () => {
  const controller = createTopDownController({ cameraProbe: () => 1 });
  const initialX = controller.frame.position[0];

  controller.setPosition(6, 0);
  controller.update(1);

  assert.ok(controller.frame.position[0] > initialX, '长帧后镜头仍应继续追随');
  assert.ok(
    controller.frame.position[0] < initialX + 3,
    '卡顿产生的长 delta 不能令阻尼在单帧内追到目标',
  );
  controller.dispose();
});

test('切换到 TopDown 时平滑过渡平面机位，但立即恢复原视角高度', () => {
  const axes: CameraAxes = {
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, -1],
  };
  const createController = (cameraX: number, cameraY: number): SceneCameraController => ({
    frame: {
      position: [cameraX, cameraY, 8],
      axes,
      viewMatrix: createCameraViewMatrix([cameraX, cameraY, 8], axes),
    },
    setInputEnabled: () => undefined,
    update: () => undefined,
  });
  const fly = createController(0, 2);
  const topDown = createController(10, 7.75);
  const router = new SceneControlRouter(fly, { cameraTransitionDurationSeconds: 0.4 });

  router.setPlayerController(topDown);
  assert.equal(router.frame.position[0], 0, '切换当帧必须保持原机位');
  assert.equal(router.frame.position[1], 7.75, '切换当帧就必须恢复 TopDown 原视角高度');

  router.update(0.2, 0.2);
  assert.ok(router.frame.position[0] > 0 && router.frame.position[0] < 10);

  router.update(0.2, 0.4);
  assert.equal(router.frame.position[0], 10, '过渡结束必须精确落到 TopDown 机位');
});

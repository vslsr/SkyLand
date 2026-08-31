import assert from 'node:assert/strict';
import test from 'node:test';
import { CameraBoom, type CameraProbe } from '../src/camera/CameraBoom';
import type { Vec3 } from '../src/math/vec3';

const PIVOT: Vec3 = [0, 0.25, 0];
const OFFSET: Vec3 = [5.5, 7.5, 8.5];

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

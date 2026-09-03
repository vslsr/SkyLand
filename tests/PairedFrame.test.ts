import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderCameraBuffer } from '../src/render/RenderCameraBuffer';
import { RenderTransformBuffer } from '../src/render/RenderTransformBuffer';
import { toProxyId } from '../src/render/RenderScene';
import {
  consumePairedFrame,
  type PairedFrameIds,
  type PairedFrameSources,
} from '../src/render/worker/pairedFrame';

/**
 * 机位与 transform 成对读入（`pairedFrame.ts`）。
 *
 * 用真的两段字节模拟主线程：先翻 transform、再带着帧号翻机位。渲染线程那一侧在
 * 各种时刻插进来读，画出来的相机与世界必须是同一帧，除非主线程真的卡在两次翻面
 * 之间超过重试上限——那时照实画并记撕裂。
 */

function emptyIds(): PairedFrameIds {
  return { transformFrameId: 0, cameraFrameId: 0, pairedTransformFrameId: 0, torn: false, retries: 0 };
}

/** 主线程那一侧：一帧 = 写位置、翻 transform、写机位、带号翻机位。 */
function mainThreadFrame(transforms: RenderTransformBuffer, camera: RenderCameraBuffer, x: number): void {
  transforms.write(toProxyId(0), x, 0, 0, 0);
  transforms.publish();
  camera.write([x, 5, 8], [0, -0.5, -1], [0, 1, 0]);
  camera.publish(transforms.frameId);
}

function sources(
  transforms: RenderTransformBuffer,
  camera: RenderCameraBuffer,
  seen: { x: number[]; cameraX: number[]; waits: number[] },
  waitBehaviour?: (frameId: number) => void,
): PairedFrameSources {
  const out = { x: 0, y: 0, z: 0, yaw: 0 };
  const cameraOut = { position: [0, 0, 0] as [number, number, number], forward: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
  return {
    transforms,
    camera: {
      get frameId() { return camera.frameId; },
      get pairedTransformFrameId() { return camera.pairedTransformFrameId; },
      waitForFrame(frameId, timeoutMs) {
        seen.waits.push(timeoutMs);
        waitBehaviour?.(frameId);
        return camera.frameId === frameId ? 'timed-out' : 'ok';
      },
    },
    submitTransforms: () => { seen.x.push(transforms.readTransform(toProxyId(0), out).x); },
    readCamera: () => { seen.cameraX.push(camera.read(cameraOut).position[0]); },
  };
}

test('主线程两次翻面都完成了：一次读齐，不等、不重试', () => {
  const transforms = new RenderTransformBuffer(2);
  const camera = new RenderCameraBuffer();
  mainThreadFrame(transforms, camera, 1);
  mainThreadFrame(transforms, camera, 2);
  const seen = { x: [] as number[], cameraX: [] as number[], waits: [] as number[] };
  const ids = consumePairedFrame(sources(transforms, camera, seen), emptyIds());
  assert.equal(ids.torn, false);
  assert.equal(ids.retries, 0);
  assert.equal(ids.transformFrameId, 2);
  assert.equal(ids.pairedTransformFrameId, 2);
  assert.deepEqual(seen.x, [2]);
  assert.deepEqual(seen.cameraX, [2], '相机和世界都是第 2 帧的');
  assert.equal(seen.waits.length, 0);
});

test('渲染线程插在两次翻面之间：等机位到了再读一次，相机与世界仍是同一帧', () => {
  const transforms = new RenderTransformBuffer(2);
  const camera = new RenderCameraBuffer();
  mainThreadFrame(transforms, camera, 1);
  // 主线程走到第 2 帧的一半：transform 翻了，机位还没。
  transforms.write(toProxyId(0), 2, 0, 0, 0);
  transforms.publish();
  const seen = { x: [] as number[], cameraX: [] as number[], waits: [] as number[] };
  const ids = consumePairedFrame(
    sources(transforms, camera, seen, () => {
      // 「等机位」期间主线程把第 2 帧的机位翻了出来。
      camera.write([2, 5, 8], [0, -0.5, -1], [0, 1, 0]);
      camera.publish(transforms.frameId);
    }),
    emptyIds(),
  );
  assert.equal(ids.torn, false);
  assert.equal(ids.retries, 1);
  assert.equal(ids.transformFrameId, 2);
  assert.equal(ids.pairedTransformFrameId, 2);
  assert.deepEqual(seen.x, [2, 2], '第一次读到 transform 第 2 帧、机位第 1 帧，对不上，重读');
  assert.deepEqual(seen.cameraX, [1, 2]);
  assert.equal(seen.waits.length, 1, '等了一次机位');
});

test('主线程卡在两次翻面之间不动：重试到上限后照实画，记一次撕裂', () => {
  const transforms = new RenderTransformBuffer(2);
  const camera = new RenderCameraBuffer();
  mainThreadFrame(transforms, camera, 1);
  transforms.write(toProxyId(0), 2, 0, 0, 0);
  transforms.publish();
  const seen = { x: [] as number[], cameraX: [] as number[], waits: [] as number[] };
  const ids = consumePairedFrame(sources(transforms, camera, seen), emptyIds(), 2, 2);
  assert.equal(ids.torn, true, '两次之后还对不上：这一帧确实是撕的');
  assert.equal(ids.retries, 2);
  assert.equal(ids.transformFrameId, 2);
  assert.equal(ids.pairedTransformFrameId, 1);
  assert.deepEqual(seen.waits, [2, 2], '每次重试前等 2ms');
});

test('机位配的号比 transform 新（翻面顺序写反了）：不等，直接重读 transform', () => {
  const transforms = new RenderTransformBuffer(2);
  const camera = new RenderCameraBuffer();
  mainThreadFrame(transforms, camera, 1);
  // 错误顺序：机位先声称配第 2 帧，transform 随后才翻。
  camera.write([2, 5, 8], [0, -0.5, -1], [0, 1, 0]);
  camera.publish(transforms.frameId + 1);
  const seen = { x: [] as number[], cameraX: [] as number[], waits: [] as number[] };
  let submitted = 0;
  const base = sources(transforms, camera, seen);
  const ids = consumePairedFrame({
    ...base,
    submitTransforms: () => {
      submitted += 1;
      // 重读之前主线程把 transform 翻了出来。
      if (submitted === 2) {
        transforms.write(toProxyId(0), 2, 0, 0, 0);
        transforms.publish();
      }
      base.submitTransforms();
    },
  }, emptyIds());
  assert.equal(seen.waits.length, 0, '机位更新时不需要等机位');
  assert.equal(ids.torn, false);
  assert.equal(ids.retries, 2);
  assert.equal(ids.transformFrameId, 2);
});

test('大厅里 transform 一次都没翻过：机位配的号恒为 0，帧帧对得上', () => {
  const transforms = new RenderTransformBuffer(2);
  const camera = new RenderCameraBuffer();
  for (let frame = 0; frame < 3; frame += 1) {
    camera.write([frame, 5, 8], [0, -0.5, -1], [0, 1, 0]);
    camera.publish(transforms.frameId);
    const seen = { x: [] as number[], cameraX: [] as number[], waits: [] as number[] };
    const ids = consumePairedFrame(sources(transforms, camera, seen), emptyIds());
    assert.equal(ids.torn, false);
    assert.equal(ids.transformFrameId, 0);
  }
});

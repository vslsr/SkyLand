import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  createRenderCamera,
  RENDER_CAMERA_HEADER_INT32_COUNT,
  RENDER_CAMERA_STRIDE,
  RenderCameraBuffer,
} from '../src/render/RenderCameraBuffer';

/**
 * 相机过边界的那一段字节（实现路径文档 §3）。
 *
 * 盯的是和 transform SoA 同一批不变量：翻面之前读的是上一帧、翻面之后读的是这一帧、
 * 漏写一帧保持上一帧而不是回到两帧前。
 */

test('没人写过也读得出一个能用的朝向，而不是全 0', () => {
  // 全 0 的 forward 会让 lookAt 算出 NaN，整帧变黑。
  const camera = new RenderCameraBuffer().read(createRenderCamera());
  assert.deepEqual(camera.position, [0, 0, 0]);
  assert.deepEqual(camera.forward, [0, 0, -1]);
  assert.deepEqual(camera.up, [0, 1, 0]);
});

test('写了但没翻面，读的一侧还是上一帧——不会读到写到一半的机位', () => {
  const buffer = new RenderCameraBuffer();
  const out = createRenderCamera();
  buffer.write([1, 2, 3], [0, 0, 1], [0, 1, 0]);
  assert.deepEqual(buffer.read(out).position, [0, 0, 0], '翻面前读面不该动');
  buffer.publish();
  assert.deepEqual(buffer.read(out).position, [1, 2, 3]);
  assert.deepEqual(buffer.read(out).forward, [0, 0, 1]);
});

test('漏写一帧保持上一帧的机位，而不是回到两帧前', () => {
  const buffer = new RenderCameraBuffer();
  const out = createRenderCamera();
  buffer.write([1, 0, 0], [1, 0, 0], [0, 1, 0]);
  buffer.publish();
  buffer.write([2, 0, 0], [0, 1, 0], [0, 0, 1]);
  buffer.publish();
  // 这一帧没人写，直接翻面。
  buffer.publish();
  assert.deepEqual(buffer.read(out).position, [2, 0, 0]);
  assert.deepEqual(buffer.read(out).forward, [0, 1, 0]);
});

test('帧号每翻一次面涨一，渲染侧靠它判断机位是不是新的', () => {
  const buffer = new RenderCameraBuffer();
  assert.equal(buffer.frameId, 0);
  buffer.publish();
  buffer.publish();
  assert.equal(buffer.frameId, 2);
});

test('整段字节能整体投递，长度就是两面加表头', () => {
  const buffer = new RenderCameraBuffer();
  assert.equal(
    buffer.bytes.byteLength,
    RENDER_CAMERA_HEADER_INT32_COUNT * Int32Array.BYTES_PER_ELEMENT
      + 2 * RENDER_CAMERA_STRIDE * Float32Array.BYTES_PER_ELEMENT,
  );
});

/**
 * 机位翻面时带着它配的 transform 帧号（实现路径文档 §3 的补丁）：渲染线程靠它核对
 * 相机与世界是不是同一帧。读的一侧凭同一段字节就能读到这个号。
 */
test('翻面带上配对的 transform 帧号，读的一侧读得到', () => {
  const writer = new RenderCameraBuffer();
  const reader = RenderCameraBuffer.fromBytes(writer.bytes);
  assert.equal(reader.pairedTransformFrameId, 0, '没翻过面是 0');
  writer.write([1, 0, 0], [0, 0, -1], [0, 1, 0]);
  writer.publish(41);
  assert.equal(reader.pairedTransformFrameId, 41);
  assert.equal(reader.frameId, 1);
  // 不带参数的 publish 把配对号归零，不会把上一帧的号带下去当成这一帧的。
  writer.publish();
  assert.equal(reader.pairedTransformFrameId, 0);
});

/** 真的等一次：另一条线程 5ms 后翻面，这一侧要被叫醒而不是等到超时。 */
test('publish() 叫醒另一条线程里等这一帧机位的人', async () => {
  const buffer = new RenderCameraBuffer();
  assert.ok(buffer.isShared);
  const before = buffer.frameId;
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const header = new Int32Array(workerData.bytes, 0, ${RENDER_CAMERA_HEADER_INT32_COUNT});
    setTimeout(() => {
      Atomics.add(header, 1, 1);
      Atomics.notify(header, 1);
      parentPort.postMessage('published');
    }, 5);
    `,
    { eval: true, workerData: { bytes: buffer.bytes } },
  );
  try {
    const startedAt = performance.now();
    const result = buffer.waitForFrame(before, 2000);
    assert.equal(result, 'ok');
    assert.ok(performance.now() - startedAt < 1000, '应该是被叫醒的，不是超时');
    assert.equal(buffer.frameId, before + 1);
  } finally {
    await worker.terminate();
  }
  // 帧号已经不等于要等的值：立刻返回，不等。预算为 0 也不等。
  assert.equal(buffer.waitForFrame(before, 50), 'not-equal');
  assert.equal(buffer.waitForFrame(buffer.frameId, 0), 'unsupported');
});

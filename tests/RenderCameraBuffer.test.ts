import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRenderCamera,
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
    2 * Int32Array.BYTES_PER_ELEMENT
      + 2 * RENDER_CAMERA_STRIDE * Float32Array.BYTES_PER_ELEMENT,
  );
});

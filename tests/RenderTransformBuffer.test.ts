import test from 'node:test';
import assert from 'node:assert/strict';
import { NULL_PROXY_ID, toProxyId } from '../src/render/RenderScene';
import { PARAM_FIRE_TARGET_INTENSITY } from '../src/render/RenderVisualParams';
import {
  RENDER_TRANSFORM_STRIDE,
  RenderTransformBuffer,
  type RenderTransform,
} from '../src/render/RenderTransformBuffer';

const out = (): RenderTransform => ({ x: 0, y: 0, z: 0, yaw: 0 });

test('写入的字节要 publish 之后才对读侧可见', () => {
  const buffer = new RenderTransformBuffer(4);
  const slot = toProxyId(0);
  buffer.write(slot, 1, 2, 3, 0.5);
  // 双缓冲的意义就在这一行：渲染侧读的是上一帧发布过的那一面，
  // 模拟侧写到一半的数据不会被看见。
  assert.deepEqual(buffer.readTransform(slot, out()), { x: 0, y: 0, z: 0, yaw: 0 });

  buffer.publish();
  assert.deepEqual(buffer.readTransform(slot, out()), { x: 1, y: 2, z: 3, yaw: 0.5 });
});

test('漏写一帧退化成保持上一帧，而不是回到两帧前', () => {
  const buffer = new RenderTransformBuffer(4);
  const slot = toProxyId(1);
  buffer.write(slot, 1, 0, 0, 0);
  buffer.publish();
  buffer.write(slot, 2, 0, 0, 0);
  buffer.publish();

  // 这一帧什么都不写，直接翻面。
  buffer.publish();
  assert.equal(buffer.readTransform(slot, out()).x, 2);
});

test('父链接跟着 transform 一起过边界', () => {
  const buffer = new RenderTransformBuffer(4);
  const parent = toProxyId(0);
  const child = toProxyId(1);
  buffer.write(parent, 5, 0, 0, 0);
  buffer.write(child, 6, 0, 0, 0, parent);
  buffer.publish();

  assert.equal(buffer.readParent(child), parent);
  assert.equal(buffer.readParent(parent), NULL_PROXY_ID);
});

test('扩容保留两个 bank 的内容，视图重建后旧数据仍可读', () => {
  const buffer = new RenderTransformBuffer(2);
  const first = toProxyId(0);
  buffer.write(first, 7, 8, 9, 0.25);
  buffer.publish();

  const far = toProxyId(9);
  buffer.write(far, 1, 1, 1, 0);
  assert.ok(buffer.capacity > 9);
  // 扩容重新分配了底层字节并重建了所有视图；已发布的那一面必须原样搬过去。
  assert.deepEqual(buffer.readTransform(first, out()), { x: 7, y: 8, z: 9, yaw: 0.25 });

  buffer.publish();
  assert.equal(buffer.readTransform(far, out()).x, 1);
  assert.equal(buffer.readTransform(first, out()).x, 7);
});

test('槽位回收会清掉两个 bank，避免复用时读到上一个 proxy 的残留', () => {
  const buffer = new RenderTransformBuffer(4);
  const slot = toProxyId(2);
  const parent = toProxyId(3);
  buffer.write(slot, 4, 4, 4, 1, parent);
  buffer.publish();
  buffer.write(slot, 5, 5, 5, 1, parent);

  buffer.clear(slot);
  buffer.publish();
  assert.deepEqual(buffer.readTransform(slot, out()), { x: 0, y: 0, z: 0, yaw: 0 });
  assert.equal(buffer.readParent(slot), NULL_PROXY_ID);
});

test('帧号递增，字节可直接投递给 worker', () => {
  const buffer = new RenderTransformBuffer(4);
  const before = buffer.frameId;
  buffer.publish();
  buffer.publish();
  assert.equal(buffer.frameId, before + 2);

  // 跨线程传的就是这一段；Node 上 SAB 可用，所以这里应当是共享内存。
  assert.equal(buffer.isShared, true);
  assert.equal(RENDER_TRANSFORM_STRIDE, 4);
  assert.ok(buffer.bytes.byteLength > 4 * RENDER_TRANSFORM_STRIDE);
});

test('表现参数与 transform 同段、同一次 publish，不会撕裂', () => {
  const buffer = new RenderTransformBuffer(4);
  const slot = toProxyId(1);
  buffer.write(slot, 9, 0, 0, 0);
  buffer.writeParam(slot, PARAM_FIRE_TARGET_INTENSITY, 1);
  // 翻面之前两者都还看不见。
  assert.equal(buffer.readTransform(slot, out()).x, 0);
  assert.equal(buffer.readParam(slot, PARAM_FIRE_TARGET_INTENSITY), 0);

  buffer.publish();
  // 翻面之后两者一起可见——参数来自第 N 帧、位置来自第 N+1 帧是不允许的。
  assert.equal(buffer.readTransform(slot, out()).x, 9);
  assert.equal(buffer.readParam(slot, PARAM_FIRE_TARGET_INTENSITY), 1);
});

test('参数段漏写一帧也保持上一帧，而不是闪回两帧前', () => {
  // publish 的 copyWithin 是「保持上一帧」的唯一实现；新增段忘了加就会隔帧闪回。
  const buffer = new RenderTransformBuffer(4);
  const slot = toProxyId(0);
  buffer.writeParam(slot, PARAM_FIRE_TARGET_INTENSITY, 1);
  buffer.publish();
  buffer.publish();
  buffer.publish();
  assert.equal(buffer.readParam(slot, PARAM_FIRE_TARGET_INTENSITY), 1);
});

test('扩容与槽位回收都覆盖参数段', () => {
  const buffer = new RenderTransformBuffer(2);
  const slot = toProxyId(1);
  buffer.writeParam(slot, PARAM_FIRE_TARGET_INTENSITY, 1);
  buffer.publish();

  // 扩容重新分配底层字节并重建全部视图，已发布的参数必须原样搬过去。
  buffer.write(toProxyId(9), 0, 0, 0, 0);
  assert.ok(buffer.capacity > 9);
  assert.equal(buffer.readParam(slot, PARAM_FIRE_TARGET_INTENSITY), 1);

  // 槽位复用前必须清干净，否则新 proxy 会继承上一个的火焰强度。
  buffer.clear(slot);
  buffer.publish();
  assert.equal(buffer.readParam(slot, PARAM_FIRE_TARGET_INTENSITY), 0);
});

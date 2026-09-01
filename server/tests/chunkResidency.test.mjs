import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkResidency } from '../scene/ChunkResidency.mjs';
import { CHUNK_SIZE, MAXIMUM_CHUNK_COORDINATE } from '../../shared/world/worldConfig.mjs';

function createResidency(options = {}) {
  const loaded = [];
  const unloaded = [];
  const residency = new ChunkResidency({
    onLoad: (chunkX, chunkZ, key) => loaded.push(key),
    onUnload: (key) => unloaded.push(key),
    ...options,
  });
  return { residency, loaded, unloaded };
}

test('常驻集合是焦点周围的一圈，装载回调每个 chunk 只触发一次', () => {
  const { residency, loaded } = createResidency({ residentRadius: 1 });
  residency.sync([{ x: 0, z: 0 }]);
  assert.equal(residency.residentCount, 9);
  assert.equal(loaded.length, 9);
  assert.equal(new Set(loaded).size, 9);
  assert.equal(residency.has('0:0'), true);
});

test('keepRadius 提供迟滞，走远之后才卸载', () => {
  const { residency, unloaded } = createResidency({ residentRadius: 1, keepRadius: 2 });
  residency.sync([{ x: 1, z: 1 }]);

  // 只走出一圈：出生地还在 keepRadius 之内，先留着不拆。
  residency.sync([{ x: CHUNK_SIZE + 1, z: CHUNK_SIZE + 1 }]);
  assert.equal(unloaded.includes('0:0'), false);

  residency.sync([{ x: CHUNK_SIZE * 6 + 1, z: CHUNK_SIZE * 6 + 1 }]);
  assert.equal(unloaded.includes('0:0'), true);
  assert.equal(residency.residentCount, 9);
});

test('keepRadius 永远大于 residentRadius，配置写反也不会来回建拆', () => {
  const { residency } = createResidency({ residentRadius: 3, keepRadius: 1 });
  assert.equal(residency.residentRadius, 3);
  assert.equal(residency.keepRadius, 4);
});

test('没有人跨过 chunk 边界时 sync 不做任何事', () => {
  const { residency, loaded, unloaded } = createResidency({ residentRadius: 1 });
  residency.sync([{ x: 1, z: 1 }]);
  const loadedBefore = loaded.length;
  residency.sync([{ x: 2, z: 2 }]);
  residency.sync([{ x: 3, z: 3 }]);
  assert.equal(loaded.length, loadedBefore);
  assert.equal(unloaded.length, 0);
});

test('多个焦点各自带一片，互相不会把对方的卸载掉', () => {
  const { residency } = createResidency({ residentRadius: 1 });
  const far = CHUNK_SIZE * 6 + 1;
  residency.sync([{ x: 0, z: 0 }, { x: far, z: far }]);
  assert.equal(residency.residentCount, 18);
});

test('世界边缘之外不装载', () => {
  const { residency } = createResidency({ residentRadius: 1 });
  const edge = MAXIMUM_CHUNK_COORDINATE * CHUNK_SIZE + 1;
  residency.sync([{ x: edge, z: edge }]);
  assert.equal(residency.residentCount, 4);
});

test('ensureAround 把还没轮到 sync 的那一片补上，重复调用不做无用功', () => {
  const { residency, loaded } = createResidency({ residentRadius: 1 });
  residency.ensureAround(0, 0);
  assert.equal(residency.residentCount, 9);
  const before = loaded.length;
  residency.ensureAround(1, 1);
  assert.equal(loaded.length, before);
});

test('enabled 为 false 时既不装载也不卸载', () => {
  const { residency, loaded } = createResidency({ enabled: false, residentRadius: 1 });
  residency.sync([{ x: 0, z: 0 }]);
  residency.ensureAround(0, 0);
  assert.equal(residency.residentCount, 0);
  assert.equal(loaded.length, 0);
});

test('clear 对每个常驻 chunk 触发一次卸载回调', () => {
  const { residency, unloaded } = createResidency({ residentRadius: 1 });
  residency.sync([{ x: 0, z: 0 }]);
  residency.clear();
  assert.equal(residency.residentCount, 0);
  assert.equal(unloaded.length, 9);
  // 签名一并清掉，同一个焦点可以重新装载。
  residency.sync([{ x: 0, z: 0 }]);
  assert.equal(residency.residentCount, 9);
});

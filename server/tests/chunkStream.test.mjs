import test from 'node:test';
import assert from 'node:assert/strict';
import { planChunkStream } from '../../shared/world/chunkStream.mjs';
import {
  CHUNK_LOAD_RADIUS,
  CHUNK_SIZE,
  MINIMUM_CHUNK_COORDINATE,
} from '../../shared/world/worldConfig.mjs';

const expectedFullLoad = (CHUNK_LOAD_RADIUS * 2 + 1) ** 2;

test('冷启动时加载焦点周围一整块，最近的排在最前', () => {
  const plan = planChunkStream({ focusX: 0, focusZ: 0, loadedKeys: [] });
  assert.equal(plan.load.length, expectedFullLoad);
  assert.equal(plan.load[0].key, '0:0');
  assert.equal(plan.unload.length, 0);
});

test('在同一个 chunk 内移动不产生任何加载或卸载', () => {
  const initial = planChunkStream({ focusX: 0, focusZ: 0, loadedKeys: [] });
  const loaded = new Set(initial.load.map((chunk) => chunk.key));
  const plan = planChunkStream({ focusX: CHUNK_SIZE - 1, focusZ: 1, loadedKeys: loaded });
  assert.equal(plan.load.length, 0);
  assert.equal(plan.unload.length, 0);
});

test('跨过一格边界只补新的一列，保留半径让旧 chunk 先留着', () => {
  const initial = planChunkStream({ focusX: 0, focusZ: 0, loadedKeys: [] });
  const loaded = new Set(initial.load.map((chunk) => chunk.key));
  const plan = planChunkStream({ focusX: CHUNK_SIZE + 1, focusZ: 0, loadedKeys: loaded });

  assert.equal(plan.load.length, CHUNK_LOAD_RADIUS * 2 + 1);
  // 这一步是滞后的意义所在：加载半径与保留半径相等的话，
  // 在边界上来回走会让同一批 chunk 反复构建又销毁。
  assert.equal(plan.unload.length, 0);
});

test('走远之后旧 chunk 才被卸载', () => {
  const initial = planChunkStream({ focusX: 0, focusZ: 0, loadedKeys: [] });
  const loaded = new Set(initial.load.map((chunk) => chunk.key));
  const plan = planChunkStream({ focusX: CHUNK_SIZE * 6, focusZ: 0, loadedKeys: loaded });
  assert.equal(plan.unload.length, loaded.size);
});

test('世界外的 chunk 不会被加载，已加载的会被清掉', () => {
  const plan = planChunkStream({
    focusX: MINIMUM_CHUNK_COORDINATE * CHUNK_SIZE + 1,
    focusZ: MINIMUM_CHUNK_COORDINATE * CHUNK_SIZE + 1,
    loadedKeys: ['-99:-99'],
  });
  assert.ok(plan.load.length < expectedFullLoad);
  for (const chunk of plan.load) assert.ok(chunk.chunkX >= MINIMUM_CHUNK_COORDINATE);
  assert.deepEqual(plan.unload, ['-99:-99']);
});

test('损坏的 key 直接卸载而不是留着一块无法定位的网格', () => {
  const plan = planChunkStream({ focusX: 0, focusZ: 0, loadedKeys: ['坏掉的 key'] });
  assert.deepEqual(plan.unload, ['坏掉的 key']);
});

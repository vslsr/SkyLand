import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ChunkStreamer } from '../src/world/ChunkStreamer.ts';
import { CHUNK_SIZE } from '../shared/chunkCoordinates.mjs';

const ALWAYS_VISIBLE = { isBoxVisible: () => true };
const NEVER_VISIBLE = { isBoxVisible: () => false };

test('prime 一次把半径内的地块全部建好', () => {
  const streamer = new ChunkStreamer({ radius: 2 });
  streamer.prime(0, 0);

  assert.equal(streamer.loadedCount, 25);
  assert.equal(streamer.pendingCount, 0);
  assert.equal(streamer.root.children.length, 25);
  streamer.clear();
});

test('update 按每帧预算逐步补齐，不会一次性卡住', () => {
  const streamer = new ChunkStreamer({ radius: 1, buildsPerFrame: 1 });

  streamer.update(0, 0);
  assert.equal(streamer.loadedCount, 1, '第一帧只建一个');
  assert.equal(streamer.pendingCount, 8);

  for (let frame = 0; frame < 8; frame += 1) streamer.update(0, 0);
  assert.equal(streamer.loadedCount, 9);
  assert.equal(streamer.pendingCount, 0);
  streamer.clear();
});

test('走远之后旧地块被卸载，总量保持恒定', () => {
  const streamer = new ChunkStreamer({ radius: 1 });
  streamer.prime(0, 0);
  const keys = new Set(streamer.root.children.map((child) => child.name));

  streamer.prime(CHUNK_SIZE * 10, 0);
  assert.equal(streamer.loadedCount, 9, '数量不随行走距离增长');

  const movedKeys = streamer.root.children.map((child) => child.name);
  assert.ok(movedKeys.every((name) => !keys.has(name)), '旧地块应当全部换掉');
  streamer.clear();
});

test('在地块内部移动不会重建任何东西', () => {
  const streamer = new ChunkStreamer({ radius: 1 });
  streamer.prime(0, 0);
  const before = streamer.root.children.slice();

  streamer.update(4, -6);
  streamer.update(-7, 3);

  assert.deepEqual(streamer.root.children, before);
  streamer.clear();
});

test('剔除只切换可见性，不卸载地块', () => {
  const streamer = new ChunkStreamer({ radius: 1 });
  streamer.prime(0, 0);

  streamer.cull(NEVER_VISIBLE);
  assert.ok(streamer.root.children.every((child) => !child.visible));
  assert.equal(streamer.loadedCount, 9);

  streamer.cull(ALWAYS_VISIBLE);
  assert.ok(streamer.root.children.every((child) => child.visible));
  streamer.clear();
});

test('走远再走回来看到的是同一批内容', () => {
  const streamer = new ChunkStreamer({ radius: 1 });
  streamer.prime(0, 0);
  const before = describe(streamer);

  streamer.prime(CHUNK_SIZE * 20, CHUNK_SIZE * 20);
  streamer.prime(0, 0);

  assert.deepEqual(describe(streamer), before);
  streamer.clear();
});

test('clear 之后不留任何地块', () => {
  const streamer = new ChunkStreamer({ radius: 2 });
  streamer.prime(0, 0);
  streamer.clear();

  assert.equal(streamer.loadedCount, 0);
  assert.equal(streamer.root.children.length, 0);
});

/** 用「地块名 + 每个实例化网格的实例数」概括当前加载的内容。 */
function describe(streamer: ChunkStreamer): string[] {
  return streamer.root.children
    .map((chunk) => {
      const counts = (chunk as THREE.Group).children
        .filter((child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh)
        .map((mesh) => mesh.count)
        .join(',');
      return `${chunk.name}=${counts}`;
    })
    .sort();
}

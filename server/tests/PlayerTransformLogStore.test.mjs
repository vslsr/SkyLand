import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PlayerTransformLogStore } from '../debug/PlayerTransformLogStore.mjs';

test('PlayerTransformLogStore 将 client/server 时间线分别写入有界 JSONL 日志', async () => {
  const logsDirectory = await mkdtemp(join(tmpdir(), 'skyland-transform-log-'));
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const store = new PlayerTransformLogStore({
    logsDirectory,
    maximumEventsPerSide: 2,
    now: (() => {
      let value = Date.parse('2026-09-01T03:04:05.000Z');
      return () => value++;
    })(),
  });

  assert.equal(store.begin({
    sessionId,
    roomId: 'room-1',
    sceneId: 'open-meadow',
    playerId: 'player-1',
  }), true);
  assert.equal(store.appendClient(sessionId, [
    { event: 'client.input_packet_sent', clientTime: 1, data: { tick: 1 } },
    { event: 'client.snapshot_received', clientTime: 2, data: { tick: 2 } },
    { event: 'client.dropped', clientTime: 3, data: {} },
  ]), true);
  assert.equal(store.appendServer(sessionId, {
    event: 'server.input_step_applied', serverTime: 4, data: { tick: 1 },
  }), true);

  const files = await store.finish(sessionId);
  assert.ok(files);
  const clientLines = (await readFile(join(logsDirectory, files.clientFile.split('/').at(-1)), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  const serverLines = (await readFile(join(logsDirectory, files.serverFile.split('/').at(-1)), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);

  assert.equal(clientLines[0].side, 'client');
  assert.equal(clientLines[0].droppedEvents, 1);
  assert.deepEqual(clientLines.slice(1).map((entry) => entry.event), [
    'client.input_packet_sent',
    'client.snapshot_received',
  ]);
  assert.equal(serverLines[0].side, 'server');
  assert.equal(serverLines[1].event, 'server.input_step_applied');
  assert.equal(store.has(sessionId), false);
});

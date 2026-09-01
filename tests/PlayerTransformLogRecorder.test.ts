import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PlayerTransformLogRecorder,
  type PlayerTransformLogState,
} from '../src/debug/PlayerTransformLogRecorder.ts';
import type { PlayerTransformLogClientEvent } from '../src/network/messages.ts';

test('PlayerTransformLogRecorder 按服务端状态开启并在停止时冲刷最后一批事件', () => {
  const appended: PlayerTransformLogClientEvent[][] = [];
  const stopped: PlayerTransformLogClientEvent[][] = [];
  const states: Array<{ state: PlayerTransformLogState; message?: string }> = [];
  let starts = 0;
  let now = 1_000;
  const recorder = new PlayerTransformLogRecorder({
    start() { starts += 1; return true; },
    append(_sessionId, events) { appended.push([...events]); return true; },
    stop(_sessionId, events) { stopped.push([...events]); return true; },
  }, {
    batchSize: 2,
    now: () => now++,
    monotonicNow: () => 42,
    onStateChange: (state, message) => states.push({ state, message }),
  });

  assert.equal(recorder.begin({ playerId: 'player-1' }), true);
  assert.equal(starts, 1);
  assert.equal(recorder.state, 'starting');
  recorder.handleStatus({ status: 'started', sessionId: 'session-1' });
  assert.equal(recorder.state, 'recording');

  recorder.record('client.input_packet_sent', { lastTick: 3 });
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].map((event) => event.event), [
    'client.recording_started',
    'client.input_packet_sent',
  ]);

  recorder.record('client.snapshot_received', { snapshotTick: 4 });
  assert.equal(recorder.stop(), true);
  assert.equal(recorder.state, 'stopping');
  assert.deepEqual(appended[1].map((event) => event.event), [
    'client.snapshot_received',
    'client.recording_stopped',
  ]);
  assert.deepEqual(stopped[0], []);

  recorder.handleStatus({
    status: 'saved',
    sessionId: 'session-1',
    clientFile: 'logs/client.log',
    serverFile: 'logs/server.log',
  });
  assert.equal(recorder.state, 'inactive');
  assert.match(states.at(-1)?.message ?? '', /logs\/client\.log/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeLogBuffer } from '../admin/RuntimeLogBuffer.mjs';

test('缓冲固定容量，跑再久也只留最近的日志', () => {
  const buffer = new RuntimeLogBuffer({ capacity: 3 });
  for (let index = 0; index < 6; index += 1) buffer.append('info', `第 ${index} 条`);

  const { entries, total, capacity } = buffer.read();
  assert.equal(capacity, 3);
  assert.equal(total, 3);
  assert.deepEqual(entries.map((entry) => entry.message), ['第 3 条', '第 4 条', '第 5 条']);
});

test('按级别与关键字过滤，未知级别当作「全部」', () => {
  const buffer = new RuntimeLogBuffer();
  buffer.append('info', '房间 room-a 已创建');
  buffer.append('warn', '房间 room-a 空置');
  buffer.append('error', '房间 room-b 进程退出');

  assert.deepEqual(buffer.read({ level: 'error' }).entries.map((entry) => entry.message), ['房间 room-b 进程退出']);
  assert.equal(buffer.read({ query: 'room-a' }).entries.length, 2);
  assert.equal(buffer.read({ level: '什么级别' }).entries.length, 3);
});

test('接管 console 后原样转发，并按级别归档；还原后不再记录', () => {
  const printed = [];
  const fakeConsole = {
    log: (...args) => printed.push(['log', ...args]),
    warn: (...args) => printed.push(['warn', ...args]),
    error: (...args) => printed.push(['error', ...args]),
  };
  const buffer = new RuntimeLogBuffer();
  const restore = buffer.install(fakeConsole);

  fakeConsole.log('房间', { id: 'room-a' });
  fakeConsole.warn('慢帧');
  fakeConsole.error(new Error('炸了'));

  const entries = buffer.read().entries;
  assert.deepEqual(entries.map((entry) => entry.level), ['info', 'warn', 'error']);
  assert.equal(entries[0].message, '房间 {"id":"room-a"}');
  assert.match(entries[2].message, /Error: 炸了/);
  assert.equal(printed.length, 3, '真实 console 仍然收到全部输出');

  restore();
  fakeConsole.log('还原之后');
  assert.equal(buffer.read().entries.length, 3);
});

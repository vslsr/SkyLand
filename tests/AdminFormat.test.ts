import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeRoomLimit,
  formatCountdown,
  formatMegabytes,
  formatTimestamp,
  formatUptime,
  logLevelLabel,
} from '../src/admin/adminFormat';

test('运行时长不足一天只显示时钟，超过一天带上天数', () => {
  assert.equal(formatUptime(0), '00:00:00');
  assert.equal(formatUptime(3725), '01:02:05');
  assert.equal(formatUptime(90_061), '1 天 01:01:01');
  assert.equal(formatUptime(Number.NaN), '00:00:00');
});

test('空房倒计时不会出现负数秒', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(formatCountdown(null), '有人在线');
  assert.equal(formatCountdown('2026-01-01T00:00:45.000Z', now), '45 秒后回收');
  assert.equal(formatCountdown('2026-01-01T00:02:05.000Z', now), '2 分 05 秒后回收');
  assert.equal(formatCountdown('2025-12-31T23:59:00.000Z', now), '回收中');
});

test('0 是「不限制」的哨兵值，不能显示成上限 0 个房间', () => {
  assert.equal(describeRoomLimit(0), '不限制');
  assert.equal(describeRoomLimit(12), '12 个');
});

test('解析不了的时间戳照抄原文，不吞掉异常数据', () => {
  assert.equal(formatTimestamp(null), '—');
  assert.equal(formatTimestamp('不是时间'), '不是时间');
});

test('内存与日志级别的展示', () => {
  assert.equal(formatMegabytes(128.44), '128.4 MB');
  assert.equal(logLevelLabel('error'), '错误');
  assert.equal(logLevelLabel('warn'), '警告');
  assert.equal(logLevelLabel('info'), '信息');
});

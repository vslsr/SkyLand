import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INSTANCE_ARCHETYPE,
  INSTANCE_FLOAT_STRIDE,
  INSTANCE_ID,
  INSTANCE_INT_STRIDE,
  INSTANCE_QUANTITY,
  INSTANCE_RESIDENCY,
  INSTANCE_ROLL_RADIUS,
  INSTANCE_X,
  InstanceIdTable,
  RenderInstanceBuffer,
  residencyCode,
  residencyName,
} from '../src/render/RenderInstanceBuffer';

/**
 * 高数量合批内容的实例通道（实现路径文档 §3 / 路线图 §4.5 的 `PropInstances`）。
 *
 * 这一条通道和 transform SoA 是同一类东西，所以要盯住的也是同一批不变量：
 * 字节布局对得上、扩容不丢数据、编号能收回来复用。
 */

const ints = (
  archetype: number,
  residency = 0,
  id = 0,
): [number, number, number, number, number] => {
  const record: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  record[INSTANCE_ARCHETYPE] = archetype;
  record[INSTANCE_RESIDENCY] = residency;
  record[INSTANCE_ID] = id;
  return record;
};

const floats = (
  x: number,
  quantity = 1,
  radius = 0,
): [number, number, number, number, number, number] => {
  const record: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  record[INSTANCE_X] = x;
  record[INSTANCE_QUANTITY] = quantity;
  record[INSTANCE_ROLL_RADIUS] = radius;
  return record;
};

test('驻留态只有 active 与 sleeping，两侧靠同一份编号对话', () => {
  // dormant 不在这里：那表示 Actor 已经离开 ActorWorld，也就不会有实例记录。
  // 这条断言就是拿来钉住这一点的——多列一个态，合批的对象名就会对不上。
  assert.equal(residencyName(residencyCode('active')), 'active');
  assert.equal(residencyName(residencyCode('sleeping')), 'sleeping');
  assert.notEqual(residencyCode('sleeping'), residencyCode('active'));
  // 缺省与不认识的值都落回 active，而不是越界读出 undefined。
  assert.equal(residencyName(residencyCode(undefined)), 'active');
  assert.equal(residencyName(residencyCode('dormant')), 'active');
  assert.equal(residencyName(99), 'active');
});

test('beginFrame 之后重新铺一遍，读出来的就是这一帧写进去的', () => {
  const buffer = new RenderInstanceBuffer(4);
  buffer.beginFrame();
  buffer.push(ints(2, 1, 7), floats(1.5, 12, 0.14));
  buffer.push(ints(3, 0, 8), floats(-4, 1));
  assert.equal(buffer.count, 2);
  assert.equal(buffer.readInt(0, INSTANCE_ARCHETYPE), 2);
  assert.equal(buffer.readInt(0, INSTANCE_RESIDENCY), 1);
  assert.equal(buffer.readInt(0, INSTANCE_ID), 7);
  assert.equal(buffer.readFloat(0, INSTANCE_X), 1.5);
  assert.equal(buffer.readFloat(0, INSTANCE_QUANTITY), 12);
  assert.ok(Math.abs(buffer.readFloat(0, INSTANCE_ROLL_RADIUS) - 0.14) < 1e-6);
  assert.equal(buffer.readInt(1, INSTANCE_ARCHETYPE), 3);
  assert.equal(buffer.readFloat(1, INSTANCE_X), -4);

  // 每帧重铺：上一帧的第二条不该留下来。
  buffer.beginFrame();
  buffer.push(ints(5, 0, 9), floats(0.25));
  assert.equal(buffer.count, 1);
  assert.equal(buffer.readInt(0, INSTANCE_ARCHETYPE), 5);
});

test('超过容量自动扩容，已经写进去的记录一条不丢', () => {
  const buffer = new RenderInstanceBuffer(2);
  buffer.beginFrame();
  for (let index = 0; index < 9; index += 1) buffer.push(ints(index), floats(index));
  assert.equal(buffer.count, 9);
  assert.ok(buffer.capacity >= 9);
  for (let index = 0; index < 9; index += 1) {
    assert.equal(buffer.readInt(index, INSTANCE_ARCHETYPE), index, `第 ${index} 条丢了`);
    assert.equal(buffer.readFloat(index, INSTANCE_X), index);
  }
});

test('两段字节的步长就是字段个数——布局说错了这条会先炸', () => {
  const buffer = new RenderInstanceBuffer(1);
  buffer.beginFrame();
  buffer.push(ints(1, 1, 1), floats(1, 1, 1));
  buffer.push(ints(2, 0, 2), floats(2, 2, 2));
  // 第二条记录的起点必须落在一整个 stride 之后，混用下标会读到第一条的尾巴。
  assert.equal(INSTANCE_INT_STRIDE, 5);
  assert.equal(INSTANCE_FLOAT_STRIDE, 6);
  assert.equal(buffer.readInt(1, INSTANCE_ARCHETYPE), 2);
  assert.equal(buffer.readFloat(1, INSTANCE_X), 2);
});

test('实例号在 Actor 活着期间稳定——渲染侧的滚动姿态就挂在这上面', () => {
  const table = new InstanceIdTable();
  const first = table.acquire('drop-a');
  assert.equal(table.acquire('drop-a'), first, '同一个 Actor 每帧必须拿到同一个号');
  const second = table.acquire('drop-b');
  assert.notEqual(second, first);
  assert.equal(table.size, 2);
});

test('离开视野的号码收回去复用，不会一路涨上去', () => {
  const table = new InstanceIdTable();
  const a = table.acquire('drop-a');
  const b = table.acquire('drop-b');
  table.retainOnly(new Set(['drop-b']));
  assert.equal(table.size, 1);
  assert.equal(table.acquire('drop-b'), b, '还活着的不该被换号');
  // a 的号回到自由表，下一个 Actor 直接拿走它，而不是分配第三个号。
  assert.equal(table.acquire('drop-c'), a);

  table.clear();
  assert.equal(table.size, 0);
  assert.equal(table.acquire('drop-d'), 0, 'clear 之后从头开始编号');
});

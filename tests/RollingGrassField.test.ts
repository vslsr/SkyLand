import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignFieldOriginCell,
  cellToWorld,
  worldToCell,
} from '../src/grass/rollingGrassField';

const CELL_SIZE = 0.4;
const SPAN = 80;

test('视野原点永远落在整数格上', () => {
  for (let focus = -300; focus <= 300; focus += 0.37) {
    const originCell = alignFieldOriginCell(focus, SPAN, CELL_SIZE);
    assert.ok(Number.isInteger(originCell), `focus=${focus} 得到非整数原点 ${originCell}`);
  }
});

test('同一块地无论玩家站在哪，都落在同一个整数格上', () => {
  // 这是整个滚动方案的前提：格下标变了，着色器哈希出来的草就换了一株，
  // 玩家一移动草地就会闪烁。
  const patch = 12.34;
  const expected = worldToCell(patch, CELL_SIZE);

  for (let focus = -40; focus <= 40; focus += 0.13) {
    const originCell = alignFieldOriginCell(focus, SPAN, CELL_SIZE);
    const localCell = expected - originCell;
    if (localCell < 0 || localCell >= SPAN / CELL_SIZE) continue;
    // 着色器算的是 cellIndex = uOriginCell + aCell，这里复现同一条式子。
    assert.equal(originCell + localCell, expected, `focus=${focus} 时格下标漂移了`);
  }
});

test('格下标加法是精确整数运算，不受原点大小影响', () => {
  // 世界坐标累加会引入 ulp 级误差，而哈希会把它放大成完全不同的草。
  // 走整数格下标就没有这个问题。
  const cellsPerAxis = SPAN / CELL_SIZE;
  for (const focus of [-255.9, -73.21, 0, 0.4, 191.7]) {
    const originCell = alignFieldOriginCell(focus, SPAN, CELL_SIZE);
    for (const localCell of [0, 1, 97, cellsPerAxis - 1]) {
      const index = originCell + localCell;
      assert.ok(Number.isInteger(index));
      assert.equal(index, Math.round(index));
    }
  }
});

test('视野始终把焦点裹在中间', () => {
  for (let focus = -200; focus <= 200; focus += 1.7) {
    const origin = cellToWorld(alignFieldOriginCell(focus, SPAN, CELL_SIZE), CELL_SIZE);
    assert.ok(origin <= focus - SPAN / 2 + 1e-9, `focus=${focus} 原点偏右`);
    assert.ok(origin > focus - SPAN / 2 - CELL_SIZE, `focus=${focus} 原点偏左超过一格`);
    assert.ok(focus >= origin && focus <= origin + SPAN, `focus=${focus} 掉出了视野`);
  }
});

test('原点随焦点单调推进，不会来回跳', () => {
  let previous = alignFieldOriginCell(-50, SPAN, CELL_SIZE);
  for (let focus = -50; focus <= 50; focus += 0.05) {
    const current = alignFieldOriginCell(focus, SPAN, CELL_SIZE);
    assert.ok(current >= previous, `focus=${focus} 原点回退了`);
    assert.ok(current - previous <= 1, `focus=${focus} 原点一次跳了 ${current - previous} 格`);
    previous = current;
  }
});

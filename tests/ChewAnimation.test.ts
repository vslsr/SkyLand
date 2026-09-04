import assert from 'node:assert/strict';
import test from 'node:test';
import { CHEW_BITES, chewBodyOffset, chewFoodScale } from '../src/player/chewAnimation.ts';

/**
 * 吃东西那一段的表现曲线。玩家模型和手上那件食物读的是同一份，所以这里钉住的
 * 是「两边嚼在同一拍上」的那个前提：同一个 ratio 进去，两条曲线的节拍一致。
 */

test('食物一口一口地小下去，咽下去时最小', () => {
  assert.equal(chewFoodScale(0), 1, '刚放进嘴里是原样');
  const samples = Array.from({ length: 21 }, (_, index) => chewFoodScale(index / 20));
  for (let index = 1; index < samples.length; index += 1) {
    // 允许每一口之间的那次「捏扁」让曲线抖一下，但整体必须一路变小。
    assert.ok(samples[index] < samples[index - 1] + 0.05, `第 ${index} 段反而变大了`);
  }
  assert.ok(chewFoodScale(1) < 0.45, `咽下去之前应该只剩一小块：${chewFoodScale(1)}`);
  assert.ok(chewFoodScale(1) > 0, '它是被咽下去的，不是化掉的');
});

test('咬合是一口一口的：每一口中间掉得快，两头几乎不动', () => {
  const perBite = 1 / CHEW_BITES;
  // 一口之内：中段的下降量应当明显大于开头那一小段。
  const early = chewFoodScale(0) - chewFoodScale(perBite * 0.1);
  const middle = chewFoodScale(perBite * 0.35) - chewFoodScale(perBite * 0.65);
  assert.ok(middle > early * 2, `咬合没有节奏：${early.toFixed(4)} vs ${middle.toFixed(4)}`);
});

test('身体的抖动有界，而且和食物读同一个比例', () => {
  for (let index = 0; index <= 40; index += 1) {
    const offset = chewBodyOffset(index / 40);
    assert.ok(Math.abs(offset.x) <= 0.02, `左右晃太大：${offset.x}`);
    assert.ok(offset.y >= 0 && offset.y <= 0.04, `上下抬太多：${offset.y}`);
    assert.ok(Math.abs(offset.z) <= 0.02, `前后晃太大：${offset.z}`);
  }
  // 每一口抬起来一次：一次吃里竖直方向应当出现 CHEW_BITES 个峰。
  let peaks = 0;
  let previous = chewBodyOffset(0).y;
  let rising = true;
  for (let index = 1; index <= 600; index += 1) {
    const current = chewBodyOffset(index / 600).y;
    if (rising && current < previous) {
      peaks += 1;
      rising = false;
    } else if (!rising && current > previous) {
      rising = true;
    }
    previous = current;
  }
  assert.equal(peaks, CHEW_BITES, `一次吃应该嚼 ${CHEW_BITES} 口`);
});

test('比例越界不会让表现发散', () => {
  assert.equal(chewFoodScale(-1), chewFoodScale(0));
  assert.equal(chewFoodScale(2), chewFoodScale(1));
  assert.deepEqual(chewBodyOffset(Number.NaN), chewBodyOffset(0));
});

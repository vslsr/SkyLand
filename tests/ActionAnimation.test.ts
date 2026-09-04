import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sampleActionState,
  sampleLocalAction,
  sampleRemoteAction,
} from '../src/animation/ActionStateSampler.ts';
import {
  registerActionClip,
  resetActionClips,
  sampleActionPose,
} from '../src/animation/ActionClipRegistry.ts';
import { chewBodyOffset, chewFoodScale } from '../src/player/chewAnimation.ts';
import type { SnapshotActionState } from '../src/network/protocol.ts';

/**
 * 动作状态 → 这一帧演到哪一拍 → 摆成什么样。
 *
 * 过网的只有状态，相位是两端各自按同一个公式推出来的——所以这一层测的是那个推导，
 * 以及「找不到曲线就安静地不动」这条兜底。
 */

const eating: SnapshotActionState = {
  state: 'eat.hold',
  itemType: 'fruit',
  startedAt: 10_000,
  duration: 1.2,
  revision: 3,
};

test('相位从权威开始时刻推导：走到一半就是一半', () => {
  const phase = sampleActionState(eating, 10_600);
  assert.equal(phase?.verb, 'eat');
  assert.equal(phase?.phase, 'hold');
  assert.equal(phase?.itemType, 'fruit');
  assert.ok(Math.abs((phase?.ratio ?? 0) - 0.5) < 1e-6, `实际 ${phase?.ratio}`);
  assert.ok(Math.abs((phase?.elapsed ?? 0) - 0.6) < 1e-6);

  // 走过头就停在 1：圈满那一刻服务端已经结算，表现不该继续往前跑。
  assert.equal(sampleActionState(eating, 99_000)?.ratio, 1);
  // 还没收到过快照（算不出服务端时间）时什么都不演，而不是从 0 开始瞎演。
  assert.equal(sampleActionState(eating, undefined), undefined);
  // 没有确定长度的那一段（拉满了等松手）恒为 1。
  assert.equal(sampleActionState({ ...eating, duration: 0 }, 10_600)?.ratio, 1);
  // 词汇表里没有的状态一律不认：宁可不演，也不演一个假的。
  assert.equal(sampleActionState({ ...eating, state: 'eat.dance' }, 10_600), undefined);
});

test('远端玩家的动作要和它的位置同一时刻，本地玩家不减那一项', () => {
  // 远端玩家的位置是按 renderTime = now - 插值延迟 采样的。动作不减这一项的话，
  // 手上那件会在模型还没走到位时就先动起来——看起来像两个人。
  const remote = sampleRemoteAction(eating, 10_600, 120);
  assert.ok(Math.abs((remote?.elapsed ?? 0) - 0.48) < 1e-6, `实际 ${remote?.elapsed}`);

  // 自己的动作不该比自己按下去晚 120 毫秒。
  const local = sampleLocalAction(eating, 10_600);
  assert.ok(Math.abs((local?.elapsed ?? 0) - 0.6) < 1e-6);
});

test('身体和手上那件读同一份曲线，所以嚼在同一拍上', () => {
  const phase = sampleActionState(eating, 10_600);
  const body = sampleActionPose(phase, 'actor');
  const held = sampleActionPose(phase, 'held');
  assert.deepEqual(body?.offset, chewBodyOffset(0.5));
  assert.deepEqual(held?.offset, chewBodyOffset(0.5), '食物跟着嘴走，不然两者会脱开');
  assert.equal(held?.scale, chewFoodScale(0.5));
  assert.equal(body?.scale, undefined, '身体不缩');
});

test('没登记曲线的状态安静地不动；动词那一条是兜底', () => {
  resetActionClips();
  const charging: SnapshotActionState = {
    state: 'shoot.charge', itemType: 'slingshot', startedAt: 0, duration: 1, revision: 1,
  };
  const phase = sampleActionState(charging, 500);
  // 目录里先有一件新物品、曲线后补是常态：那时它该什么都不做，而不是报错。
  assert.equal(sampleActionPose(phase, 'actor'), undefined);

  // 只按动词登记的那一条是兜底：一切 shoot 都能演，专有的那条再各自覆盖。
  registerActionClip('shoot', 'actor', () => ({ scale: 1.5 }));
  assert.equal(sampleActionPose(phase, 'actor')?.scale, 1.5);
  registerActionClip('shoot.charge', 'actor', (found) => ({ scale: 2 + found.ratio }));
  assert.equal(sampleActionPose(phase, 'actor')?.scale, 2.5, '精确匹配优先于动词兜底');

  // 同一条被两处认领是配置事故，不是「后来的覆盖前面的」。
  assert.throws(() => registerActionClip('shoot.charge', 'actor', () => ({})), /已经有人登记/);
  resetActionClips();
});

test('没在做什么时不摆任何姿势', () => {
  assert.equal(sampleActionPose(undefined, 'actor'), undefined);
  assert.equal(sampleActionPose(undefined, 'held'), undefined);
});

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
  rotateActionOffset,
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
  // `throw` 现在没有任何曲线：目录里先有一件新物品、曲线后补是常态。
  const throwing: SnapshotActionState = {
    state: 'throw.hold', itemType: 'stone', startedAt: 0, duration: 1, revision: 1,
  };
  const phase = sampleActionState(throwing, 500);
  assert.equal(sampleActionPose(phase, 'actor'), undefined, '没人登记就该安静地不动');

  // 只按动词登记的那一条是兜底：一切 throw 都能演，专有的那条再各自覆盖。
  registerActionClip('throw', 'actor', () => ({ scale: 1.5 }));
  assert.equal(sampleActionPose(phase, 'actor')?.scale, 1.5);
  registerActionClip('throw.hold', 'actor', (found) => ({ scale: 2 + found.ratio }));
  assert.equal(sampleActionPose(phase, 'actor')?.scale, 2.5, '精确匹配优先于动词兜底');

  // 同一条被两处认领是配置事故，不是「后来的覆盖前面的」。
  assert.throws(() => registerActionClip('throw.hold', 'actor', () => ({})), /已经有人登记/);
  // 内置那几条要还在：这张表是全局的，收尾不收干净会让后面的用例莫名其妙地不动。
  resetActionClips();
  assert.ok(sampleActionPose(sampleActionState(
    { state: 'eat.hold', itemType: 'fruit', startedAt: 0, duration: 1, revision: 1 },
    500,
  ), 'actor'));
});

test('没在做什么时不摆任何姿势', () => {
  assert.equal(sampleActionPose(undefined, 'actor'), undefined);
  assert.equal(sampleActionPose(undefined, 'held'), undefined);
});

test('拉弓往「身后」拉，转过身之后世界方向跟着转', () => {
  const charging: SnapshotActionState = {
    state: 'shoot.charge', itemType: 'slingshot', startedAt: 0, duration: 0.9, revision: 1,
  };
  const full = sampleActionState(charging, 900);
  const held = sampleActionPose(full, 'held');
  assert.ok(held?.offset);
  assert.ok(held.offset.z < -0.1, `弓该被往后拉：${held.offset.z}`);

  // 姿态写在角色坐标系里，读它的三处各自按自己的朝向转一次。朝向 0 时正前方是 +Z，
  // 所以「身后」就是 -Z；转过 90 度之后，同一份姿态指向 -X。
  const forward = rotateActionOffset(held.offset, 0);
  assert.ok(Math.abs(forward!.z - held.offset.z) < 1e-9);
  const turned = rotateActionOffset(held.offset, Math.PI / 2);
  assert.ok(turned!.x < -0.1, `转过身之后该往 -X 拉：${turned!.x}`);
  // 拉满之后手上还有一点抖（`strainShake`），所以侧向不是精确的 0。
  assert.ok(Math.abs(turned!.z) < 0.01, `${turned!.z}`);
  // 写成世界坐标的话，玩家一转身弓就往错误的方向拉了——这一条正是那件事的防线。
});

test('打出去那一下是一记急促的后坐，随即落回原位', () => {
  const firing: SnapshotActionState = {
    state: 'shoot.fire', itemType: 'slingshot', startedAt: 0, duration: 0.28, revision: 2,
  };
  const start = sampleActionPose(sampleActionState(firing, 0), 'held');
  const middle = sampleActionPose(sampleActionState(firing, 140), 'held');
  const end = sampleActionPose(sampleActionState(firing, 280), 'held');
  assert.ok(start!.offset!.z < middle!.offset!.z, '后坐是「一下」，越往后越小');
  assert.ok(Math.abs(end!.offset!.z) < 1e-9, '演完落回原位');
  assert.ok((start!.scale ?? 1) > 1 && Math.abs((end!.scale ?? 1) - 1) < 1e-9);
});

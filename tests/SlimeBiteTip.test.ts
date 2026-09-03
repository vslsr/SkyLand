import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBiters, resolveBiteTips } from '../src/player/slimeBiteTip';
import { createSlimeBiteParams } from '../src/render/RenderSlimeBite';
import { MAX_SOFT_BODY_HOLDERS } from '../shared/softBodyDeformation.mjs';
import type { InterpolatedPlayerState } from '../src/network/protocol';
import type { ActorArchetypeDefinition } from '../src/scenes/data/SceneDefinition';

/** 只用到半径、嘴挂点与抓握深度；其余字段这条链路不看。 */
const ARCHETYPE = {
  schemaVersion: 1,
  id: 'pbf-slime',
  components: {
    render: { model: 'line-art-pbf-slime', radius: 0.95 },
    pickupDrop: { mouthLocalX: 0, mouthLocalY: 0.5, mouthLocalZ: 0.42, mouthLocalYaw: 0 },
    bite: { range: 1.8, gripDepth: 0.35 },
  },
} as unknown as ActorArchetypeDefinition;

function player(id: string, x: number, z: number, yaw = 0): InterpolatedPlayerState {
  return { id, name: id, x, y: 0, z, yaw, speed: 0 } as InterpolatedPlayerState;
}

const tips = createSlimeBiteParams();
/** 第 index 个尖，方便逐个断言。 */
function tipAt(index = 0): { x: number; y: number; z: number } {
  return { x: tips[index * 3], y: tips[index * 3 + 1], z: tips[index * 3 + 2] };
}
function lengthAt(index = 0): number {
  return Math.hypot(tips[index * 3], tips[index * 3 + 1], tips[index * 3 + 2]);
}

test('咬的那个突起向量由位置当场算出来：没人咬着就是零向量', () => {
  const victim = player('victim', 0, 0);
  resolveBiteTips(victim, undefined, ARCHETYPE, tips);
  assert.ok(tips.every((value) => value === 0), '没人咬着就是全零');

  // 快照里只有咬人的一方带 bitingPlayerId，反查出「谁被谁咬着」。
  const biter = { ...player('biter', 0, -1.6), bitingPlayerId: 'victim' };
  const biters = collectBiters([victim, biter]);
  assert.deepEqual(biters.get('victim')?.map((state) => state.id), ['biter']);

  resolveBiteTips(victim, biters.get('victim'), ARCHETYPE, tips);
  assert.ok(tipAt().z < -0.3, `尖要朝着咬人者那一侧（-Z），实际 ${tipAt().z}`);
  assert.ok(Math.abs(tipAt().x) < 1e-6, '正对着咬时不该有侧向分量');
  assert.ok(lengthAt(1) === 0 && lengthAt(2) === 0, '只有一张嘴时其余槽位保持零');
});

test('贴身咬也看得见：嘴埋进外壳里时保底一个抓握深度', () => {
  const victim = player('victim', 0, 0);
  // 两人挨着（角色碰撞半径 0.52，外壳 0.95，所以外壳本来就互相穿插），
  // 嘴在咬人者身前 0.42 m，落在被咬者的外壳里面——纯几何算出来的突起是负的。
  const biter = player('biter', 0, -1.04);
  resolveBiteTips(victim, [biter], ARCHETYPE, tips);
  const length = lengthAt();
  assert.ok(
    Math.abs(length - 0.35) < 1e-6,
    `贴身咬要保底 gripDepth，实际 ${length}`,
  );
  assert.ok(tipAt().z < 0, '方向仍然朝着咬人者');
});

test('拉得越开尖越长：长度就是嘴离外壳多远', () => {
  const victim = player('victim', 0, 0);
  resolveBiteTips(victim, [player('b', 0, -1.6)], ARCHETYPE, tips);
  const near = lengthAt();
  resolveBiteTips(victim, [player('b', 0, -2.2)], ARCHETYPE, tips);
  const far = lengthAt();
  assert.ok(far > near + 0.4, `退开应该把尖拉长：近 ${near}，远 ${far}`);
  // 嘴在身前 0.42，外壳 0.95：2.2 - 0.42 - 0.95 ≈ 0.83。
  assert.ok(Math.abs(far - 0.83) < 0.05, `长度应是嘴离外壳的距离，实际 ${far}`);
});

test('从目标身上越过去，尖跟着转过去，不会指向反方向', () => {
  const victim = player('victim', 0, 0);
  // 咬人者沿 Z 轴一路穿过被咬者：这条路径上「牙在哪一侧」会翻面。按一块固定的皮
  // 做位移时，这里就是尖指反的那一段；向量法里方向本来就是当场算的。
  for (let step = -12; step <= 12; step += 1) {
    const offset = step * 0.2;
    if (Math.abs(offset) < 0.3) continue;
    // 嘴挂在身前 0.42 m，所以要把身体摆到「嘴正好落在 offset」的位置。
    const yaw = offset > 0 ? Math.PI : 0;
    const biter = player('biter', 0, offset - 0.42 * Math.cos(yaw), yaw);
    resolveBiteTips(victim, [biter], ARCHETYPE, tips);
    assert.ok(
      tipAt().z * Math.sign(offset) > 0,
      `咬人者在 z=${offset.toFixed(1)}，尖却指向 ${tipAt().z.toFixed(2)}`,
    );
    assert.ok(lengthAt() >= 0.35 - 1e-6, '任何位置都至少捏起一个抓握深度');
  }
});

test('绕到侧面：尖跟着绕，方向永远指着那张嘴', () => {
  const victim = player('victim', 0, 0);
  for (let step = 0; step < 12; step += 1) {
    const angle = (step / 12) * Math.PI * 2;
    const biterX = Math.sin(angle) * 1.8;
    const biterZ = Math.cos(angle) * 1.8;
    const biter = player('biter', biterX, biterZ, Math.atan2(-biterX, -biterZ));
    resolveBiteTips(victim, [biter], ARCHETYPE, tips);
    const planar = Math.hypot(tipAt().x, tipAt().z);
    const alignment = (tipAt().x * biterX + tipAt().z * biterZ) / (planar * 1.8);
    assert.ok(
      alignment > 0.99,
      `尖必须指着咬人者，实际点积 ${alignment} @ ${Math.round((angle * 180) / Math.PI)}°`,
    );
  }
});

test('每有一张嘴就多一个向量：几个尖各自指着各自那张嘴', () => {
  const victim = player('victim', 0, 0);
  // 三张嘴分别从 -Z、+X、+Z 咬上来（都摆成正对着被咬者）。
  const front = { ...player('front', 0, -1.8, 0), bitingPlayerId: 'victim' };
  const side = { ...player('side', 1.8, 0, -Math.PI / 2), bitingPlayerId: 'victim' };
  const back = { ...player('back', 0, 1.8, Math.PI), bitingPlayerId: 'victim' };
  const biters = collectBiters([victim, front, side, back]);
  const mouths = biters.get('victim');
  assert.equal(mouths?.length, 3, '三张嘴咬同一个人');
  // 槽位按 id 排序，各客户端拿到的顺序一致：back < front < side。
  assert.deepEqual(mouths?.map((state) => state.id), ['back', 'front', 'side']);

  resolveBiteTips(victim, mouths, ARCHETYPE, tips);
  assert.ok(tipAt(0).z > 0.2, `back 在 +Z，第一个尖该朝 +Z，实际 ${tipAt(0).z}`);
  assert.ok(tipAt(1).z < -0.2, `front 在 -Z，第二个尖该朝 -Z，实际 ${tipAt(1).z}`);
  assert.ok(tipAt(2).x > 0.2, `side 在 +X，第三个尖该朝 +X，实际 ${tipAt(2).x}`);
  // 三个尖互不干扰：每个都只指着自己那张嘴。
  assert.ok(Math.abs(tipAt(0).x) < 1e-6 && Math.abs(tipAt(1).x) < 1e-6);
  assert.ok(Math.abs(tipAt(2).z) < 1e-6);
});

test('嘴比槽位还多时只取前几张：参数段是定长的', () => {
  const victim = player('victim', 0, 0);
  const crowd = Array.from({ length: MAX_SOFT_BODY_HOLDERS + 2 }, (unused, index) => ({
    ...player(`biter-${index}`, Math.sin(index) * 1.8, Math.cos(index) * 1.8),
    bitingPlayerId: 'victim',
  }));
  resolveBiteTips(victim, crowd, ARCHETYPE, tips);
  let filled = 0;
  for (let index = 0; index < MAX_SOFT_BODY_HOLDERS; index += 1) {
    if (lengthAt(index) > 0) filled += 1;
  }
  assert.equal(filled, MAX_SOFT_BODY_HOLDERS, '槽位应该正好被填满，且不越界');
  assert.equal(tips.length, MAX_SOFT_BODY_HOLDERS * 3);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBiters, resolveBiteTip } from '../src/player/slimeBiteTip';
import { SLIME_BITE_AT_REST } from '../src/render/RenderSlimeBite';
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

const tip = { ...SLIME_BITE_AT_REST };

test('咬的那个突起向量由位置当场算出来：没人咬着就是零向量', () => {
  const victim = player('victim', 0, 0);
  assert.deepEqual(
    { ...resolveBiteTip(victim, undefined, ARCHETYPE, tip) },
    { x: 0, y: 0, z: 0 },
  );

  // 快照里只有咬人的一方带 bitingPlayerId，反查出「谁被谁咬着」。
  const biter = { ...player('biter', 0, -1.6), bitingPlayerId: 'victim' };
  const biters = collectBiters([victim, biter]);
  assert.equal(biters.get('victim')?.id, 'biter');

  resolveBiteTip(victim, biters.get('victim'), ARCHETYPE, tip);
  assert.ok(tip.z < -0.3, `尖要朝着咬人者那一侧（-Z），实际 ${tip.z}`);
  assert.ok(Math.abs(tip.x) < 1e-6, '正对着咬时不该有侧向分量');
});

test('贴身咬也看得见：嘴埋进外壳里时保底一个抓握深度', () => {
  const victim = player('victim', 0, 0);
  // 两人挨着（角色碰撞半径 0.52，外壳 0.95，所以外壳本来就互相穿插），
  // 嘴在咬人者身前 0.42 m，落在被咬者的外壳里面——纯几何算出来的突起是负的。
  const biter = player('biter', 0, -1.04);
  const length = Math.hypot(
    ...Object.values(resolveBiteTip(victim, biter, ARCHETYPE, tip)) as number[],
  );
  assert.ok(
    Math.abs(length - 0.35) < 1e-6,
    `贴身咬要保底 gripDepth，实际 ${length}`,
  );
  assert.ok(tip.z < 0, '方向仍然朝着咬人者');
});

test('拉得越开尖越长：长度就是嘴离外壳多远', () => {
  const victim = player('victim', 0, 0);
  const near = Math.hypot(
    ...Object.values(resolveBiteTip(victim, player('b', 0, -1.6), ARCHETYPE, tip)) as number[],
  );
  const far = Math.hypot(
    ...Object.values(resolveBiteTip(victim, player('b', 0, -2.2), ARCHETYPE, tip)) as number[],
  );
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
    resolveBiteTip(victim, biter, ARCHETYPE, tip);
    assert.ok(
      tip.z * Math.sign(offset) > 0,
      `咬人者在 z=${offset.toFixed(1)}，尖却指向 ${tip.z.toFixed(2)}`,
    );
    assert.ok(
      Math.hypot(tip.x, tip.y, tip.z) >= 0.35 - 1e-6,
      '任何位置都至少捏起一个抓握深度',
    );
  }
});

test('绕到侧面：尖跟着绕，方向永远指着那张嘴', () => {
  const victim = player('victim', 0, 0);
  for (let step = 0; step < 12; step += 1) {
    const angle = (step / 12) * Math.PI * 2;
    const biterX = Math.sin(angle) * 1.8;
    const biterZ = Math.cos(angle) * 1.8;
    const biter = player('biter', biterX, biterZ, Math.atan2(-biterX, -biterZ));
    resolveBiteTip(victim, biter, ARCHETYPE, tip);
    const planar = Math.hypot(tip.x, tip.z);
    const alignment = (tip.x * biterX + tip.z * biterZ) / (planar * 1.8);
    assert.ok(
      alignment > 0.99,
      `尖必须指着咬人者，实际点积 ${alignment} @ ${Math.round((angle * 180) / Math.PI)}°`,
    );
  }
});

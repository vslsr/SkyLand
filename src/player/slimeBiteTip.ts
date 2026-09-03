import { mouthWorld, resolveGripTip } from '../../shared/softBodyDeformation.mjs';
import type { InterpolatedPlayerState } from '../network/protocol';
import { PARAM_SLIME_BITE_TIP_COUNT } from '../render/RenderVisualParams';
import type { SlimeBiteParams } from '../render/RenderSlimeBite';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';

/**
 * 被咬住的那些突起向量，由**位置**当场算出来，不过网络。
 *
 * 快照里关于「咬」只有离散关系：咬人的那一方带 `bitingPlayerId`。两边的位置与
 * 朝向本来就是权威复制过来的，嘴的挂点、外壳半径、抓握深度都在原型里，所以每个
 * 客户端拿同一份输入算出同一组向量——既不用多下发几组数，算的又是**这一帧插值后**
 * 的位置，尖因此始终贴着嘴，而不是慢一个快照。
 *
 * **一张嘴一个向量**：同时被几个人咬着就有几个尖，求解器把它们的位移加起来。
 * 方向是「被咬者身体中心 → 那张嘴」，所以谁绕过去、谁从被咬者身上越过去，都只是
 * 各自那个向量在转。
 */
export function collectBiters(
  states: readonly InterpolatedPlayerState[],
  out: Map<string, InterpolatedPlayerState[]> = new Map(),
): Map<string, InterpolatedPlayerState[]> {
  out.clear();
  for (const state of states) {
    const victimId = state.bitingPlayerId;
    if (!victimId) continue;
    const mouths = out.get(victimId);
    if (mouths) mouths.push(state);
    else out.set(victimId, [state]);
  }
  // 槽位按咬人者 id 排序，各客户端拿到的顺序因此一致，松口时也不会整组跳位。
  for (const mouths of out.values()) mouths.sort((left, right) => (left.id < right.id ? -1 : 1));
  return out;
}

const MOUTH = { x: 0, y: 0, z: 0 };
const VICTIM = { x: 0, y: 0, z: 0 };
const TIP = { x: 0, y: 0, z: 0 };

/**
 * 把这一帧的那些尖写进 `out`（定长，多余的槽位写 0）。
 *
 * 没人咬着就是全零：「不驱动这项表现的槽位每帧写 0」是参数段的通用规则。
 * 咬的人比槽位还多时只取前几张嘴——参数段是定长的，而三个尖之后画面上也分不出来。
 */
export function resolveBiteTips(
  victim: InterpolatedPlayerState,
  biters: readonly InterpolatedPlayerState[] | undefined,
  archetype: ActorArchetypeDefinition,
  out: SlimeBiteParams,
): SlimeBiteParams {
  out.fill(0);
  const pickupDrop = archetype.components.pickupDrop;
  const bite = archetype.components.bite;
  // 玩家外壳的 render 定义一定带 radius；这里按可选读，非玩家原型自然算不出尖。
  const render = archetype.components.render as { radius?: number } | undefined;
  const radius = render?.radius;
  if (!biters?.length || !pickupDrop || !bite || !radius) return out;

  const used = Math.min(biters.length, PARAM_SLIME_BITE_TIP_COUNT);
  VICTIM.x = victim.x;
  VICTIM.y = victim.y ?? 0;
  VICTIM.z = victim.z;
  for (let index = 0; index < used; index += 1) {
    const biter = biters[index];
    mouthWorld({ x: biter.x, y: biter.y ?? 0, z: biter.z, yaw: biter.yaw }, pickupDrop, MOUTH);
    resolveGripTip(radius, VICTIM, MOUTH, bite.gripDepth ?? 0, TIP);
    out[index * 3] = TIP.x;
    out[index * 3 + 1] = TIP.y;
    out[index * 3 + 2] = TIP.z;
  }
  return out;
}

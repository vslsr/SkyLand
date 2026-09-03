import { mouthWorld, resolveGripTip } from '../../shared/softBodyDeformation.mjs';
import type { InterpolatedPlayerState } from '../network/protocol';
import type { SlimeBiteParams } from '../render/RenderSlimeBite';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';

/**
 * 被咬住的那个突起向量，由**位置**当场算出来，不过网络。
 *
 * 快照里关于「咬」只有一个离散状态：咬人的那一方带 `bitingPlayerId`。两边的位置
 * 与朝向本来就是权威复制过来的，嘴的挂点、外壳半径、抓握深度都在原型里，所以
 * 每个客户端拿同一份输入算出同一个向量——既不用多下发六个数，算的又是**这一帧
 * 插值后的**位置，尖因此始终贴着嘴，而不是慢一个快照。
 *
 * 方向是「被咬者身体中心 → 咬人者的嘴」。施力方绕过去、从被咬者身上越过去，
 * 这个向量自己就转过去了：没有固定的命中点，也就没有「皮还留在原来那一面」。
 */
export function collectBiters(
  states: readonly InterpolatedPlayerState[],
  out: Map<string, InterpolatedPlayerState> = new Map(),
): Map<string, InterpolatedPlayerState> {
  out.clear();
  for (const state of states) {
    if (state.bitingPlayerId) out.set(state.bitingPlayerId, state);
  }
  return out;
}

const MOUTH = { x: 0, y: 0, z: 0 };
const VICTIM = { x: 0, y: 0, z: 0 };

/** 没人咬着就写零向量：「不驱动这项表现的槽位每帧写 0」是参数段的通用规则。 */
export function resolveBiteTip(
  victim: InterpolatedPlayerState,
  biter: InterpolatedPlayerState | undefined,
  archetype: ActorArchetypeDefinition,
  out: SlimeBiteParams,
): SlimeBiteParams {
  const pickupDrop = archetype.components.pickupDrop;
  const bite = archetype.components.bite;
  // 玩家外壳的 render 定义一定带 radius；这里按可选读，非玩家原型自然算不出尖。
  const render = archetype.components.render as { radius?: number } | undefined;
  const radius = render?.radius;
  if (!biter || !pickupDrop || !bite || !radius) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  mouthWorld({ x: biter.x, y: biter.y ?? 0, z: biter.z, yaw: biter.yaw }, pickupDrop, MOUTH);
  VICTIM.x = victim.x;
  VICTIM.y = victim.y ?? 0;
  VICTIM.z = victim.z;
  return resolveGripTip(radius, VICTIM, MOUTH, bite.gripDepth ?? 0, out);
}

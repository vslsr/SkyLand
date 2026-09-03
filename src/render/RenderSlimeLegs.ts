import type { ActorRenderDefinition } from '../scenes/data/SceneDefinition';
import type { ProxyId } from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';
import {
  PARAM_SLIME_GROUND_CENTER_Y,
  PARAM_SLIME_GROUND_EAST_Y,
  PARAM_SLIME_GROUND_NORTH_Y,
  PARAM_SLIME_GROUND_PROBE_RADIUS,
  PARAM_SLIME_GROUND_SOUTH_Y,
  PARAM_SLIME_GROUND_WEST_Y,
} from './RenderVisualParams';

/**
 * 腿部落脚需要的地面采样，玩法侧写、渲染侧读。
 *
 * **为什么不是「每只脚一次采样」**：脚落在哪里是步态解算的结果，而步态活在渲染
 * 世界里。玩法侧若要按脚的位置采样，就得先把脚的位置读回来——那是一次
 * Render→Game 回读，既违反边界，也必然晚一帧。
 *
 * 所以过边界的不是脚，是**身体脚下那一小片地面**：中心加四个轴向探针，
 * 五个高度。渲染侧拿它当一张局部高度窗口，用 `sampleSlimeGroundProbe` 估出任意
 * 近处点的高度。窗口大小固定为一条腿的水平可达范围，因此每个 Actor 每帧的采样
 * 次数是常数，不随世界尺寸变化。
 *
 * 这个文件不 import three——和 `RenderSlimeMotion.ts` 一样，它是玩法侧也能用的
 * 写入口。
 */
export interface SlimeGroundProbeParams {
  /** 身体正下方的地面高度。 */
  centerY: number;
  /** +X 方向探针。 */
  eastY: number;
  /** -X 方向探针。 */
  westY: number;
  /** +Z 方向探针。 */
  southY: number;
  /** -Z 方向探针。 */
  northY: number;
  /**
   * 探针到中心的水平距离。
   *
   * **0 表示这一槽位没有地面采样**，和 AIRBORNE 同一个道理：参数段的通用规则是
   * 「不驱动这项表现的槽位每帧写 0」，所以静止值必须是「没有」而不是某个真实半径。
   * 渲染侧读到 0 就退回自己的兜底平面，不会把 centerY 的 0 当成真实地面。
   */
  radius: number;
}

/** 复用槽位的初值，也是「不驱动这项表现」的槽位每帧写进去的那组值。 */
export const SLIME_GROUND_PROBE_AT_REST: SlimeGroundProbeParams = {
  centerY: 0,
  eastY: 0,
  westY: 0,
  southY: 0,
  northY: 0,
  radius: 0,
};

export function writeSlimeGroundProbeParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  probe: SlimeGroundProbeParams,
): void {
  transforms.writeParam(id, PARAM_SLIME_GROUND_CENTER_Y, probe.centerY);
  transforms.writeParam(id, PARAM_SLIME_GROUND_EAST_Y, probe.eastY);
  transforms.writeParam(id, PARAM_SLIME_GROUND_WEST_Y, probe.westY);
  transforms.writeParam(id, PARAM_SLIME_GROUND_SOUTH_Y, probe.southY);
  transforms.writeParam(id, PARAM_SLIME_GROUND_NORTH_Y, probe.northY);
  transforms.writeParam(id, PARAM_SLIME_GROUND_PROBE_RADIUS, probe.radius);
}

export function readSlimeGroundProbeParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  out: SlimeGroundProbeParams,
): SlimeGroundProbeParams {
  out.centerY = transforms.readParam(id, PARAM_SLIME_GROUND_CENTER_Y);
  out.eastY = transforms.readParam(id, PARAM_SLIME_GROUND_EAST_Y);
  out.westY = transforms.readParam(id, PARAM_SLIME_GROUND_WEST_Y);
  out.southY = transforms.readParam(id, PARAM_SLIME_GROUND_SOUTH_Y);
  out.northY = transforms.readParam(id, PARAM_SLIME_GROUND_NORTH_Y);
  out.radius = transforms.readParam(id, PARAM_SLIME_GROUND_PROBE_RADIUS);
  return out;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * 由五点窗口估出 `(offsetX, offsetZ)` 处的地面高度，偏移量是相对身体中心的
 * **世界轴**距离。
 *
 * 两个轴各取一侧探针做线性外推再叠加，等价于过中心点的一张斜面。这对贴地行走
 * 的腿足够了：它只需要知道脚该落多高、坡往哪边倾，不需要重建地形。
 *
 * 偏移量超出窗口时夹回边界而不是继续外推——这既是数值上的有界性，也是
 * 「窗口之外用定义好的中性状态」这条大世界规则：腿够不到的地方不应该由这里
 * 猜出一个高度来。
 */
export function sampleSlimeGroundProbe(
  probe: SlimeGroundProbeParams,
  offsetX: number,
  offsetZ: number,
): number {
  if (!(probe.radius > 0)) return probe.centerY;
  const normalizedX = clampUnit(offsetX / probe.radius);
  const normalizedZ = clampUnit(offsetZ / probe.radius);
  const alongX = normalizedX >= 0
    ? (probe.eastY - probe.centerY) * normalizedX
    : (probe.westY - probe.centerY) * -normalizedX;
  const alongZ = normalizedZ >= 0
    ? (probe.southY - probe.centerY) * normalizedZ
    : (probe.northY - probe.centerY) * -normalizedZ;
  return probe.centerY + alongX + alongZ;
}

/** 采样窗口的尺寸。玩法侧按它决定采哪五个点、能把脚放到多低。 */
export interface SlimeLegGroundProbeLayout {
  /** 探针到身体中心的水平距离。 */
  readonly radius: number;
  /** 脚相对身体基准面允许的最大高差。 */
  readonly maximumReach: number;
}

type LeggedSlimeRender = Extract<ActorRenderDefinition, { model: 'line-art-legged-slime' }>;

/**
 * 由腿的尺寸推出采样窗口，而不是让作者在原型里再填两个容易和腿长跑偏的数。
 *
 * - 窗口半径就是一只脚能离开身体中心的最远水平距离：站姿的髋距加一步的长度。
 * - 高差上限取「站姿下这条腿还剩多少竖直余量」。用站姿而不是满步幅是有意的：
 *   满步幅 + 陡坡同时出现时 IK 会把脚收回可达距离，那一帧脚略微内移，下一步就
 *   重新对齐；反过来按满步幅取的话，平地上的坡度容忍度会小到几乎没有。
 */
export function resolveSlimeLegGroundProbeLayout(
  render: LeggedSlimeRender,
): SlimeLegGroundProbeLayout {
  const totalLegLength = render.thighLength + render.shinLength;
  const standingReach = Math.sqrt(
    Math.max(0, totalLegLength * totalLegLength - render.legSpread * render.legSpread),
  );
  const slack = standingReach - render.hipHeight;
  return {
    radius: render.legSpread + render.stepLength,
    maximumReach: Math.min(Math.max(0, slack), render.hipHeight * 0.6),
  };
}

/**
 * 服务端玩家高度与客户端验证共用的确定性浮力波形。
 *
 * 两个正弦项的权重和为 1，所以结果严格限制在 ±amplitude；只依赖 Actor id
 * 与绝对服务端时间，不分配状态，也不随世界面积或活动 chunk 数增加成本。
 */

const TAU = Math.PI * 2;

function phaseForActor(actorId) {
  const text = String(actorId ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000 * TAU;
}

export function sampleBuoyancyBobOffset(
  actorId,
  timeSeconds,
  amplitude,
  frequency,
) {
  const safeAmplitude = Math.max(0, Number(amplitude) || 0);
  const safeFrequency = Math.max(0, Number(frequency) || 0);
  if (safeAmplitude === 0 || safeFrequency === 0) return 0;
  const time = Number.isFinite(Number(timeSeconds)) ? Number(timeSeconds) : 0;
  const phase = phaseForActor(actorId);
  const primary = Math.sin(time * safeFrequency * TAU + phase);
  const secondary = Math.sin(time * safeFrequency * 1.73 * TAU + phase * 0.61);
  return safeAmplitude * (primary * 0.78 + secondary * 0.22);
}

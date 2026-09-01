import * as THREE from 'three';

/**
 * water.scene.json 的低多边形水面使用稳定噪声给每个三角面轻微换色。
 * 固定海域和流式水域共用这里，避免两套水面风格逐渐分叉。
 */
export function sampleOceanFaceTint(
  primary: THREE.Color,
  secondary: THREE.Color,
  x: number,
  z: number,
  facePhase: number,
  target: THREE.Color,
): THREE.Color {
  const value = x * 0.37 + z * 0.61 + facePhase * 0.013;
  const raw = Math.sin(value * 91.731 + 17.17) * 43758.5453;
  const noise = raw - Math.floor(raw);
  return target.copy(primary).lerp(secondary, 0.2 + noise * 0.62);
}

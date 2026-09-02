import * as THREE from 'three';

/**
 * 墨线的基准色。
 *
 * 线宽在 WebGL 里改不了，所以墨色是线稿唯一的调节量。这两支材质由整个场景
 * 共用（同一时刻只有一个场景在跑），环境写入方每帧按 `inkTint` 给它们染色：
 * 夜里偏冷、黄昏偏暖，浓度保持不变。
 */
const BASE_OUTLINE_COLOR = new THREE.Color(0x171614);
const BASE_GROUND_GRID_COLOR = new THREE.Color(0x9d9a90);

export const OUTLINE_MATERIAL = new THREE.LineBasicMaterial({
  color: BASE_OUTLINE_COLOR.clone(),
});

export const GROUND_GRID_MATERIAL = new THREE.LineBasicMaterial({
  color: BASE_GROUND_GRID_COLOR.clone(),
  transparent: true,
  opacity: 0.34,
  fog: false,
});

/**
 * 按场景环境给共享墨线染色。
 *
 * `tint` 已经归一化到平均值 1，所以正午（中性白光）下墨色与基准完全一致，
 * 关掉昼夜的场景不会有任何变化。
 */
export function applyEnvironmentInk(tint: THREE.Color): void {
  OUTLINE_MATERIAL.color.copy(BASE_OUTLINE_COLOR).multiply(tint);
  GROUND_GRID_MATERIAL.color.copy(BASE_GROUND_GRID_COLOR).multiply(tint);
}

/** 场景卸载时把共享墨线恢复成基准色，下一张地图不会继承上一张的天色。 */
export function resetEnvironmentInk(): void {
  OUTLINE_MATERIAL.color.copy(BASE_OUTLINE_COLOR);
  GROUND_GRID_MATERIAL.color.copy(BASE_GROUND_GRID_COLOR);
}

import * as THREE from 'three';
import { renderAssets } from '../render/renderAssets';

/**
 * 线稿的两份共享材质，以及它们的基准墨色。
 *
 * 线宽在 WebGL 里改不了，所以墨色是线稿唯一的调节量。这两支材质由整个场景
 * 共用（同一时刻只有一个场景在跑），环境写入方每帧按 `inkTint` 给它们染色：
 * 夜里偏冷、黄昏偏暖，浓度保持不变。
 *
 * 正因为「几乎每一个物体的轮廓线都指向同一个实例」，它们**必须登记进所有权表**：
 * 删掉一个 Actor、换一张地图都不该把它们释放掉。登记之前，`disposeObject` 与
 * `disposeScene` 的遍历式释放会顺手 dispose 掉它们（路线图 §8.2）。
 *
 * 基线引用计数在模块加载时取一次、永不释放：单页应用里它们的生命周期就是
 * 进程的生命周期。场景与 chunk 只要不去 dispose 它们即可，不必再 acquire。
 */
const BASE_OUTLINE_COLOR = new THREE.Color(0x171614);
const BASE_GROUND_GRID_COLOR = new THREE.Color(0x9d9a90);

const OUTLINE_HANDLE = renderAssets.acquire(
  'line-art/outline',
  () => new THREE.LineBasicMaterial({ color: BASE_OUTLINE_COLOR.clone() }),
  (material) => material.dispose(),
);

const GROUND_GRID_HANDLE = renderAssets.acquire(
  'line-art/ground-grid',
  () => new THREE.LineBasicMaterial({
    color: BASE_GROUND_GRID_COLOR.clone(),
    transparent: true,
    opacity: 0.34,
    fog: false,
  }),
  (material) => material.dispose(),
);

export const OUTLINE_MATERIAL = renderAssets.get(OUTLINE_HANDLE);

export const GROUND_GRID_MATERIAL = renderAssets.get(GROUND_GRID_HANDLE);

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

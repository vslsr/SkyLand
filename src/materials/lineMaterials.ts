import * as THREE from 'three';
import { renderAssets } from '../render/renderAssets';

/**
 * 线稿的两份共享材质。
 *
 * 它们被几乎每一个物体的轮廓线指向，所以**必须登记进所有权表**：删掉一个
 * Actor、换一张地图都不该把它们释放掉。登记之前，`disposeObject` 与
 * `disposeScene` 的遍历式释放会顺手 dispose 掉它们（路线图 §8.2）。
 *
 * 基线引用计数在模块加载时取一次、永不释放：单页应用里它们的生命周期就是
 * 进程的生命周期。场景与 chunk 只要不去 dispose 它们即可，不必再 acquire。
 */
const OUTLINE_HANDLE = renderAssets.acquire(
  'line-art/outline',
  () => new THREE.LineBasicMaterial({ color: 0x171614 }),
  (material) => material.dispose(),
);

const GROUND_GRID_HANDLE = renderAssets.acquire(
  'line-art/ground-grid',
  () => new THREE.LineBasicMaterial({
    color: 0x9d9a90,
    transparent: true,
    opacity: 0.34,
    fog: false,
  }),
  (material) => material.dispose(),
);

export const OUTLINE_MATERIAL = renderAssets.get(OUTLINE_HANDLE);

export const GROUND_GRID_MATERIAL = renderAssets.get(GROUND_GRID_HANDLE);

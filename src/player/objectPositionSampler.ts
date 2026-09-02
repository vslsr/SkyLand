import * as THREE from 'three';
import type { WorldPositionSampler } from '../actors/components/GrassDisplacementComponent';

/**
 * 把一个 `THREE.Object3D` 适配成纯数值的世界坐标采样器。
 *
 * 本地玩家与远端玩家的视觉还走 `createPlayerActorVisual()` 那条老路，没有经过
 * `ThreeRenderScene`，所以它们的位置源仍然是一个 Object3D。这个适配器把渲染对象
 * 挡在 Actor Component 之外——**它是过渡形态**：等 src/player/ 也接到渲染边界上
 * （实现路径文档 §1.5 的第 1 条注意），位置直接从 transform SoA 读，这个文件就没了。
 */
export function createObjectPositionSampler(object: THREE.Object3D): WorldPositionSampler {
  // 每个采样器一个暂存向量：getWorldPosition 要真正的 Vector3（它内部走
  // setFromMatrixPosition），而且每帧调用不该产生垃圾。
  const scratch = new THREE.Vector3();
  return (out) => {
    object.getWorldPosition(scratch);
    out.x = scratch.x;
    out.y = scratch.y;
    out.z = scratch.z;
  };
}

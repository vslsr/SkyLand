import type * as THREE from 'three';
import { AssetOwner } from '../core/assets/index';

/**
 * 进程级的 GPU 资源所有权表实例（路线图 §8.2）。
 *
 * §8.4 把它划在渲染这一侧：Sim / Render worker 拆开之后 **GPU 资源只存在于
 * 渲染线程**，模拟侧只能拿到一个整数句柄。所以这个实例住在 `src/render/` 下，
 * 而不是随便哪个 UI 模块里。
 */
export const renderAssets = new AssetOwner();

type Renderable = THREE.Object3D & {
  geometry?: { dispose(): void };
  material?: { dispose(): void } | { dispose(): void }[];
};

/**
 * 释放一个渲染对象独占的 GPU 资源，**跳过所有权表管着的共享资源**。
 *
 * 这是「遍历场景树永远不 dispose」的过渡形态：还没转成 acquire/release 的
 * 遍历式释放路径经由它避让共享材质。全部资源都走句柄之后，这个函数连同
 * 那些遍历一起删掉。
 */
export function releaseOwnResources(object: THREE.Object3D): void {
  const renderable = object as Renderable;
  if (renderable.geometry && !renderAssets.owns(renderable.geometry)) {
    renderable.geometry.dispose();
  }
  const material = renderable.material;
  if (Array.isArray(material)) {
    for (const entry of material) {
      if (!renderAssets.owns(entry)) entry.dispose();
    }
  } else if (material && !renderAssets.owns(material)) {
    material.dispose();
  }
}

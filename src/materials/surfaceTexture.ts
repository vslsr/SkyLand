import * as THREE from 'three';
import type { DrawingSurface } from '../platform/index';

/**
 * 把一块离屏画布包成贴图。
 *
 * 单独抽出来只为收拢一处类型断言：`@types/three@0.128` 的 `CanvasTexture`
 * 只认 `HTMLCanvasElement`，那份声明比 `OffscreenCanvas` 能当贴图源这件事要早。
 * 运行时走的是同一条 `texImage2D`——three 自己做贴图缩放时用的也是 `OffscreenCanvas`。
 */
export function createSurfaceTexture(surface: DrawingSurface): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(surface.canvas as unknown as HTMLCanvasElement);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

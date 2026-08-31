import * as THREE from 'three';
import { createOutlinedObject } from './outlinedObject';

/**
 * 一块低多边形石头，供 chunk 流式生成使用。
 *
 * 二十面体压扁后带一点不对称的缩放，配上轮廓线就是参考项目里那种手绘石块的观感；
 * 朝向由放置算法随机，同一个模板不会看出重复。
 */
export function createRockModel(material: THREE.Material): THREE.Group {
  const geometry = new THREE.IcosahedronGeometry(0.42, 0);
  geometry.scale(1.15, 0.62, 0.94);
  geometry.translate(0, 0.2, 0);
  return createOutlinedObject(geometry, material, 0.6);
}

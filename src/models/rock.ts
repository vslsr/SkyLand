import * as THREE from 'three';
import { createFillMaterial } from '../materials/createFillMaterial';
import { createOutlinedObject } from './outlinedObject';

const ROCK_MATERIAL = createFillMaterial(0xd4d0c6);

/**
 * 一块低多边形石头。
 *
 * 二十面体压扁后带一点不对称的缩放，配上轮廓线就是参考项目里那种
 * 手绘石块的观感；朝向由放置算法随机，同一个模板不会看出重复。
 */
export function createRockModel(): THREE.Group {
  const geometry = new THREE.IcosahedronGeometry(0.42, 0);
  geometry.scale(1.15, 0.62, 0.94);
  geometry.translate(0, 0.2, 0);
  return createOutlinedObject(geometry, ROCK_MATERIAL, 0.6);
}

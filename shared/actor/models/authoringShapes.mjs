/**
 * 多个模型共用的碰撞轮廓。
 *
 * 只收录**确实被不止一个模型用着**的形状。一个模型独有的轮廓写在它自己的
 * 描述符里——搬到这里只会让「这个盒子为什么是这个尺寸」离它的理由更远。
 */

/** 立在地面上的圆柱：水平截面是真圆，从地面包到 height。 */
export function uprightCylinder(radius, height) {
  return {
    shape: 'cylinder',
    halfWidth: radius,
    halfLength: radius,
    minimumY: 0,
    maximumY: height,
  };
}

/**
 * 立在地面上的方盒，水平截面按 radius 取正方形。
 *
 * 堆叠物用它而不是圆柱：一堆木头的外形本来就不是圆的，而方盒的窄相更便宜。
 */
export function uprightRadialBox(radius, height) {
  return {
    halfWidth: radius,
    halfLength: radius,
    minimumY: 0,
    maximumY: height,
  };
}

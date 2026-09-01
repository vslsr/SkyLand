/**
 * 果树上可见果实与权威掉落共用的枝头锚点。
 *
 * 客户端用它画树上的果实，服务端用它决定采摘后每颗果实的出生位置；两边
 * 共用同一份数据，避免画在枝头、却从树根生成的错位。
 */
export const FRUIT_DROP_ANCHORS = Object.freeze([
  Object.freeze({ angle: 0.4, radius: 0.95, height: 1.68 }),
  Object.freeze({ angle: 1.7, radius: 1.05, height: 1.52 }),
  Object.freeze({ angle: 2.9, radius: 0.82, height: 1.95 }),
  Object.freeze({ angle: 4.1, radius: 1.0, height: 1.74 }),
  Object.freeze({ angle: 5.4, radius: 0.78, height: 2.12 }),
]);

/**
 * 从有限锚点中尽量均匀地选择 count 个。当前果树按缩放会产出 2~4 颗，
 * 所以每个物品都能和树上的一颗可见果实一一对应。
 */
export function selectFruitDropAnchors(count) {
  const safeCount = Math.max(0, Math.min(FRUIT_DROP_ANCHORS.length, Math.trunc(Number(count) || 0)));
  if (safeCount === 0) return [];
  return Array.from({ length: safeCount }, (_, index) => (
    FRUIT_DROP_ANCHORS[Math.floor(index * FRUIT_DROP_ANCHORS.length / safeCount)]
  ));
}

/** 把树的局部锚点转换成世界坐标。 */
export function fruitDropWorldPosition(transform, scale, anchor) {
  const safeScale = Math.max(0.01, Number(scale) || 1);
  const angle = anchor.angle + (Number(transform?.yaw) || 0);
  return {
    x: (Number(transform?.x) || 0) + Math.cos(angle) * anchor.radius * safeScale,
    y: (Number(transform?.y) || 0) + anchor.height * safeScale,
    z: (Number(transform?.z) || 0) + Math.sin(angle) * anchor.radius * safeScale,
    angle,
  };
}

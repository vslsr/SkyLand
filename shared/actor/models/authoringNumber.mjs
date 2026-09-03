/**
 * Authoring 数值的两个读法。
 *
 * 模型描述符与 `simpleCollision.mjs` 都要读同一份 render 定义，而那份定义在
 * 服务端已经被 `ActorCatalog` 校验过、在客户端却可能来自一份还没存盘的场景
 * 草稿。两处必须按同一个规则兜底，否则同一个模型会在两端得到两个碰撞盒。
 */

/** @param {unknown} value @param {number} [fallback] */
export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 尺寸只接受正数：0 或负数的半宽会让窄相退化成一条线。 */
export function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

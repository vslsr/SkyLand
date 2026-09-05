/**
 * 一个会走路的单位的体型与能耐。
 *
 * 寻路要问世界的每一个问题都带着它：半径决定「这一格塞不塞得下」，抬腿高决定
 * 「这一级台阶迈不迈得上去」，落差决定「这个坎敢不敢往下跳」，代价表决定
 * 「宁可绕路还是宁可下水」。把这些收成一个对象而不是散成七个参数，是因为它们
 * 从头到尾要一起传给 NodeEvaluator、A* 和平滑三层。
 *
 * 对照 Minecraft：这相当于 `Mob` 身上那几项寻路属性（`getStepHeight`、
 * `getMaxFallDistance`、`getPathfindingMalus`）。这里把它们从「生物身上」挪到
 * 「一个描述体型的值对象」上，因为寻路本身不需要认识 Actor——测试可以直接
 * 造一个 profile 去问一张网格，不必先造出一只史莱姆。
 */

import {
  DEFAULT_NAV_MALUS,
  DEFAULT_NAV_SEARCH_RADIUS_CELLS,
  DEFAULT_NAV_VISITED_NODES,
  MAX_NAV_MALUS,
  MAX_NAV_SEARCH_RADIUS_CELLS,
  MAX_NAV_VISITED_NODES,
  NAV_NODE,
  NAV_NODE_COUNT,
} from './navConfig.mjs';

/** 代价表里可以按名字覆盖的那几项。BLOCKED 不在其中：它的意思就是走不了。 */
const MALUS_KEYS = Object.freeze({
  walkable: NAV_NODE.WALKABLE,
  slope: NAV_NODE.SLOPE,
  deck: NAV_NODE.DECK,
  waterEdge: NAV_NODE.WATER_EDGE,
  water: NAV_NODE.WATER,
  danger: NAV_NODE.DANGER,
});

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * @typedef {object} NavProfile
 * @property {number} radius 圆形足迹半径，米
 * @property {number} height 站立高度，米。用来问「头顶过不过得去」
 * @property {number} stepUp 一步能抬多高，米
 * @property {number} maxDrop 一步敢往下走多深，米
 * @property {Float64Array} malus 按 NAV_NODE 下标的代价加成，-1 表示走不了
 * @property {number} searchRadiusCells 搜索窗口半径，格
 * @property {number} maxVisitedNodes 一次搜索的节点上限
 */

/**
 * @param {object} [definition]
 * @returns {NavProfile}
 */
export function createNavProfile(definition = {}) {
  const malus = Float64Array.from(DEFAULT_NAV_MALUS);
  const overrides = definition.malus;
  if (overrides && typeof overrides === 'object') {
    for (const [key, index] of Object.entries(MALUS_KEYS)) {
      if (overrides[key] === undefined) continue;
      // -1 是「走不了」这个语义本身，所以它是下界而不是一个被夹到 0 的负数。
      malus[index] = clamp(finiteOr(overrides[key], DEFAULT_NAV_MALUS[index]), -1, MAX_NAV_MALUS);
    }
  }
  // `swim` 是一个方便的写法：会游泳就等于把水的代价从「走不了」调成一个正数。
  // 单位可以直接写 malus.water 覆盖它，两条都写时以显式的 malus.water 为准。
  if (definition.swim === true && overrides?.water === undefined) malus[NAV_NODE.WATER] = 4;

  return {
    radius: Math.max(0.05, finiteOr(definition.radius, 0.4)),
    height: Math.max(0.2, finiteOr(definition.height, 1)),
    stepUp: Math.max(0, finiteOr(definition.stepUp, 0.6)),
    maxDrop: Math.max(0, finiteOr(definition.maxDrop, 1.2)),
    malus,
    searchRadiusCells: Math.round(clamp(
      finiteOr(definition.searchRadiusCells, DEFAULT_NAV_SEARCH_RADIUS_CELLS),
      1,
      MAX_NAV_SEARCH_RADIUS_CELLS,
    )),
    maxVisitedNodes: Math.round(clamp(
      finiteOr(definition.maxVisitedNodes, DEFAULT_NAV_VISITED_NODES),
      8,
      MAX_NAV_VISITED_NODES,
    )),
  };
}

/**
 * 两个 profile 会不会得到同一张分类结果。
 *
 * `NavRegion` 的缓存是按 profile 分类出来的（同一格对胖瘦两个单位可以是两个
 * 答案），所以换了单位就得让缓存失效。比较的是**影响分类的那几项**，不是整个
 * 对象：搜索半径和节点上限只影响搜索本身，不影响任何一格是什么。
 */
export function navProfileClassifiesAlike(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.radius !== right.radius) return false;
  if (left.height !== right.height) return false;
  if (left.stepUp !== right.stepUp) return false;
  for (let index = 0; index < NAV_NODE_COUNT; index += 1) {
    // 只有「能不能走」参与分类；代价高低是 A* 的事，不改变一格是什么。
    if ((left.malus[index] >= 0) !== (right.malus[index] >= 0)) return false;
  }
  return true;
}

/**
 * NodeEvaluator：把「世界的某一格」翻译成「寻路眼里的一格」。
 *
 * Minecraft 的 `WalkNodeEvaluator` 做的就是这件事——读一个方块坐标，回答它是
 * BLOCKED 还是 WALKABLE 还是 WATER，顺带给出站立高度。SkyLand 的世界不是方块
 * 堆出来的，一格要读三层：
 *
 * 1. **地形**：台阶地形的高度、形状与表面（`shared/world/terrainContent.mjs`）。
 * 2. **建筑块**：玩家铺的地基把地面抬到自己的顶面，墙立在**格边**上，
 *    物件（篝火）让整格变烫。地基改的是「站多高」，墙改的是「过不过得去」，
 *    这两件事在这一层是分开的两个函数，因为它们回答的是两个问题。
 * 3. **实心碰撞体**：树、石头、别的 Actor。这一层不自己写窄相——它调用玩家移动
 *    用的同一个圆形推出。「这一格站不站得下」的定义因此只有一份：**如果玩家
 *    控制器会把你从这里推出去，寻路就不该把你送进来。**
 *
 * 三层之外还有一条边界：出了活动范围就是 BLOCKED。大世界没有围墙，但每张图有
 * 自己的 `gameplay.bounds`，AI 不该规划一条走出地图的路。
 */

import { sampleTerrain, terrainCellSurface } from '../world/terrainContent.mjs';
import { TERRAIN_SHAPE, TERRAIN_SURFACE } from '../world/terrainConfig.mjs';
import { NAV_NODE, navCellCenter } from './navConfig.mjs';

/** 推出距离超过这个值就算「站不下」。和碰撞层的容差同一个量级。 */
const FIT_EPSILON = 1e-3;
/**
 * 复用的地形采样结果。
 *
 * 一次搜索要分类上千格，每格新建一个采样对象就是上千次分配。`sampleTerrain`
 * 本来就收一个可复用的 target，这里把它提到模块级——`classifyNavCell` 在同一个
 * 同步块里读完就不再引用它，中间不会有第二个调用者插进来。
 */
const TERRAIN_SAMPLE = {};
/** 地基顶面低于地面这么多以内仍然算「铺在这一格上」。 */
const DECK_EPSILON = 1e-3;

/**
 * @typedef {object} NavigationContext
 * @property {number} worldSeed
 * @property {{ minimumX: number, maximumX: number, minimumZ: number, maximumZ: number }} [bounds]
 * @property {number} seaLevel
 * @property {number} groundLevel 没有台阶地形的固定场景里，地面在哪个高度
 * @property {((cellX: number, cellZ: number) => number) | undefined} cellCodeAt
 *   台阶地形的格 code；固定地面场景传 undefined
 * @property {(cellX: number, cellZ: number) => (number | undefined)} foundationTopAt
 *   这一格上地基的顶面高度，没有地基时 undefined
 * @property {(cellX: number, cellZ: number, edge: 'north' | 'east') => boolean} wallOnEdge
 * @property {(cellX: number, cellZ: number) => boolean} isDangerCell
 * @property {(x: number, z: number, radius: number, verticalProfile: object) => { x: number, z: number }} resolveCircle
 * @property {number} revision 世界改动的版本号；变了就说明已有的路径可能过期
 */

function noFoundation() {
  return undefined;
}

function noWall() {
  return false;
}

function noDanger() {
  return false;
}

function noCollision(x, z) {
  return { x, z };
}

/**
 * 补齐缺省项，返回一个字段齐全的上下文。
 *
 * 缺省值一律是「世界上什么都没有」而不是抛错：一张没有地形、没有建造、没有
 * 碰撞的测试场景应该能直接寻路，而不是先补三个空函数。
 * @returns {NavigationContext}
 */
export function createNavigationContext(sources = {}) {
  return {
    worldSeed: Number(sources.worldSeed) || 0,
    bounds: sources.bounds,
    seaLevel: Number.isFinite(sources.seaLevel) ? sources.seaLevel : 0,
    groundLevel: Number.isFinite(sources.groundLevel) ? sources.groundLevel : 0,
    cellCodeAt: typeof sources.cellCodeAt === 'function' ? sources.cellCodeAt : undefined,
    foundationTopAt: sources.foundationTopAt ?? noFoundation,
    wallOnEdge: sources.wallOnEdge ?? noWall,
    isDangerCell: sources.isDangerCell ?? noDanger,
    resolveCircle: sources.resolveCircle ?? noCollision,
    revision: Number(sources.revision) || 0,
  };
}

function withinBounds(bounds, x, z) {
  if (!bounds) return true;
  return x >= bounds.minimumX && x <= bounds.maximumX
    && z >= bounds.minimumZ && z <= bounds.maximumZ;
}

/** 这一格是不是水。没有台阶地形的场景一律不是。 */
function isWaterCell(context, cellX, cellZ) {
  if (!context.cellCodeAt) return false;
  return terrainCellSurface(context.cellCodeAt(cellX, cellZ)) === TERRAIN_SURFACE.WATER;
}

/**
 * 一格的分类结果。
 *
 * `standY` 是**决策高度**，不是最终写进 Transform 的那个 Y：它用来判断台阶迈不
 * 迈得上、坎敢不敢跳。真正落地的高度仍然由移动那一侧按精确的 (x, z) 采样，
 * 和巡逻走的是同一条路（`world.context.groundHeightAt`）。两者混用会让一只
 * 走在斜坡上的生物按格心高度上下跳。
 *
 * @param {NavigationContext} context
 * @param {import('./NavProfile.mjs').NavProfile} profile
 * @param {{ type: number, standY: number }} [out] 复用的输出对象，热路径不分配
 */
export function classifyNavCell(context, profile, cellX, cellZ, out = { type: 0, standY: 0 }) {
  const centerX = navCellCenter(cellX);
  const centerZ = navCellCenter(cellZ);
  out.type = NAV_NODE.BLOCKED;
  out.standY = context.groundLevel;
  if (!withinBounds(context.bounds, centerX, centerZ)) return out;

  let type;
  let standY;
  let water = false;
  if (context.cellCodeAt) {
    const sample = sampleTerrain(
      context.worldSeed,
      centerX,
      centerZ,
      TERRAIN_SAMPLE,
      context.cellCodeAt,
    );
    water = sample.surface === TERRAIN_SURFACE.WATER;
    if (water) {
      // 会游的浮在水面上，所以决策高度是水面而不是河床。不会游的走不了这一格，
      // 那时这个高度也没人用。
      standY = Math.max(sample.groundY, context.seaLevel);
      type = NAV_NODE.WATER;
    } else {
      standY = sample.groundY;
      type = sample.shape === TERRAIN_SHAPE.FLAT ? NAV_NODE.WALKABLE : NAV_NODE.SLOPE;
    }
  } else {
    standY = context.groundLevel;
    type = NAV_NODE.WALKABLE;
  }

  // 地基把地面抬到自己的顶面。铺在水上的码头因此变成可走的一格——那正是
  // 建造系统给出的承诺，寻路照单接受，不再自己判一次「这里本来是水」。
  const deckTop = context.foundationTopAt(cellX, cellZ);
  if (Number.isFinite(deckTop) && deckTop >= standY - DECK_EPSILON) {
    standY = deckTop;
    type = NAV_NODE.DECK;
    water = false;
  } else if (!water && context.cellCodeAt) {
    // 岸边一格：四个正交邻居里有水就算。陆生 AI 据此宁可往内陆绕一格，
    // 免得贴着岸走时被推下去。铺了地基的码头不算——码头本来就是给人走到
    // 水边用的，罚它等于让 AI 拒绝走自己的栈桥。
    //
    // 一格只有一个类型，所以「岸边的斜坡」会被记成岸边而不是斜坡：两者里
    // 岸边是更贵的那一个，而一格取更贵的那一项才不会低估它的风险。
    if (isWaterCell(context, cellX, cellZ + 1)
      || isWaterCell(context, cellX, cellZ - 1)
      || isWaterCell(context, cellX + 1, cellZ)
      || isWaterCell(context, cellX - 1, cellZ)) {
      type = NAV_NODE.WATER_EDGE;
    }
  }

  // 危险物件盖在最后：一堆篝火不会让水变成陆地，但会让一块地基变得不想踩。
  if (type !== NAV_NODE.WATER && context.isDangerCell(cellX, cellZ)) type = NAV_NODE.DANGER;

  // 最后问碰撞：这一格塞不塞得下这个体型。用的是玩家推出的同一份窄相，
  // 所以「寻路觉得能站」和「控制器不会把它推开」是同一件事。
  const resolved = context.resolveCircle(centerX, centerZ, profile.radius, {
    minimumY: standY,
    maximumY: standY + profile.height,
    maximumStepHeight: profile.stepUp,
  });
  if (Math.abs(resolved.x - centerX) > FIT_EPSILON || Math.abs(resolved.z - centerZ) > FIT_EPSILON) {
    out.type = NAV_NODE.BLOCKED;
    out.standY = standY;
    return out;
  }

  out.type = type;
  out.standY = standY;
  return out;
}

/**
 * 两个正交相邻格之间的那条边上有没有墙。
 *
 * 墙占的是**边**不是格（见 `shared/build/buildGrid.mjs`），所以它挡住的是一次
 * 穿越，不是一个落脚点。这也是为什么它必须单独问一次：墙的碰撞体离两边格心
 * 都有一米，格心的圆形推出根本碰不到它——只按格分类的寻路会规划出一条穿墙
 * 而过的路。
 *
 * 一条边只有一个名字：`north` 是格子 +Z 侧，`east` 是 +X 侧，另外两侧是邻格的
 * 同名边。这里的四个分支就是那条命名约定的全部内容。
 */
export function navEdgeBlocked(context, fromCellX, fromCellZ, toCellX, toCellZ) {
  const deltaX = toCellX - fromCellX;
  const deltaZ = toCellZ - fromCellZ;
  if (deltaZ === 1 && deltaX === 0) return context.wallOnEdge(fromCellX, fromCellZ, 'north');
  if (deltaZ === -1 && deltaX === 0) return context.wallOnEdge(fromCellX, fromCellZ - 1, 'north');
  if (deltaX === 1 && deltaZ === 0) return context.wallOnEdge(fromCellX, fromCellZ, 'east');
  if (deltaX === -1 && deltaZ === 0) return context.wallOnEdge(fromCellX - 1, fromCellZ, 'east');
  // 斜向没有自己的边。它由 A* 拆成两条正交边分别判断（见 findNavPath 的拐角规则）。
  return false;
}

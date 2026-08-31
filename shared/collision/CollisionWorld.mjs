/**
 * 玩法碰撞世界：把「有哪些碰撞体」和「怎么查」收在一处。
 *
 * 碰撞体分两类，因为它们的生命周期完全不同：
 *
 * - **静态分组**：一个 chunk 的树和石头。它们由世界种子确定性推导，随 chunk
 *   加载进来、卸载时整组移除，中途不会动。分组的 key 就是 chunk key。
 * - **动态条目**：Actor。每帧位置都在变，按 id 原地更新。
 *
 * 两类都进同一张 CollisionGrid，因为查询不关心一个盒子是谁放进来的。
 *
 * 内存与耗时的上界由调用方保证：静态分组只包含已加载的 chunk（客户端是
 * keepRadius 内的那些，服务端是玩家周围的那些），动态条目不超过场景的
 * Actor 上限。这个类本身不做任何全世界的遍历或预分配。
 */

import { resolveCircleAgainstSimpleCollisions } from '../actor/simpleCollision.mjs';
import { CollisionGrid } from './CollisionGrid.mjs';
import { COLLISION_LAYER, COLLISION_LAYER_SOLID } from './collisionLayers.mjs';
import {
  simpleCollisionWorldBounds,
  sweepSphereAgainstSimpleCollision,
} from './collisionBox.mjs';

/**
 * 推出查询在圆的 AABB 之外多取一圈候选。
 *
 * 推出会把点挪走，挪走之后可能贴上另一个原本不在查询范围里的盒子。一次
 * 推出的位移不会超过一个直径，所以按半径的两倍外扩就够覆盖两轮迭代，
 * 候选集合在整个解算过程中保持不变——和逐个遍历全部碰撞体的结果一致。
 */
const RESOLVE_QUERY_MARGIN_SCALE = 2;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class CollisionWorld {
  /**
   * @param {{ cellSize?: number }} [options]
   */
  constructor(options = {}) {
    this.grid = new CollisionGrid({ cellSize: options.cellSize });
    /** @type {Map<string, string[]>} 静态分组 → 它登记的条目 id。 */
    this.staticGroups = new Map();
    /** @type {Set<string>} */
    this.dynamicIds = new Set();
    /** 推出解算复用的候选数组，避免每次查询产生临时数组。 */
    this.candidates = [];
  }

  get colliderCount() {
    return this.grid.size;
  }

  get staticGroupCount() {
    return this.staticGroups.size;
  }

  get dynamicCount() {
    return this.dynamicIds.size;
  }

  hasStaticGroup(key) {
    return this.staticGroups.has(key);
  }

  /**
   * 整组替换一批静态碰撞体（通常是一个 chunk）。
   * @param {string} key
   * @param {readonly object[]} instances 每项形如 { collision, transform, layers? }
   */
  setStaticGroup(key, instances) {
    this.removeStaticGroup(key);
    if (!instances || instances.length === 0) {
      this.staticGroups.set(key, []);
      return;
    }
    const ids = new Array(instances.length);
    for (let index = 0; index < instances.length; index += 1) {
      const instance = instances[index];
      const id = `s:${key}#${index}`;
      ids[index] = id;
      this.grid.insert(
        id,
        simpleCollisionWorldBounds(instance),
        instance,
        instance.layers ?? COLLISION_LAYER_SOLID,
      );
    }
    this.staticGroups.set(key, ids);
  }

  /** @param {string} key */
  removeStaticGroup(key) {
    const ids = this.staticGroups.get(key);
    if (!ids) return false;
    for (const id of ids) this.grid.remove(id);
    this.staticGroups.delete(key);
    return true;
  }

  clearStatic() {
    for (const key of Array.from(this.staticGroups.keys())) this.removeStaticGroup(key);
  }

  /**
   * 登记或更新一个动态碰撞体。
   * @param {string} id
   * @param {object} instance { collision, transform, layers?, value? }
   */
  setDynamic(id, instance) {
    const key = `d:${id}`;
    this.grid.insert(
      key,
      simpleCollisionWorldBounds(instance),
      instance,
      instance.layers ?? COLLISION_LAYER_SOLID,
    );
    this.dynamicIds.add(id);
  }

  /** @param {string} id */
  removeDynamic(id) {
    if (!this.dynamicIds.delete(id)) return false;
    return this.grid.remove(`d:${id}`);
  }

  clearDynamic() {
    for (const id of Array.from(this.dynamicIds)) this.removeDynamic(id);
  }

  clear() {
    this.grid.clear();
    this.staticGroups.clear();
    this.dynamicIds.clear();
  }

  /**
   * 圆形移动体的水平推出。窄相仍然是既有的 resolveCircleAgainstSimpleCollisions，
   * 只是候选集合由网格给出而不是整份碰撞体列表——推出手感一个字节都没变。
   * @param {{ x: number, z: number }} point
   * @param {number} radius
   * @param {{ accept?: (instance: object) => boolean, layers?: number }} [options]
   * @returns {{ x: number, z: number }}
   */
  resolveCircle(point, radius, options = {}) {
    const safeRadius = Math.max(0, finiteNumber(radius));
    const accept = options.accept;
    const candidates = this.candidates;
    candidates.length = 0;
    this.grid.forEachInCircle(
      finiteNumber(point.x),
      finiteNumber(point.z),
      safeRadius * (1 + RESOLVE_QUERY_MARGIN_SCALE),
      options.layers ?? COLLISION_LAYER.MOVEMENT,
      (instance) => {
        if (accept && !accept(instance)) return;
        candidates.push(instance);
      },
    );
    if (candidates.length === 0) {
      return { x: finiteNumber(point.x), z: finiteNumber(point.z) };
    }
    return resolveCircleAgainstSimpleCollisions(point, safeRadius, candidates);
  }

  /**
   * 从 start 到 end 扫掠一个球，返回最早的命中参数 t ∈ [0, 1]。
   *
   * 宽相用的是整条线段的 AABB。相机悬臂只有十来米，这个盒子最多覆盖几个
   * 格子；换成逐格步进（DDA）能再省一点，但那点收益不值得多一套代码。
   *
   * @param {readonly [number, number, number]} start
   * @param {readonly [number, number, number]} end
   * @param {number} radius
   * @param {{ accept?: (instance: object) => boolean, layers?: number }} [options]
   * @returns {number}
   */
  sweepSphere(start, end, radius, options = {}) {
    const safeRadius = Math.max(0, finiteNumber(radius));
    const accept = options.accept;
    const minimumX = Math.min(start[0], end[0]) - safeRadius;
    const maximumX = Math.max(start[0], end[0]) + safeRadius;
    const minimumZ = Math.min(start[2], end[2]) - safeRadius;
    const maximumZ = Math.max(start[2], end[2]) + safeRadius;
    let earliest = 1;
    this.grid.forEachInAabb(
      minimumX,
      minimumZ,
      maximumX,
      maximumZ,
      options.layers ?? COLLISION_LAYER.CAMERA,
      (instance) => {
        if (earliest <= 0) return;
        if (accept && !accept(instance)) return;
        const hit = sweepSphereAgainstSimpleCollision(start, end, safeRadius, instance);
        if (hit < earliest) earliest = hit;
      },
    );
    return earliest;
  }

  /**
   * 访问某个圆附近的碰撞体。调试绘制与玩法查询用。
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {number} layers
   * @param {(instance: object) => void} visit
   */
  forEachNear(x, z, radius, layers, visit) {
    this.grid.forEachInCircle(x, z, radius, layers, (instance) => visit(instance));
  }
}

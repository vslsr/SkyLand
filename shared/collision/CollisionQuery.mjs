/**
 * 角色控制器使用的统一碰撞查询合成器。
 *
 * 地形高度场与 Actor 网格都实现相同的三个查询：水平扫掠、竖直扫掠和地面
 * 探测。控制器只依赖这份语义，不再知道脚下来自哪一种数据源。
 */

export class CompositeCollisionQuery {
  /** @param {readonly object[]} providers */
  constructor(providers = []) {
    this.providers = providers.filter(Boolean);
  }

  sweepHorizontal(start, end, volume, feetY, options = {}) {
    let earliest;
    for (const provider of this.providers) {
      const hit = provider.sweepHorizontal?.(start, end, volume, feetY, options);
      if (!hit || (earliest && hit.t >= earliest.t)) continue;
      earliest = hit;
    }
    return earliest;
  }

  sweepVertical(point, fromY, toY, volume, options = {}) {
    let earliest;
    for (const provider of this.providers) {
      const hit = provider.sweepVertical?.(point, fromY, toY, volume, options);
      if (!hit || (earliest && hit.t >= earliest.t)) continue;
      earliest = hit;
    }
    return earliest;
  }

  groundAt(point, feetY, volume, options = {}) {
    let highest;
    for (const provider of this.providers) {
      const ground = provider.groundAt?.(point, feetY, volume, options);
      if (!ground || (highest && ground.y <= highest.y)) continue;
      highest = ground;
    }
    return highest;
  }
}

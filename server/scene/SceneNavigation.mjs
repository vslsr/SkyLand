import { HEAT_EMITTER_COMPONENT, NAVIGATION_COMPONENT } from '../../shared/actor/index.mjs';
import { STATIC_SURFACE_KEY } from '../../shared/build/index.mjs';
import { COLLISION_LAYER } from '../../shared/collision/index.mjs';
import { createNavigationContext } from '../../shared/navigation/index.mjs';

/**
 * 把一个房间的世界接到寻路上。
 *
 * `shared/navigation` 那一层只认识四个查询：这一格的地形是什么、这一格上有没有
 * 地基、这条边上有没有墙、这个圆站不站得下。这里负责把它们接到 `ServerScene`
 * 已经有的那几份权威数据上——**不新建任何一份世界数据**。寻路看到的地形就是
 * 玩家走的地形，看到的墙就是玩家刚放下的那一堵，看到的障碍就是把玩家推开的
 * 那一个。多抄一份出来，AI 就会开始穿过玩家看得见的墙。
 *
 * ## 大世界
 *
 * 这个类不持有任何按面积增长的东西。地形是种子的纯函数（按格现算），建造件
 * 是一张有预算上限的占位表，碰撞体只有玩家周围常驻的那些。危险格集合是唯一
 * 的缓存，大小等于建造件数，且只在有人真的动了建造才重建。
 *
 * ## 边界
 *
 * 只服务**静态表面**的世界网格。船上的甲板跟着船漂，格坐标是船体本地的，
 * 在世界网格里没有位置——一只会寻路的生物上不了船，这是这一版的边界，
 * 写在这里而不是散在判断里。
 */
export class SceneNavigation {
  /** @param {import('./ServerScene.mjs').ServerScene} scene */
  constructor(scene) {
    this.scene = scene;
    /** 地形被编辑过几次。和建造件的版本号加在一起构成世界的版本。 */
    this.terrainRevision = 0;
    this.unsubscribeTerrain = scene.terrainPatches?.subscribe(() => {
      this.terrainRevision += 1;
    });
    /** @type {Set<string>} 有危险物件的格；只在建造件变了之后重建。 */
    this.dangerCells = new Set();
    this.dangerRevision = -1;

    this.context = createNavigationContext({
      worldSeed: scene.worldSeed,
      bounds: scene.bounds,
      seaLevel: scene.seaLevel,
      groundLevel: 0,
      cellCodeAt: scene.terrainCellCodeAt,
      foundationTopAt: (cellX, cellZ) => scene.buildFoundationTop(STATIC_SURFACE_KEY, cellX, cellZ),
      wallOnEdge: (cellX, cellZ, edge) => (
        scene.buildSites.at(STATIC_SURFACE_KEY, cellX, cellZ, edge)?.kind === 'wall'
      ),
      isDangerCell: (cellX, cellZ) => this.dangerCells.has(cellKey(cellX, cellZ)),
      resolveCircle: (x, z, radius, verticalProfile) => scene.collision.resolveCircle(
        { x, z },
        radius,
        {
          layers: COLLISION_LAYER.MOVEMENT,
          verticalProfile,
          // 会自己走路的东西不算墙。Minecraft 也是这么做的：生物之间靠互相
          // 挤开，不靠绕开——把彼此当障碍的话，一群生物会把自己围死在原地，
          // 而且每只看到的世界都不一样，分类缓存就再也共用不了。
          accept: (instance) => !instance.actor?.getComponent(NAVIGATION_COMPONENT),
        },
      ),
      revision: 0,
    });
    this.refresh();
  }

  /**
   * 把世界的版本号推到最新，必要时重建危险格集合。
   *
   * 每 tick 调一次。版本号一变，所有手上拿着旧版本路径的生物都会在这一 tick
   * 重寻——「玩家在生物面前放下一堵墙」因此是**当场**生效的，而不是等到下一个
   * 重寻路周期。
   */
  refresh() {
    const buildRevision = this.scene.buildSites.revision;
    this.context.revision = buildRevision + this.terrainRevision;
    if (this.dangerRevision === buildRevision) return this.context;
    this.dangerRevision = buildRevision;
    this.dangerCells.clear();
    // 遍历的是占位表，大小等于房间里的建造件数（有预算上限），不是世界面积。
    for (const record of this.scene.buildSites.sites.values()) {
      if (record.kind !== 'fixture' || record.surfaceKey !== STATIC_SURFACE_KEY) continue;
      const actor = this.scene.actorWorld.getActor(record.actorId);
      // 「危险」这一版就等于「会放热」：篝火是唯一一个玩家能摆在地上的热源。
      // 阵营、毒、陷阱要的都是各自的判据，等它们存在了再加，而不是现在猜一个。
      if (!actor?.getComponent(HEAT_EMITTER_COMPONENT)) continue;
      this.dangerCells.add(cellKey(record.cellX, record.cellZ));
    }
    return this.context;
  }

  dispose() {
    this.unsubscribeTerrain?.();
    this.unsubscribeTerrain = undefined;
    this.dangerCells.clear();
  }
}

function cellKey(cellX, cellZ) {
  return `${cellX},${cellZ}`;
}

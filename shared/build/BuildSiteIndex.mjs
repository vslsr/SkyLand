import { buildSiteKey, cellEdges, siteSlotOf } from './buildGrid.mjs';

/**
 * 「哪一格、哪条边、哪个物件槽上已经有件了」的占位表。
 *
 * 服务端在放置与拆除时维护它；客户端按快照里的建造件重建一份，给幽灵判红绿。
 * 键只有格坐标，不含世界坐标：船上的件跟着船走，格坐标不变，表也不用改。
 *
 * 表的大小等于房间里的建造件数——有上限（见 buildRules 的预算），不随世界面积
 * 增长。
 */
export class BuildSiteIndex {
  constructor() {
    /** @type {Map<string, BuildSiteRecord>} 键 → 记录 */
    this.sites = new Map();
    /** @type {Map<string, string>} actorId → 键 */
    this.keysByActor = new Map();
    /** @type {Map<string, number>} 建造者 → 件数 */
    this.countsByBuilder = new Map();
    /** @type {Map<string, number>} 表面 → 件数 */
    this.countsBySurface = new Map();
    /**
     * 占位表改了几次。
     *
     * 给「按格问建造件」的消费方用：AI 寻路手上那条路是照着某一个版本算的，
     * 版本一变（有人在它面前放下一堵墙）那条穿墙而过的路当场作废，而不是等
     * 下一个重寻路周期。存一个整数比让每个消费方各自订阅增删事件便宜得多，
     * 也不会漏掉一次。
     */
    this.revision = 0;
  }

  get size() {
    return this.sites.size;
  }

  /**
   * @typedef {object} BuildSiteRecord
   * @property {string} actorId
   * @property {string} surfaceKey
   * @property {'foundation'|'wall'|'fixture'} kind
   * @property {number} cellX
   * @property {number} cellZ
   * @property {'north'|'east'} [edge] 墙才有
   * @property {string} [slot] 物件才有
   * @property {string} [builderPlayerId]
   */

  /** @param {BuildSiteRecord} record @returns {boolean} 占位是否成功（位置空着且 actorId 没登记过） */
  add(record) {
    const key = buildSiteKey(record.surfaceKey, record.cellX, record.cellZ, siteSlotOf(record, record.edge));
    if (this.sites.has(key) || this.keysByActor.has(record.actorId)) return false;
    const stored = { ...record };
    this.sites.set(key, stored);
    this.keysByActor.set(record.actorId, key);
    if (record.builderPlayerId) {
      this.countsByBuilder.set(
        record.builderPlayerId,
        (this.countsByBuilder.get(record.builderPlayerId) ?? 0) + 1,
      );
    }
    this.countsBySurface.set(record.surfaceKey, (this.countsBySurface.get(record.surfaceKey) ?? 0) + 1);
    this.revision += 1;
    return true;
  }

  remove(actorId) {
    const key = this.keysByActor.get(actorId);
    if (key === undefined) return undefined;
    const record = this.sites.get(key);
    this.sites.delete(key);
    this.keysByActor.delete(actorId);
    if (record?.builderPlayerId) {
      const count = (this.countsByBuilder.get(record.builderPlayerId) ?? 1) - 1;
      if (count <= 0) this.countsByBuilder.delete(record.builderPlayerId);
      else this.countsByBuilder.set(record.builderPlayerId, count);
    }
    if (record) {
      const count = (this.countsBySurface.get(record.surfaceKey) ?? 1) - 1;
      if (count <= 0) this.countsBySurface.delete(record.surfaceKey);
      else this.countsBySurface.set(record.surfaceKey, count);
    }
    if (record) this.revision += 1;
    return record;
  }

  clear() {
    this.sites.clear();
    this.keysByActor.clear();
    this.countsByBuilder.clear();
    this.countsBySurface.clear();
    this.revision += 1;
  }

  getByActor(actorId) {
    const key = this.keysByActor.get(actorId);
    return key === undefined ? undefined : this.sites.get(key);
  }

  /** 某个槽位上的件：地基传 `cell`（默认），墙传边名，物件传 `fixture:<slot>`。 */
  at(surfaceKey, cellX, cellZ, slot = 'cell') {
    return this.sites.get(buildSiteKey(surfaceKey, cellX, cellZ, slot));
  }

  isOccupied(surfaceKey, cellX, cellZ, slot = 'cell') {
    return this.sites.has(buildSiteKey(surfaceKey, cellX, cellZ, slot));
  }

  /** 这一格上有没有一块地基件（不含船体自带的甲板，那由网格判）。 */
  hasFoundation(surfaceKey, cellX, cellZ) {
    return this.at(surfaceKey, cellX, cellZ)?.kind === 'foundation';
  }

  /** 围着这一格的四条边上的墙。 */
  wallsAround(surfaceKey, cellX, cellZ) {
    const walls = [];
    for (const edge of cellEdges(cellX, cellZ)) {
      const record = this.at(surfaceKey, edge.cellX, edge.cellZ, edge.edge);
      if (record?.kind === 'wall') walls.push(record);
    }
    return walls;
  }

  /** 这一格中心上的全部物件。 */
  fixturesAt(surfaceKey, cellX, cellZ) {
    const fixtures = [];
    for (const record of this.sites.values()) {
      if (record.kind === 'fixture' && record.surfaceKey === surfaceKey
        && record.cellX === cellX && record.cellZ === cellZ) {
        fixtures.push(record);
      }
    }
    return fixtures;
  }

  countByBuilder(playerId) {
    return this.countsByBuilder.get(playerId) ?? 0;
  }

  countBySurface(surfaceKey) {
    return this.countsBySurface.get(surfaceKey) ?? 0;
  }

  /** 某个表面上的全部件；船被拆空时用来一并清账。 */
  listSurface(surfaceKey) {
    const records = [];
    for (const record of this.sites.values()) {
      if (record.surfaceKey === surfaceKey) records.push(record);
    }
    return records;
  }
}

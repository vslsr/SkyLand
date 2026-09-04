import { ActorComponent } from '../ActorComponent.mjs';
import { BUILD_PIECE_KINDS, BUILD_PIECE_SURFACES } from '../../build/buildGrid.mjs';

export const BUILD_PIECE_COMPONENT = 'buildPiece';

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function idOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * 一件建造件：地基、墙或物件（设计稿的 地基 / 墙体 / 物件 三类）。
 *
 * 原型给的是「这是什么、放在哪种表面、要多少材料」；运行态记的是「放在哪一格」。
 * 格坐标是复制状态：客户端靠它重建占位表给幽灵判红绿，不靠世界坐标反推——
 * 船上的件世界坐标每帧都在变，格坐标不变。
 */
export class BuildPieceComponent extends ActorComponent {
  constructor(definition = {}) {
    super(BUILD_PIECE_COMPONENT);
    this.kind = BUILD_PIECE_KINDS.includes(definition.kind) ? definition.kind : 'foundation';
    /** 件能放在哪种表面：`any` 的物件哪边都行。 */
    this.surface = BUILD_PIECE_SURFACES.includes(definition.surface) ? definition.surface : 'static';
    this.label = typeof definition.label === 'string' && definition.label ? definition.label : '建造件';
    this.reach = Math.max(0, finiteOr(definition.reach, 6));
    /** @type {readonly { itemType: string, quantity: number }[]} */
    this.cost = Object.freeze((Array.isArray(definition.cost) ? definition.cost : [])
      .map((entry) => ({ itemType: String(entry.itemType), quantity: Math.max(0, Math.floor(finiteOr(entry.quantity))) })));
    /** 水上件的质量与浮力，进船的浮力结算；静态件用不到。 */
    this.mass = Math.max(0, finiteOr(definition.mass));
    this.buoyancy = Math.max(0, finiteOr(definition.buoyancy));
    /** 地基的厚度，放置时决定它站多高；墙和物件没有这一说。 */
    this.thickness = Math.max(0, finiteOr(definition.thickness));
    /** 物件占格中心的哪个槽：同槽互斥，异槽共存。 */
    this.slot = idOrNull(definition.slot);
    /** 水上地基放在开阔水面上时立起来的船体根节点原型。 */
    this.hull = idOrNull(definition.hull);
    this.cellX = Math.floor(finiteOr(definition.cellX));
    this.cellZ = Math.floor(finiteOr(definition.cellZ));
    this.edge = definition.edge === 'north' || definition.edge === 'east' ? definition.edge : null;
    /** 实际放在了哪种表面：物件声明 `any`，放下去之后就是其中之一。 */
    this.placedSurface = definition.placedSurface === 'floating' ? 'floating' : 'static';
    this.builderPlayerId = idOrNull(definition.builderPlayerId);
    this.revision = 0;
  }

  /** 客户端镜像：格坐标是离散状态，直接采用。 */
  applySnapshot(snapshot) {
    if (!snapshot) return false;
    const revision = Math.max(0, Math.trunc(Number(snapshot.revision) || 0));
    const cellX = Math.floor(finiteOr(snapshot.cellX, this.cellX));
    const cellZ = Math.floor(finiteOr(snapshot.cellZ, this.cellZ));
    const edge = snapshot.edge === 'north' || snapshot.edge === 'east' ? snapshot.edge : null;
    const placedSurface = snapshot.surface === 'floating' ? 'floating' : 'static';
    const changed = revision !== this.revision
      || cellX !== this.cellX
      || cellZ !== this.cellZ
      || edge !== this.edge
      || placedSurface !== this.placedSurface;
    this.cellX = cellX;
    this.cellZ = cellZ;
    this.edge = edge;
    this.placedSurface = placedSurface;
    this.revision = revision;
    return changed;
  }
}

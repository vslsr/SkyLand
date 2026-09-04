import { ActorComponent } from '../ActorComponent.mjs';
import { createHullBuildGrid } from '../../build/buildGrid.mjs';

export const BUILD_GRID_COMPONENT = 'buildGrid';

/**
 * 船体根节点身上的建造网格：自带几格甲板（用地基立起来的船是 0）、格多宽、
 * 甲板面多高、最多往外扩几格。
 *
 * 它只是原型参数的容器，没有运行态——放了哪些板记在占位表和各件的
 * BuildPieceComponent 上。两端从同一份原型构造，网格因此在两端完全一致。
 */
export class BuildGridComponent extends ActorComponent {
  constructor(definition = {}) {
    super(BUILD_GRID_COMPONENT);
    const grid = createHullBuildGrid(definition);
    this.cellSize = grid.cellSize;
    this.columns = grid.columns;
    this.rows = grid.rows;
    this.originX = grid.originX;
    this.originZ = grid.originZ;
    this.deckHeight = grid.deckHeight;
    this.extentCells = grid.extentCells;
    this.maxPieces = grid.maxPieces;
  }

  /** 纯数据形态，给共享的网格函数用。 */
  get grid() {
    return {
      cellSize: this.cellSize,
      columns: this.columns,
      rows: this.rows,
      originX: this.originX,
      originZ: this.originZ,
      deckHeight: this.deckHeight,
      extentCells: this.extentCells,
      maxPieces: this.maxPieces,
    };
  }
}

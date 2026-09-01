import { sampleTerrain } from '../../shared/world/terrainContent.mjs';
import {
  resolveTerrainMovement,
  terrainMovementHeight,
} from '../../shared/world/terrainMovement.mjs';
import { TerrainEditor } from '../../shared/world/terrainEditing.mjs';
import { TerrainPatchStore } from '../../shared/world/terrainPatches.mjs';
import {
  terrainSurfaceHeight,
  terrainWaterDepth,
} from '../../shared/world/terrainWater.mjs';

export interface TerrainRayHit {
  x: number;
  y: number;
  z: number;
  distance: number;
}

interface TerrainSample {
  groundY: number;
  surface: number;
}

const SAMPLE = {} as TerrainSample;

/** 客户端对确定性地形的 O(1) 查询门面；不依赖 chunk 是否已经画出来。 */
export class TerrainWorld {
  public readonly patches: TerrainPatchStore;
  public readonly editor: TerrainEditor;
  private readonly cellCodeAt: (globalCellX: number, globalCellZ: number) => number;

  public constructor(
    public readonly worldSeed: number,
    public readonly seaLevel = 0,
    patches?: TerrainPatchStore,
  ) {
    this.patches = patches ?? new TerrainPatchStore(worldSeed);
    if (this.patches.worldSeed !== (worldSeed >>> 0)) {
      throw new Error('TerrainWorld 与 TerrainPatchStore 必须使用同一 worldSeed');
    }
    this.editor = new TerrainEditor(this.patches, { seaLevel });
    this.cellCodeAt = (globalCellX, globalCellZ) => (
      this.patches.cellCodeAt(globalCellX, globalCellZ)
    );
  }

  public setCellCode(globalCellX: number, globalCellZ: number, code: number): boolean {
    return this.patches.setCellCode(globalCellX, globalCellZ, code);
  }

  public resetCell(globalCellX: number, globalCellZ: number): boolean {
    return this.patches.resetCell(globalCellX, globalCellZ);
  }

  public sampleGroundHeight(x: number, z: number): number {
    return (
      sampleTerrain(this.worldSeed, x, z, SAMPLE, this.cellCodeAt) as TerrainSample
    ).groundY;
  }

  /** 普通低地返回 0；只有已标记为连通水域的格子才按海床计算水深。 */
  public sampleWaterDepth(x: number, z: number): number {
    return terrainWaterDepth(
      sampleTerrain(this.worldSeed, x, z, SAMPLE, this.cellCodeAt) as TerrainSample,
      this.seaLevel,
    );
  }

  /** 浮力水面与河床共同决定角色脚下的实际支撑高度。 */
  public sampleMovementHeight(x: number, z: number, buoyancyDraft?: number): number {
    return terrainMovementHeight(
      sampleTerrain(this.worldSeed, x, z, SAMPLE, this.cellCodeAt) as TerrainSample,
      this.seaLevel,
      buoyancyDraft,
    );
  }

  public resolveMovement(
    from: { x: number; z: number },
    to: { x: number; z: number },
    radius: number,
    maximumStepHeight: number,
    buoyancyDraft?: number,
  ): { x: number; y: number; z: number } {
    return resolveTerrainMovement(this.worldSeed, from, to, {
      radius,
      maximumStepHeight,
      waterLevel: this.seaLevel,
      buoyancyDraft,
      cellCodeAt: this.cellCodeAt,
    });
  }

  /** 鼠标射线与地表/水面的有界步进相交；成本不随世界大小增长。 */
  public raycast(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maximumDistance = 240,
  ): TerrainRayHit | undefined {
    const stepLength = 0.4;
    const steps = Math.min(640, Math.max(1, Math.ceil(maximumDistance / stepLength)));
    let previousDistance = 0;
    let previousAbove = this.heightAboveSurface(origin[0], origin[1], origin[2]);
    for (let step = 1; step <= steps; step += 1) {
      const distance = Math.min(maximumDistance, step * stepLength);
      const x = origin[0] + direction[0] * distance;
      const y = origin[1] + direction[1] * distance;
      const z = origin[2] + direction[2] * distance;
      const above = this.heightAboveSurface(x, y, z);
      if (above <= 0 && previousAbove > 0) {
        let low = previousDistance;
        let high = distance;
        for (let iteration = 0; iteration < 8; iteration += 1) {
          const middle = (low + high) * 0.5;
          const middleAbove = this.heightAboveSurface(
            origin[0] + direction[0] * middle,
            origin[1] + direction[1] * middle,
            origin[2] + direction[2] * middle,
          );
          if (middleAbove > 0) low = middle;
          else high = middle;
        }
        const hitDistance = high;
        const hitX = origin[0] + direction[0] * hitDistance;
        const hitZ = origin[2] + direction[2] * hitDistance;
        return {
          x: hitX,
          y: this.surfaceHeight(hitX, hitZ),
          z: hitZ,
          distance: hitDistance,
        };
      }
      previousDistance = distance;
      previousAbove = above;
    }
    return undefined;
  }

  /** 将规则地形作为相机悬臂的隐式高度场参与遮挡。 */
  public sweepCamera(
    start: readonly [number, number, number],
    end: readonly [number, number, number],
    radius: number,
  ): number {
    const minimumAmount = 0.04;
    const steps = 64;
    for (let step = 1; step <= steps; step += 1) {
      const amount = minimumAmount + (1 - minimumAmount) * (step / steps);
      const x = start[0] + (end[0] - start[0]) * amount;
      const y = start[1] + (end[1] - start[1]) * amount;
      const z = start[2] + (end[2] - start[2]) * amount;
      if (y - radius <= this.surfaceHeight(x, z)) {
        return Math.max(minimumAmount, amount - 1 / steps);
      }
    }
    return 1;
  }

  private surfaceHeight(x: number, z: number): number {
    const terrain = sampleTerrain(
      this.worldSeed,
      x,
      z,
      SAMPLE,
      this.cellCodeAt,
    ) as TerrainSample;
    return terrainSurfaceHeight(terrain, this.seaLevel);
  }

  private heightAboveSurface(x: number, y: number, z: number): number {
    return y - this.surfaceHeight(x, z);
  }
}

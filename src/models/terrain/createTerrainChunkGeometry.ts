import * as THREE from 'three';
import {
  terrainCellBiome,
  terrainCellCodeAt,
  terrainCellCornerHeight,
  terrainCellShape,
  terrainCellSurface,
} from '../../../shared/world/terrainContent.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_CELL_SIZE,
  TERRAIN_GRID,
  TERRAIN_SHAPE,
  TERRAIN_SURFACE,
} from '../../../shared/world/terrainConfig.mjs';
import { terrainCellHasWater } from '../../../shared/world/terrainWater.mjs';
import { terrainTopTriangles } from '../../../shared/world/terrainCollisionMesh.mjs';
import type { OceanVisualDefinition } from '../../scenes/data/SceneDefinition';
import { sampleOceanFaceTint } from '../ocean/oceanFaceting';
import { appendBiomeMarks, createBiomePalette } from './terrainBiomeStyle';
import { STREAMED_WATER_SHORE_WIDTH } from './terrainWaterStyle';

export interface TerrainChunkGeometryOptions {
  worldSeed: number;
  chunkX: number;
  chunkZ: number;
  groundColor: THREE.ColorRepresentation;
  oceanDefinition?: OceanVisualDefinition;
  seaLevel?: number;
  cellCodeAt?: (globalCellX: number, globalCellZ: number) => number;
}

export interface TerrainChunkGeometry {
  groundFill: THREE.BufferGeometry;
  groundGrid: THREE.BufferGeometry;
  waterSurface?: THREE.BufferGeometry;
  waterGrid?: THREE.BufferGeometry;
  waterShore?: THREE.BufferGeometry;
  waterSplash?: THREE.BufferGeometry;
}

interface Corner {
  x: number;
  y: number;
  z: number;
}

const NORMAL_A = new THREE.Vector3();
const NORMAL_B = new THREE.Vector3();
const NORMAL = new THREE.Vector3();
const WATER_VERTEX_TINT = new THREE.Color();

function appendTriangle(
  positions: number[],
  normals: number[],
  tints: number[],
  a: Corner,
  b: Corner,
  c: Corner,
  color: THREE.Color,
): void {
  NORMAL_A.set(b.x - a.x, b.y - a.y, b.z - a.z);
  NORMAL_B.set(c.x - a.x, c.y - a.y, c.z - a.z);
  NORMAL.crossVectors(NORMAL_A, NORMAL_B).normalize();
  // 三角形顶点顺序偶尔会因墙面朝向得到向内法线；双面材质会负责显示，
  // 这里仍统一让水平面的法线朝上，保持台地明暗稳定。
  if (Math.abs(NORMAL.y) > 0.5 && NORMAL.y < 0) NORMAL.multiplyScalar(-1);
  for (const point of [a, b, c]) {
    positions.push(point.x, point.y, point.z);
    normals.push(NORMAL.x, NORMAL.y, NORMAL.z);
    tints.push(color.r, color.g, color.b);
  }
}

function appendQuad(
  positions: number[],
  normals: number[],
  tints: number[],
  a: Corner,
  b: Corner,
  c: Corner,
  d: Corner,
  color: THREE.Color,
): void {
  appendTriangle(positions, normals, tints, a, b, c, color);
  appendTriangle(positions, normals, tints, a, c, d, color);
}

function appendLine(lines: number[], a: Corner, b: Corner, lift = 0): void {
  lines.push(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
}

function makeGroundGeometry(
  positions: number[],
  normals: number[],
  tints: number[],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('tint', new THREE.Float32BufferAttribute(tints, 3));
  return geometry;
}

function makeLineGeometry(lines: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  return geometry;
}

function makeWaterGeometry(positions: number[], colors: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function makeWaterSplashGeometry(
  positions: number[],
  phases: number[],
  scales: number[],
  directions: number[],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  geometry.setAttribute('aScale', new THREE.Float32BufferAttribute(scales, 1));
  geometry.setAttribute('aDirection', new THREE.Float32BufferAttribute(directions, 2));
  return geometry;
}

function appendWaterTriangle(
  positions: number[],
  colors: number[],
  a: Corner,
  b: Corner,
  c: Corner,
  bedA: Corner,
  bedB: Corner,
  bedC: Corner,
  shallowColor: THREE.Color,
  deepColor: THREE.Color,
  seaLevel: number,
  depthColorRange: number,
): void {
  const points = [a, b, c];
  const bedPoints = [bedA, bedB, bedC];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const normalizedDepth = THREE.MathUtils.clamp(
      (seaLevel - bedPoints[index].y) / depthColorRange,
      0,
      1,
    );
    // smoothstep 保留大面积浅水的清亮蓝色，同时让深海床稳定收敛到深蓝。
    const depthTint = normalizedDepth * normalizedDepth * (3 - 2 * normalizedDepth);
    WATER_VERTEX_TINT.copy(shallowColor).lerp(deepColor, depthTint);
    positions.push(point.x, point.y, point.z);
    colors.push(WATER_VERTEX_TINT.r, WATER_VERTEX_TINT.g, WATER_VERTEX_TINT.b);
  }
}

/** 用三角形带模拟粗线，避免 WebGL 忽略 LineBasicMaterial.linewidth。 */
function appendShoreRibbon(
  positions: number[],
  a: Corner,
  b: Corner,
): void {
  const deltaX = b.x - a.x;
  const deltaZ = b.z - a.z;
  const inverseLength = 1 / Math.max(Math.hypot(deltaX, deltaZ), 0.0001);
  const offsetX = -deltaZ * inverseLength * STREAMED_WATER_SHORE_WIDTH * 0.5;
  const offsetZ = deltaX * inverseLength * STREAMED_WATER_SHORE_WIDTH * 0.5;
  const leftA = { x: a.x + offsetX, y: a.y, z: a.z + offsetZ };
  const rightA = { x: a.x - offsetX, y: a.y, z: a.z - offsetZ };
  const leftB = { x: b.x + offsetX, y: b.y, z: b.z + offsetZ };
  const rightB = { x: b.x - offsetX, y: b.y, z: b.z - offsetZ };
  for (const point of [leftA, leftB, rightB, leftA, rightB, rightA]) {
    positions.push(point.x, point.y, point.z);
  }
}

function seededWaterDetail(globalCellX: number, globalCellZ: number, edge: number): number {
  const raw = Math.sin(
    globalCellX * 12.9898 + globalCellZ * 78.233 + edge * 37.719,
  ) * 43758.5453;
  return raw - Math.floor(raw);
}

function appendShoreSplash(
  positions: number[],
  phases: number[],
  scales: number[],
  directions: number[],
  a: Corner,
  b: Corner,
  directionX: number,
  directionZ: number,
  globalCellX: number,
  globalCellZ: number,
  edge: number,
): void {
  const phase = seededWaterDetail(globalCellX, globalCellZ, edge);
  const along = 0.32 + phase * 0.36;
  positions.push(
    a.x + (b.x - a.x) * along + directionX * 0.08,
    (a.y + b.y) * 0.5,
    a.z + (b.z - a.z) * along + directionZ * 0.08,
  );
  phases.push(phase);
  scales.push(0.72 + seededWaterDetail(globalCellX, globalCellZ, edge + 11) * 0.42);
  directions.push(directionX, directionZ);
}

/**
 * 由全局格坐标直接建立一个 chunk 的台地、斜坡、断崖和局部水面。
 * 顶点全部写成世界坐标，chunk 接缝不会因父节点浮点变换产生裂缝。
 */
export function createTerrainChunkGeometry(
  options: TerrainChunkGeometryOptions,
): TerrainChunkGeometry {
  const groundPositions: number[] = [];
  const groundNormals: number[] = [];
  const groundTints: number[] = [];
  const groundLines: number[] = [];
  const waterPositions: number[] = [];
  const waterColors: number[] = [];
  const waterLines: number[] = [];
  const waterShorePositions: number[] = [];
  const waterSplashPositions: number[] = [];
  const waterSplashPhases: number[] = [];
  const waterSplashScales: number[] = [];
  const waterSplashDirections: number[] = [];
  // 每种地皮一套三级色阶：顶面、水下的河床、断崖侧面。水底与侧面比顶面压得更暗，
  // 顶面本身没有明暗变化，起伏全靠这两级色阶读出来。
  const biomePalette = createBiomePalette(options.groundColor);
  const waterPrimary = new THREE.Color(options.oceanDefinition?.surfaceColor ?? 0xc9e6f2);
  const waterSecondary = new THREE.Color(options.oceanDefinition?.secondaryColor ?? 0xb7dbea);
  const waterDeep = new THREE.Color(options.oceanDefinition?.deepColor ?? 0x2f6f96);
  const waterDepthColorRange = Math.max(
    0.001,
    options.oceanDefinition?.depthColorRange ?? 2.5,
  );
  const waterTint = new THREE.Color();
  const originCellX = options.chunkX * TERRAIN_GRID;
  const originCellZ = options.chunkZ * TERRAIN_GRID;
  const seaLevel = Number.isFinite(options.seaLevel) ? Number(options.seaLevel) : 0;
  const sourceCellCodeAt = options.cellCodeAt
    ?? ((globalCellX: number, globalCellZ: number) => (
      terrainCellCodeAt(options.worldSeed, globalCellX, globalCellZ)
    ));

  /**
   * 本 chunk 加一圈边界的格 code 缓存。
   *
   * 建一块 chunk 要问 1412 次格 code，而格子只有 256 个：顶面、东西两侧的断崖、
   * 四邻的水面判定，同一格会被重复问五六次。每次都重算不便宜——一格的 code 要跑
   * 一遍高度噪声、最多九次邻居采样，再加一层群系的 Voronoi。缓存之后掉到 324 次，
   * 实测单块地形几何从 1.22ms 降到 0.62ms。
   *
   * 边界外一格必须在缓存里：断崖和岸线都要读邻块的格子。再远的（几乎没有）落回
   * 原函数，不会读到没填过的槽。
   */
  const cacheSize = TERRAIN_GRID + 2;
  const cachedCodes = new Int32Array(cacheSize * cacheSize);
  const cacheFilled = new Uint8Array(cacheSize * cacheSize);
  const cellCodeAt = (globalCellX: number, globalCellZ: number): number => {
    const localX = globalCellX - originCellX + 1;
    const localZ = globalCellZ - originCellZ + 1;
    if (localX < 0 || localZ < 0 || localX >= cacheSize || localZ >= cacheSize) {
      return sourceCellCodeAt(globalCellX, globalCellZ);
    }
    const index = localZ * cacheSize + localX;
    if (cacheFilled[index] === 0) {
      cachedCodes[index] = sourceCellCodeAt(globalCellX, globalCellZ);
      cacheFilled[index] = 1;
    }
    return cachedCodes[index];
  };

  const cornersAt = (globalCellX: number, globalCellZ: number): [Corner, Corner, Corner, Corner] => {
    const code = cellCodeAt(globalCellX, globalCellZ);
    const x0 = globalCellX * TERRAIN_CELL_SIZE;
    const z0 = globalCellZ * TERRAIN_CELL_SIZE;
    const x1 = x0 + TERRAIN_CELL_SIZE;
    const z1 = z0 + TERRAIN_CELL_SIZE;
    return [
      { x: x0, y: terrainCellCornerHeight(code, 0, 0), z: z0 },
      { x: x1, y: terrainCellCornerHeight(code, 1, 0), z: z0 },
      { x: x1, y: terrainCellCornerHeight(code, 1, 1), z: z1 },
      { x: x0, y: terrainCellCornerHeight(code, 0, 1), z: z1 },
    ];
  };

  for (let localZ = 0; localZ < TERRAIN_GRID; localZ += 1) {
    for (let localX = 0; localX < TERRAIN_GRID; localX += 1) {
      const globalCellX = originCellX + localX;
      const globalCellZ = originCellZ + localZ;
      const code = cellCodeAt(globalCellX, globalCellZ);
      const corners = cornersAt(globalCellX, globalCellZ);
      const [southWest, southEast, northEast, northWest] = corners;
      const shape = terrainCellShape(code);
      const surface = terrainCellSurface(code);
      const biome = terrainCellBiome(code);
      // code 里给群系留了 3 位而只用了 5 种，手写出来的越界值退回草原而不是塌掉。
      const groundColors = biomePalette[biome] ?? biomePalette[TERRAIN_BIOME.GRASSLAND];
      const topTint = surface === TERRAIN_SURFACE.WATER ? groundColors.floor : groundColors.top;

      const topTriangles = terrainTopTriangles(shape, corners) as Corner[];
      appendTriangle(
        groundPositions,
        groundNormals,
        groundTints,
        topTriangles[0], topTriangles[1], topTriangles[2], topTint,
      );
      appendTriangle(
        groundPositions,
        groundNormals,
        groundTints,
        topTriangles[3], topTriangles[4], topTriangles[5], topTint,
      );
      // 南边与西边拥有共享格线；相邻格/相邻 chunk 不会再叠画一遍加深透明度。
      appendLine(groundLines, southWest, southEast, 0.012);
      appendLine(groundLines, northWest, southWest, 0.012);
      if (surface === TERRAIN_SURFACE.GROUND && shape === TERRAIN_SHAPE.FLAT) {
        appendBiomeMarks(
          groundLines,
          biome,
          southWest.x,
          southWest.z,
          southWest.y,
          globalCellX,
          globalCellZ,
        );
      }

      // 每条共享边只由西侧或南侧格负责，跨 chunk 也沿用同一所有权规则。
      const east = cornersAt(globalCellX + 1, globalCellZ);
      if (southEast.y !== east[0].y || northEast.y !== east[3].y) {
        appendQuad(
          groundPositions,
          groundNormals,
          groundTints,
          southEast,
          northEast,
          east[3],
          east[0],
          groundColors.cliff,
        );
        appendLine(groundLines, southEast, east[0], 0.014);
        appendLine(groundLines, northEast, east[3], 0.014);
        appendLine(groundLines, southEast, northEast, 0.012);
      }
      const north = cornersAt(globalCellX, globalCellZ + 1);
      if (northWest.y !== north[0].y || northEast.y !== north[1].y) {
        appendQuad(
          groundPositions,
          groundNormals,
          groundTints,
          northWest,
          north[0],
          north[1],
          northEast,
          groundColors.cliff,
        );
        appendLine(groundLines, northWest, north[0], 0.014);
        appendLine(groundLines, northEast, north[1], 0.014);
        appendLine(groundLines, northEast, northWest, 0.012);
      }

      if (terrainCellHasWater(code, seaLevel)) {
        const waterSouthWest = { x: southWest.x, y: seaLevel, z: southWest.z };
        const waterSouthEast = { x: southEast.x, y: seaLevel, z: southEast.z };
        const waterNorthEast = { x: northEast.x, y: seaLevel, z: northEast.z };
        const waterNorthWest = { x: northWest.x, y: seaLevel, z: northWest.z };
        const facePhase = (globalCellX * 131 + globalCellZ * 197) * 6;
        sampleOceanFaceTint(
          waterPrimary,
          waterSecondary,
          waterSouthWest.x,
          waterSouthWest.z,
          facePhase,
          waterTint,
        );
        appendWaterTriangle(
          waterPositions,
          waterColors,
          waterSouthWest,
          waterNorthEast,
          waterSouthEast,
          southWest,
          northEast,
          southEast,
          waterTint,
          waterDeep,
          seaLevel,
          waterDepthColorRange,
        );
        sampleOceanFaceTint(
          waterPrimary,
          waterSecondary,
          waterSouthWest.x,
          waterSouthWest.z,
          facePhase + 3,
          waterTint,
        );
        appendWaterTriangle(
          waterPositions,
          waterColors,
          waterSouthWest,
          waterNorthWest,
          waterNorthEast,
          southWest,
          northWest,
          northEast,
          waterTint,
          waterDeep,
          seaLevel,
          waterDepthColorRange,
        );
        const southCode = cellCodeAt(globalCellX, globalCellZ - 1);
        const eastCode = cellCodeAt(globalCellX + 1, globalCellZ);
        const northCode = cellCodeAt(globalCellX, globalCellZ + 1);
        const westCode = cellCodeAt(globalCellX - 1, globalCellZ);
        appendLine(waterLines, waterSouthWest, waterSouthEast);
        appendLine(waterLines, waterNorthWest, waterSouthWest);
        // 与 water.scene 的 WireframeGeometry 一致，保留每格的三角面对角线。
        appendLine(waterLines, waterSouthWest, waterNorthEast);
        // 岸线没有相邻水格替它画东/北边，必须在当前格补上。
        if (!terrainCellHasWater(eastCode, seaLevel)) {
          appendLine(waterLines, waterSouthEast, waterNorthEast);
          appendShoreRibbon(waterShorePositions, waterSouthEast, waterNorthEast);
          appendShoreSplash(
            waterSplashPositions,
            waterSplashPhases,
            waterSplashScales,
            waterSplashDirections,
            waterSouthEast,
            waterNorthEast,
            -1,
            0,
            globalCellX,
            globalCellZ,
            1,
          );
        }
        if (!terrainCellHasWater(northCode, seaLevel)) {
          appendLine(waterLines, waterNorthEast, waterNorthWest);
          appendShoreRibbon(waterShorePositions, waterNorthEast, waterNorthWest);
          appendShoreSplash(
            waterSplashPositions,
            waterSplashPhases,
            waterSplashScales,
            waterSplashDirections,
            waterNorthEast,
            waterNorthWest,
            0,
            -1,
            globalCellX,
            globalCellZ,
            2,
          );
        }
        if (!terrainCellHasWater(southCode, seaLevel)) {
          appendShoreRibbon(waterShorePositions, waterSouthWest, waterSouthEast);
          appendShoreSplash(
            waterSplashPositions,
            waterSplashPhases,
            waterSplashScales,
            waterSplashDirections,
            waterSouthWest,
            waterSouthEast,
            0,
            1,
            globalCellX,
            globalCellZ,
            3,
          );
        }
        if (!terrainCellHasWater(westCode, seaLevel)) {
          appendShoreRibbon(waterShorePositions, waterNorthWest, waterSouthWest);
          appendShoreSplash(
            waterSplashPositions,
            waterSplashPhases,
            waterSplashScales,
            waterSplashDirections,
            waterNorthWest,
            waterSouthWest,
            1,
            0,
            globalCellX,
            globalCellZ,
            4,
          );
        }
      }
    }
  }

  return {
    groundFill: makeGroundGeometry(groundPositions, groundNormals, groundTints),
    groundGrid: makeLineGeometry(groundLines),
    ...(waterPositions.length > 0
      ? {
          waterSurface: makeWaterGeometry(waterPositions, waterColors),
          waterGrid: makeLineGeometry(waterLines),
          ...(waterShorePositions.length > 0
            ? { waterShore: makeLineGeometry(waterShorePositions) }
            : {}),
          ...(waterSplashPositions.length > 0
            ? {
                waterSplash: makeWaterSplashGeometry(
                  waterSplashPositions,
                  waterSplashPhases,
                  waterSplashScales,
                  waterSplashDirections,
                ),
              }
            : {}),
        }
      : {}),
  };
}

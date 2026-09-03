import * as THREE from 'three';
import { hash32 } from '../../../shared/world/hash.mjs';
import {
  TERRAIN_BIOME,
  TERRAIN_BIOME_COUNT,
  TERRAIN_CELL_SIZE,
} from '../../../shared/world/terrainConfig.mjs';

/**
 * 群系的纸面表现。
 *
 * 两件事：地皮的颜色，和铺在地皮上的那点线稿纹理。都只在渲染侧，
 * 生成算法不读这里——换一套配色不会改变任何一格的群系归属。
 */

interface BiomeTone {
  /** 混向的目标色。 */
  readonly target: number;
  /** 混入比例。整体保持在场景 palette.ground 的纸调上，不做成五种独立配色。 */
  readonly weight: number;
}

/**
 * 五种地皮相对场景底色的偏移。
 *
 * 刻意不写成五个绝对色：底色仍由场景的 `palette.ground` 决定，群系只是在它上面
 * 偏一点色相。这样换一张地图的纸调，五种地皮会一起跟着走，世界看上去还是同一个
 * 世界，而不是拼贴出来的五块。
 */
const BIOME_TONE: readonly BiomeTone[] = (() => {
  const tones: BiomeTone[] = new Array(TERRAIN_BIOME_COUNT);
  tones[TERRAIN_BIOME.GRASSLAND] = { target: 0x9dbd72, weight: 0.42 };
  tones[TERRAIN_BIOME.SAND] = { target: 0xe8c179, weight: 0.55 };
  tones[TERRAIN_BIOME.MUD] = { target: 0x9c8a68, weight: 0.46 };
  tones[TERRAIN_BIOME.SNOW] = { target: 0xf2f7fb, weight: 0.78 };
  tones[TERRAIN_BIOME.ROCK] = { target: 0x9c9a94, weight: 0.55 };
  return tones;
})();

/** 台地的三层色阶。顶面本身没有明暗变化，起伏全靠水底与断崖这两级读出来。 */
const FLOOR_SHADE = 0.84;
const CLIFF_SHADE = 0.70;

export interface BiomeSurfaceColors {
  /** 露出水面的顶面。 */
  readonly top: THREE.Color;
  /** 水下的河床顶面。 */
  readonly floor: THREE.Color;
  /** 断崖侧壁。 */
  readonly cliff: THREE.Color;
}

/**
 * 由场景底色派生每种群系的三层色阶。一个 chunk 建一次，共 15 个 Color。
 */
export function createBiomePalette(
  groundColor: THREE.ColorRepresentation,
): readonly BiomeSurfaceColors[] {
  const base = new THREE.Color(groundColor);
  return BIOME_TONE.map((tone) => {
    const top = base.clone().lerp(new THREE.Color(tone.target), tone.weight);
    return {
      top,
      floor: top.clone().multiplyScalar(FLOOR_SHADE),
      cliff: top.clone().multiplyScalar(CLIFF_SHADE),
    };
  });
}

interface BiomeMarkStyle {
  /** 出现概率的哈希门限（0-255）。留白比铺满重要，所以没有一种是每格都画。 */
  readonly chance: number;
  /** 命中时画几个。 */
  readonly count: number;
  /** 标记半径（米）。加上下面的落点范围，标记不会越出本格。 */
  readonly radius: number;
  /** 单个标记的线段，坐标是半径的倍数，画在 XZ 平面上。 */
  readonly strokes: readonly (readonly [number, number, number, number])[];
}

/**
 * 每种地皮的一小撮线稿纹理。
 *
 * 它们写进地面网格线那一份几何体，所以不额外占 draw call，也跟着网格线一起
 * 随昼夜换墨色。俯视角下形状要能一眼读出来：草是一撮、沙是几道纹、泥是一摊、
 * 雪是一粒结晶、石头是一条裂缝。
 */
const BIOME_MARK: readonly (BiomeMarkStyle | undefined)[] = (() => {
  const marks: (BiomeMarkStyle | undefined)[] = new Array(TERRAIN_BIOME_COUNT);
  marks[TERRAIN_BIOME.GRASSLAND] = {
    chance: 110,
    count: 1,
    radius: 0.26,
    strokes: [
      [0, 0.7, -0.6, -0.4],
      [0, 0.7, 0, -0.8],
      [0, 0.7, 0.6, -0.4],
    ],
  };
  marks[TERRAIN_BIOME.SAND] = {
    chance: 150,
    count: 1,
    radius: 0.32,
    strokes: [
      [-0.8, -0.35, 0.2, -0.35],
      [-0.2, 0.35, 0.8, 0.35],
    ],
  };
  marks[TERRAIN_BIOME.MUD] = {
    chance: 150,
    count: 1,
    radius: 0.32,
    strokes: [
      [0, -0.8, 0.8, 0],
      [0.8, 0, 0, 0.8],
      [0, 0.8, -0.8, 0],
      [-0.8, 0, 0, -0.8],
    ],
  };
  marks[TERRAIN_BIOME.SNOW] = {
    chance: 95,
    count: 1,
    radius: 0.22,
    strokes: [
      [-0.85, 0, 0.85, 0],
      [-0.42, -0.74, 0.42, 0.74],
      [-0.42, 0.74, 0.42, -0.74],
    ],
  };
  marks[TERRAIN_BIOME.ROCK] = {
    chance: 140,
    count: 1,
    radius: 0.34,
    strokes: [
      [-0.95, 0.2, 0.15, -0.2],
      [0.15, -0.2, 0.95, 0.3],
      [0.15, -0.2, 0.35, -0.85],
    ],
  };
  return marks;
})();

/** 标记落点相对格子的可用范围，两侧各留出一截，标记不会压到格线上。 */
const MARK_PLACEMENT_MINIMUM = 0.2;
const MARK_PLACEMENT_SPAN = 0.6;

/** 抬离地面的高度。比格线的 0.012 略高一点，两者叠在一起时纹理在上面。 */
export const BIOME_MARK_LIFT = 0.016;

const MARK_SALT = 0x5b3f_27c1;

/**
 * 把一格的地皮纹理追加进地面网格线。
 *
 * 只画平坦陆地：斜坡与转角的顶面是两个不共面的三角形，按角点插值出来的落点会
 * 穿进地里或浮在空中，而那些格子本身已经够花了。
 *
 * @param lines 网格线缓冲，追加成对的端点
 * @param biome 该格地皮
 * @param originX 格子西南角的世界 X
 * @param originZ 格子西南角的世界 Z
 * @param groundY 该格顶面高度（平坦格四角同高）
 */
export function appendBiomeMarks(
  lines: number[],
  biome: number,
  originX: number,
  originZ: number,
  groundY: number,
  globalCellX: number,
  globalCellZ: number,
): void {
  const style = BIOME_MARK[biome];
  if (!style) return;
  const y = groundY + BIOME_MARK_LIFT;
  for (let index = 0; index < style.count; index += 1) {
    // 逐格取一次哈希：同一格无论重建多少次都得到同一撮纹理，chunk 反复加载
    // 卸载时地面不会闪。
    const roll = hash32(MARK_SALT, globalCellX, globalCellZ, index);
    if ((roll & 0xff) >= style.chance) continue;
    const centerX = originX + TERRAIN_CELL_SIZE * (
      MARK_PLACEMENT_MINIMUM + ((roll >>> 8) & 0xff) / 255 * MARK_PLACEMENT_SPAN
    );
    const centerZ = originZ + TERRAIN_CELL_SIZE * (
      MARK_PLACEMENT_MINIMUM + ((roll >>> 16) & 0xff) / 255 * MARK_PLACEMENT_SPAN
    );
    const angle = ((roll >>> 24) & 0xff) / 255 * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (const [startX, startZ, endX, endZ] of style.strokes) {
      lines.push(
        centerX + (startX * cosine - startZ * sine) * style.radius,
        y,
        centerZ + (startX * sine + startZ * cosine) * style.radius,
        centerX + (endX * cosine - endZ * sine) * style.radius,
        y,
        centerZ + (endX * sine + endZ * cosine) * style.radius,
      );
    }
  }
}

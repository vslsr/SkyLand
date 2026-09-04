import { terrainCellCornerHeight } from './terrainContent.mjs';

/**
 * 一格地形的最高角点。
 *
 * 地基要盖住整格，就得放在四个角里最高的那一个上——放在格心高度的话，
 * 斜坡格上地基会有一半陷进坡里。两端从同一个格 code 算，得到同一个高度。
 */
export function terrainCellTopHeight(code) {
  return Math.max(
    terrainCellCornerHeight(code, 0, 0),
    terrainCellCornerHeight(code, 1, 0),
    terrainCellCornerHeight(code, 1, 1),
    terrainCellCornerHeight(code, 0, 1),
  );
}

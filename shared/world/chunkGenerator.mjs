/**
 * chunk 生成后端的接口定义与纯 JS 实现。
 *
 * 「后端」要做两件事：按种子确定性地放置物件，再把模板几何体按每个物件的
 * 位置、朝向、缩放合批成一整块连续的顶点缓冲。WASM 后端在
 * chunkGeneratorWasm.mjs，这里的 JS 后端是它的参考实现与降级路径，
 * 两者的顶点写入顺序与放置结果必须完全一致。
 *
 * 之所以要保留一份 JS 实现：WASM 可能因为浏览器策略、构建产物缺失或
 * 加载失败而用不了，那时游戏应该照常跑，而不是变成一片空白的世界。
 */

import { PROP_KIND_COUNT } from './worldConfig.mjs';
import { PROP_BUFFER_LENGTH, PROP_FIELD, PROP_STRIDE, generateChunkProps } from './chunkContent.mjs';
import { CHUNK_SIZE } from './worldConfig.mjs';
import { isPropSkipped } from './generatedTree.mjs';

/** 地面铺块的模板下标，排在三种物件之后。与 Rust 侧的常量一致。 */
export const GROUND_TEMPLATE_INDEX = PROP_KIND_COUNT;

/** 模板总数。 */
export const CHUNK_TEMPLATE_COUNT = PROP_KIND_COUNT + 1;

/** 单个 chunk 合批后的顶点上限，与 Rust 侧的静态缓冲区容量一致。 */
export const MAXIMUM_FILL_VERTICES = 32_768;
export const MAXIMUM_LINE_VERTICES = 16_384;

/** 模板顶点暂存区的容量（f32 个数），与 Rust 侧一致。 */
export const TEMPLATE_ARENA_CAPACITY = 65_536;

/**
 * 单个填充顶点在模板里占用的 f32 个数：位置、法线、颜色各三个。
 *
 * 颜色随顶点走而不是随模板走，这样一棵树的树干与树冠能保留各自的配色，
 * 而整个 chunk 依然只用一种材质、一次 draw call。
 */
export const TEMPLATE_FILL_STRIDE = 9;

/**
 * @typedef {object} ChunkTemplate
 * @property {Float32Array} fill 交错的 [px, py, pz, nx, ny, nz, r, g, b]
 * @property {Float32Array} line 轮廓线顶点 [px, py, pz]
 */

/**
 * @typedef {object} ChunkGeometryData
 * @property {Float32Array} fillPositions
 * @property {Float32Array} fillNormals
 * @property {Float32Array} fillTints
 * @property {Float32Array} linePositions
 * @property {Int32Array} props 整数放置记录，供碰撞、拾取等玩法逻辑使用
 * @property {number} propCount
 */

/**
 * @typedef {object} ChunkGenerator
 * @property {'wasm' | 'javascript'} kind
 * @property {(seed: number) => void} setSeed
 * @property {(index: number, template: ChunkTemplate) => void} registerTemplate
 * @property {(chunkX: number, chunkZ: number, skipMask?: import('./generatedTree.mjs').PropSkipMask) => ChunkGeometryData} buildChunk
 */

/**
 * 纯 JS 的 chunk 生成后端。
 * @returns {ChunkGenerator}
 */
export function createJavaScriptChunkGenerator() {
  /** @type {(ChunkTemplate | undefined)[]} */
  const templates = new Array(CHUNK_TEMPLATE_COUNT).fill(undefined);
  const props = new Int32Array(PROP_BUFFER_LENGTH);
  const fillPositions = new Float32Array(MAXIMUM_FILL_VERTICES * 3);
  const fillNormals = new Float32Array(MAXIMUM_FILL_VERTICES * 3);
  const fillTints = new Float32Array(MAXIMUM_FILL_VERTICES * 3);
  const linePositions = new Float32Array(MAXIMUM_LINE_VERTICES * 3);

  let seed = 0;
  let fillCount = 0;
  let lineCount = 0;

  /**
   * 把一个模板按绕 Y 轴旋转 + 等比缩放 + 平移写进输出缓冲。
   * 等比缩放不改变法线方向，因此法线只做旋转。
   * @param {number} index
   * @param {number} translateX
   * @param {number} translateZ
   * @param {number} angle
   * @param {number} scale
   */
  function emitTemplate(index, translateX, translateZ, angle, scale) {
    const template = templates[index];
    if (!template) return true;

    const templateFillCount = template.fill.length / TEMPLATE_FILL_STRIDE;
    const templateLineCount = template.line.length / 3;
    if (fillCount + templateFillCount > MAXIMUM_FILL_VERTICES) return false;
    if (lineCount + templateLineCount > MAXIMUM_LINE_VERTICES) return false;

    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);

    let write = fillCount * 3;
    for (let read = 0; read < template.fill.length; read += TEMPLATE_FILL_STRIDE) {
      const positionX = template.fill[read];
      const positionY = template.fill[read + 1];
      const positionZ = template.fill[read + 2];
      const normalX = template.fill[read + 3];
      const normalY = template.fill[read + 4];
      const normalZ = template.fill[read + 5];
      const tintRed = template.fill[read + 6];
      const tintGreen = template.fill[read + 7];
      const tintBlue = template.fill[read + 8];

      fillPositions[write] = scale * (cosine * positionX + sine * positionZ) + translateX;
      fillPositions[write + 1] = scale * positionY;
      fillPositions[write + 2] = scale * (cosine * positionZ - sine * positionX) + translateZ;
      fillNormals[write] = cosine * normalX + sine * normalZ;
      fillNormals[write + 1] = normalY;
      fillNormals[write + 2] = cosine * normalZ - sine * normalX;
      fillTints[write] = tintRed;
      fillTints[write + 1] = tintGreen;
      fillTints[write + 2] = tintBlue;
      write += 3;
    }
    fillCount += templateFillCount;

    write = lineCount * 3;
    for (let read = 0; read < template.line.length; read += 3) {
      const positionX = template.line[read];
      const positionY = template.line[read + 1];
      const positionZ = template.line[read + 2];

      linePositions[write] = scale * (cosine * positionX + sine * positionZ) + translateX;
      linePositions[write + 1] = scale * positionY;
      linePositions[write + 2] = scale * (cosine * positionZ - sine * positionX) + translateZ;
      write += 3;
    }
    lineCount += templateLineCount;

    return true;
  }

  return {
    kind: 'javascript',

    setSeed(nextSeed) {
      seed = nextSeed >>> 0;
    },

    registerTemplate(index, template) {
      if (index < 0 || index >= CHUNK_TEMPLATE_COUNT) throw new RangeError(`模板下标越界：${index}`);
      templates[index] = template;
    },

    buildChunk(chunkX, chunkZ, skipMask) {
      fillCount = 0;
      lineCount = 0;
      const propCount = generateChunkProps(seed, chunkX, chunkZ, props);

      // 顺序必须与 Rust 侧一致：先铺地面，再按放置顺序摆物件。
      emitTemplate(
        GROUND_TEMPLATE_INDEX,
        chunkX * CHUNK_SIZE + CHUNK_SIZE / 2,
        chunkZ * CHUNK_SIZE + CHUNK_SIZE / 2,
        0,
        1,
      );

      for (let index = 0; index < propCount; index += 1) {
        if (isPropSkipped(index, skipMask)) continue;
        const offset = index * PROP_STRIDE;
        const filled = emitTemplate(
          props[offset + PROP_FIELD.KIND],
          props[offset + PROP_FIELD.X_MM] / 1000,
          props[offset + PROP_FIELD.Z_MM] / 1000,
          props[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
          props[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
        );
        if (!filled) break;
      }

      return {
        fillPositions: fillPositions.slice(0, fillCount * 3),
        fillNormals: fillNormals.slice(0, fillCount * 3),
        fillTints: fillTints.slice(0, fillCount * 3),
        linePositions: linePositions.slice(0, lineCount * 3),
        props: props.slice(0, propCount * PROP_STRIDE),
        propCount,
      };
    },
  };
}

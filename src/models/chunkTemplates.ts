import * as THREE from 'three';
import {
  GROUND_TEMPLATE_INDEX,
  MAXIMUM_FILL_VERTICES,
  MAXIMUM_LINE_VERTICES,
  TEMPLATE_FILL_STRIDE,
} from '../../shared/world/chunkGenerator.mjs';
import type { ChunkGenerator, ChunkTemplate } from '../../shared/world/chunkGenerator.mjs';
import { MAXIMUM_PROPS_PER_CHUNK, PROP_KIND } from '../../shared/world/worldConfig.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../materials/createFillMaterial';
import { createGrassClusterModel } from './grass';
import { createRockModel } from './rock';
import { createTreeModel } from './tree';

/** chunk 模板要用到的配色，来自场景配置。 */
export interface ChunkPalette {
  ground: THREE.ColorRepresentation;
  grass: THREE.ColorRepresentation;
  treeTrunk: THREE.ColorRepresentation;
  treeNeedles: THREE.ColorRepresentation;
  rock: THREE.ColorRepresentation;
}

export interface ChunkTemplateOptions {
  palette: ChunkPalette;
  /**
   * 关掉某一类内容时注册空模板：放置结果不变，只是不产生顶点。
   * 放置算法在两个后端之间必须逐位一致，所以它不接受任何逐场景的开关。
   */
  content: { ground: boolean; trees: boolean; grass: boolean };
  environment: FillMaterialEnvironment;
}

const EMPTY_TEMPLATE: ChunkTemplate = { fill: new Float32Array(0), line: new Float32Array(0) };

/**
 * chunk 模板。
 *
 * 生成后端只认「一串顶点」，模板负责把 src/models/ 里既有的线稿模型
 * 拍平成那串顶点。这样视觉定义仍然只有一处：改树的形状照旧改 tree.ts，
 * 不需要在 Rust 或生成器里同步一份三角化实现。
 *
 * 一个模板同时带上填充顶点（位置 + 法线 + 颜色）与轮廓线顶点。颜色随顶点走，
 * 树干与树冠因此能保留各自的配色，而整个 chunk 依然只用一种材质。
 */

interface TemplateAccumulator {
  fill: number[];
  line: number[];
}

const scratchVertex = new THREE.Vector3();
const scratchNormal = new THREE.Vector3();
const scratchNormalMatrix = new THREE.Matrix3();

/** 从线稿填充材质里取出这一块的颜色。 */
function readFillColor(material: THREE.Material | THREE.Material[]): THREE.Color {
  const single = Array.isArray(material) ? material[0] : material;
  const uniforms = (single as THREE.ShaderMaterial).uniforms;
  const color = uniforms?.uColor?.value;
  if (color instanceof THREE.Color) return color;
  throw new Error('chunk 模板要求填充材质由 createFillMaterial 创建');
}

function appendMesh(target: TemplateAccumulator, mesh: THREE.Mesh): void {
  const source = mesh.geometry;
  // 合批需要一条连续的顶点流，索引几何体先展开；展开出来的是临时对象，用完即弃。
  const geometry = source.index ? source.toNonIndexed() : source;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const color = readFillColor(mesh.material);
  scratchNormalMatrix.getNormalMatrix(mesh.matrixWorld);

  for (let index = 0; index < positions.count; index += 1) {
    scratchVertex
      .fromBufferAttribute(positions as THREE.BufferAttribute, index)
      .applyMatrix4(mesh.matrixWorld);
    if (normals) {
      scratchNormal
        .fromBufferAttribute(normals as THREE.BufferAttribute, index)
        .applyMatrix3(scratchNormalMatrix)
        .normalize();
    } else {
      scratchNormal.set(0, 1, 0);
    }

    target.fill.push(
      scratchVertex.x,
      scratchVertex.y,
      scratchVertex.z,
      scratchNormal.x,
      scratchNormal.y,
      scratchNormal.z,
      color.r,
      color.g,
      color.b,
    );
  }

  if (geometry !== source) geometry.dispose();
}

function appendLines(target: TemplateAccumulator, lines: THREE.LineSegments): void {
  const positions = lines.geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    scratchVertex
      .fromBufferAttribute(positions as THREE.BufferAttribute, index)
      .applyMatrix4(lines.matrixWorld);
    target.line.push(scratchVertex.x, scratchVertex.y, scratchVertex.z);
  }
}

/** 把一个线稿模型拍平成模板。模型自身的层级变换会被烘焙进顶点。 */
function createTemplateFromObject(object: THREE.Object3D): ChunkTemplate {
  object.updateWorldMatrix(true, true);
  const accumulator: TemplateAccumulator = { fill: [], line: [] };

  object.traverse((child) => {
    if (child instanceof THREE.LineSegments) appendLines(accumulator, child);
    else if (child instanceof THREE.Mesh) appendMesh(accumulator, child);
  });

  return {
    fill: new Float32Array(accumulator.fill),
    line: new Float32Array(accumulator.line),
  };
}

/**
 * 一个 chunk 全是同一种物件时最多要多少顶点。
 *
 * 生成后端的输出缓冲是定长的，超了会直接构建失败。把这个上界在启动时算一遍，
 * 谁把树的面数调高到装不下时能立刻看到原因，而不是在某个 chunk 上突然报错。
 */
function warnIfTemplatesOverflow(templates: ChunkTemplate[], ground: ChunkTemplate): void {
  const fillPerProp = Math.max(...templates.map((one) => one.fill.length / TEMPLATE_FILL_STRIDE));
  const linePerProp = Math.max(...templates.map((one) => one.line.length / 3));
  const worstFill = fillPerProp * MAXIMUM_PROPS_PER_CHUNK + ground.fill.length / TEMPLATE_FILL_STRIDE;
  const worstLine = linePerProp * MAXIMUM_PROPS_PER_CHUNK;

  if (worstFill > MAXIMUM_FILL_VERTICES) {
    console.warn(
      `[world] 模板过重：单个 chunk 最坏需要 ${worstFill} 个填充顶点，` +
        `超过缓冲区上限 ${MAXIMUM_FILL_VERTICES}，请精简模型或调高 MAX_FILL_VERTICES`,
    );
  }
  if (worstLine > MAXIMUM_LINE_VERTICES) {
    console.warn(
      `[world] 模板过重：单个 chunk 最坏需要 ${worstLine} 个轮廓线顶点，` +
        `超过缓冲区上限 ${MAXIMUM_LINE_VERTICES}，请精简模型或调高 MAX_LINE_VERTICES`,
    );
  }
}

/**
 * 按场景配色建好全部模板并注册进生成后端。
 *
 * 每个流式场景有自己的生成后端实例，所以这里每个场景调用一次；
 * 用来读取顶点色的材质是临时的，抽完模板就释放。
 */
export function registerChunkTemplates(
  generator: ChunkGenerator,
  options: ChunkTemplateOptions,
): void {
  const { palette, content, environment } = options;
  const materials = [
    createFillMaterial(palette.treeTrunk, environment),
    createFillMaterial(palette.treeNeedles, environment),
    createFillMaterial(palette.grass, environment),
    createFillMaterial(palette.rock, environment),
  ];
  const [trunkMaterial, needleMaterial, grassMaterial, rockMaterial] = materials;

  const tree = content.trees
    ? createTemplateFromObject(createTreeModel(trunkMaterial, needleMaterial))
    : EMPTY_TEMPLATE;
  const grass = content.grass
    ? createTemplateFromObject(createGrassClusterModel(grassMaterial))
    : EMPTY_TEMPLATE;
  const rock = createTemplateFromObject(createRockModel(rockMaterial));
  // 台地、斜坡、断崖与水面由 TerrainChunkView 独立生成；WASM 只合批静态物件。
  const ground = EMPTY_TEMPLATE;
  // 蘑菇是完整复制的交互 Actor；空模板只保留确定性放置记录，不重复画静态网格。
  const mushroom = EMPTY_TEMPLATE;
  warnIfTemplatesOverflow([tree, grass, rock, mushroom], ground);

  generator.registerTemplate(PROP_KIND.TREE, tree);
  generator.registerTemplate(PROP_KIND.GRASS, grass);
  generator.registerTemplate(PROP_KIND.ROCK, rock);
  generator.registerTemplate(PROP_KIND.MUSHROOM, mushroom);
  generator.registerTemplate(GROUND_TEMPLATE_INDEX, ground);

  for (const material of materials) material.dispose();
}

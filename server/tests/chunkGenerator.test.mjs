import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CHUNK_TEMPLATE_COUNT,
  GROUND_TEMPLATE_INDEX,
  TEMPLATE_FILL_STRIDE,
  createJavaScriptChunkGenerator,
} from '../../shared/world/chunkGenerator.mjs';
import { instantiateChunkGenerator } from '../../shared/world/chunkGeneratorWasm.mjs';
import { DEFAULT_WORLD_SEED } from '../../shared/world/worldConfig.mjs';
import { setPropSkipped } from '../../shared/world/generatedProp.mjs';
import { PROP_FIELD, PROP_STRIDE } from '../../shared/world/chunkContent.mjs';

const WASM_PATH = fileURLToPath(new URL('../../shared/world/wasm/chunkgen.wasm', import.meta.url));

/** 构造一个形状简单但顶点布局完整的模板，用来比对两个后端的输出。 */
function createTestTemplate(size, tint, lineSegments) {
  const fill = [];
  for (const corner of [
    [0, 0, 0],
    [size, 0, 0],
    [0, size, size],
  ]) {
    fill.push(corner[0], corner[1], corner[2], 0, 1, 0, tint[0], tint[1], tint[2]);
  }
  const line = [];
  for (let index = 0; index < lineSegments; index += 1) {
    line.push(0, 0, 0, size, index * 0.1, size);
  }
  return { fill: new Float32Array(fill), line: new Float32Array(line) };
}

const TEMPLATES = [
  createTestTemplate(1.2, [0.2, 0.6, 0.3], 3),
  createTestTemplate(0.4, [0.7, 0.8, 0.6], 1),
  createTestTemplate(0.7, [0.5, 0.5, 0.5], 2),
  { fill: new Float32Array(0), line: new Float32Array(0) },
  createTestTemplate(16, [0.94, 0.93, 0.87], 0),
];

async function createBackends(seed = DEFAULT_WORLD_SEED) {
  const wasm = await instantiateChunkGenerator(await readFile(WASM_PATH));
  const javascript = createJavaScriptChunkGenerator();
  for (const backend of [wasm, javascript]) {
    backend.setSeed(seed);
    TEMPLATES.forEach((template, index) => backend.registerTemplate(index, template));
  }
  return { wasm, javascript };
}

test('签入的 chunkgen.wasm 与 JS 侧的常量对得上', async () => {
  const wasm = await instantiateChunkGenerator(await readFile(WASM_PATH));
  assert.equal(wasm.kind, 'wasm');
  assert.equal(TEMPLATES.length, CHUNK_TEMPLATE_COUNT);
  assert.equal(GROUND_TEMPLATE_INDEX, CHUNK_TEMPLATE_COUNT - 1);
});

test('WASM 与 JS 后端的放置记录逐位相同', async () => {
  const { wasm, javascript } = await createBackends();
  for (let chunkX = -4; chunkX <= 4; chunkX += 1) {
    for (let chunkZ = -4; chunkZ <= 4; chunkZ += 1) {
      const fromWasm = wasm.buildChunk(chunkX, chunkZ);
      const fromJavaScript = javascript.buildChunk(chunkX, chunkZ);
      assert.equal(fromWasm.propCount, fromJavaScript.propCount, `${chunkX}:${chunkZ} 物件数不同`);
      // 放置记录是整数域运算的结果，两端必须一模一样。
      // 服务端敢不同步静态物件，靠的就是这一条。
      assert.deepEqual(
        Array.from(fromWasm.props),
        Array.from(fromJavaScript.props),
        `${chunkX}:${chunkZ} 放置记录不同`,
      );
    }
  }
});

test('两个后端合批出的顶点结构一致，数值只差浮点精度', async () => {
  const { wasm, javascript } = await createBackends();
  let worstPosition = 0;

  for (let chunkX = -2; chunkX <= 2; chunkX += 1) {
    for (let chunkZ = -2; chunkZ <= 2; chunkZ += 1) {
      const fromWasm = wasm.buildChunk(chunkX, chunkZ);
      const fromJavaScript = javascript.buildChunk(chunkX, chunkZ);

      assert.equal(fromWasm.fillPositions.length, fromJavaScript.fillPositions.length);
      assert.equal(fromWasm.linePositions.length, fromJavaScript.linePositions.length);
      // 颜色只是搬运，不参与运算，必须完全相同。
      assert.deepEqual(Array.from(fromWasm.fillTints), Array.from(fromJavaScript.fillTints));

      for (let index = 0; index < fromWasm.fillPositions.length; index += 1) {
        worstPosition = Math.max(
          worstPosition,
          Math.abs(fromWasm.fillPositions[index] - fromJavaScript.fillPositions[index]),
        );
      }
    }
  }

  // Rust 侧用的是自己实现的多项式三角函数，与 Math.sin 有极小差异，
  // 对朝向来说完全不可见；真正要求逐位一致的是上一条测试里的放置记录。
  assert.ok(worstPosition < 1e-4, `顶点偏差过大：${worstPosition}`);
});

test('顶点数量与放置结果对得上', async () => {
  const { wasm } = await createBackends();
  const built = wasm.buildChunk(0, 0);
  let expected = TEMPLATES[GROUND_TEMPLATE_INDEX].fill.length / TEMPLATE_FILL_STRIDE;
  for (let index = 0; index < built.propCount; index += 1) {
    const kind = built.props[index * PROP_STRIDE + PROP_FIELD.KIND];
    expected += TEMPLATES[kind].fill.length / TEMPLATE_FILL_STRIDE;
  }
  assert.equal(built.fillPositions.length / 3, expected);
});

test('换种子会换掉整个世界', async () => {
  const { wasm } = await createBackends();
  const before = Array.from(wasm.buildChunk(2, 2).props);
  wasm.setSeed(DEFAULT_WORLD_SEED + 1);
  assert.notDeepEqual(Array.from(wasm.buildChunk(2, 2).props), before);
});

test('两个后端使用同一跳过掩码挖掉物件，但完整放置记录保持不变', async () => {
  const { wasm, javascript } = await createBackends();
  const baseline = javascript.buildChunk(-3, 2);
  assert.ok(baseline.propCount > 0);
  const mask = setPropSkipped(undefined, 0, true);
  const fromWasm = wasm.buildChunk(-3, 2, mask);
  const fromJavaScript = javascript.buildChunk(-3, 2, mask);

  assert.deepEqual(Array.from(fromWasm.props), Array.from(baseline.props));
  assert.deepEqual(Array.from(fromJavaScript.props), Array.from(baseline.props));
  assert.equal(fromWasm.fillPositions.length, fromJavaScript.fillPositions.length);
  assert.equal(
    fromJavaScript.fillPositions.length,
    baseline.fillPositions.length - TEMPLATES[0].fill.length / TEMPLATE_FILL_STRIDE * 3,
  );
});

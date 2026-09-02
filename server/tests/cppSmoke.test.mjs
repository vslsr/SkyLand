import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CPP_SMOKE_ABI_VERSION,
  createCppSmoke,
  instantiateCppSmoke,
} from '../../shared/native/index.mjs';

const WASM_PATH = fileURLToPath(new URL('../../shared/native/wasm/cppsmoke.wasm', import.meta.url));

const wasmBytes = await readFile(WASM_PATH);

test('签入的 cppsmoke.wasm 没有 import，能脱离 Emscripten 胶水实例化', () => {
  const module = new WebAssembly.Module(wasmBytes);
  // 这是 -sSTANDALONE_WASM 唯一真正要守住的性质：import 段一旦不空，
  // 就说明链接选项退化了，浏览器侧那份 instantiate(bytes, {}) 会当场失败。
  assert.deepEqual(WebAssembly.Module.imports(module), []);

  const smoke = createCppSmoke(new WebAssembly.Instance(module, {}));
  assert.equal(smoke.add(2, 3), 5);
});

test('C++ add 与 JS 侧对同一批输入结果一致', async () => {
  const smoke = await instantiateCppSmoke(wasmBytes);

  for (const [a, b] of [[2, 3], [0, 0], [-7, 4], [1234567, 7654321], [-2147483648, 0]]) {
    assert.equal(smoke.add(a, b), a + b, `add(${a}, ${b})`);
  }
});

test('产物的契约版本与 JS 侧常量一致，落后的产物会被拒绝', async () => {
  const smoke = await instantiateCppSmoke(wasmBytes);
  assert.equal(smoke.abiVersion, CPP_SMOKE_ABI_VERSION);

  // 伪造一个上一版契约的实例，确认门面拒绝它而不是静默接受。
  const stale = { exports: { add: (a, b) => a + b, smoke_abi_version: () => CPP_SMOKE_ABI_VERSION - 1 } };
  assert.throws(() => createCppSmoke(stale), /build:cpp-wasm/);
});

test('缺少导出的模块会被门面拒绝', () => {
  assert.throws(() => createCppSmoke({ exports: {} }), /缺少预期导出/);
});

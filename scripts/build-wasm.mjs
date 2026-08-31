/**
 * 编译 native/chunkgen 并把产物拷进 shared/world/wasm/。
 *
 * 产物是签入仓库的：绝大多数人拉下来只想 npm run dev，
 * 不应该为了跑起来先装一套 Rust 工具链。只有改动了 native/ 下的
 * Rust 源码时才需要执行 npm run build:wasm 并把新的 .wasm 一起提交。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(projectRoot, 'native', 'chunkgen', 'Cargo.toml');
const target = 'wasm32-unknown-unknown';
const outputDirectory = join(projectRoot, 'shared', 'world', 'wasm');
const outputPath = join(outputDirectory, 'chunkgen.wasm');

const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', manifestPath, '--target', target],
  { stdio: 'inherit' },
);

if (build.error) {
  console.error('无法执行 cargo，请先安装 Rust 工具链：https://rustup.rs');
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const artifact = join(
  projectRoot,
  'native',
  'chunkgen',
  'target',
  target,
  'release',
  'chunkgen.wasm',
);

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(artifact, outputPath);
console.log(`chunkgen.wasm 已更新：${(statSync(outputPath).size / 1024).toFixed(1)} KB`);

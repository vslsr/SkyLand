/**
 * 编译 native/cppsmoke 并把产物拷进 shared/native/wasm/。
 *
 * 与 build-wasm.mjs（Rust/chunkgen）同样的约定：产物是签入仓库的，
 * 绝大多数人拉下来只想 npm run dev，不该为此先装一套 1.7 GB 的 Emscripten。
 * 只有改动了 native/cppsmoke/ 下的 C++ 源码时才需要执行 npm run build:cpp-wasm
 * 并把新的 .wasm 一起提交。
 *
 * 找 Emscripten 的顺序：PATH 上的 emcmake → $EMSDK/upstream/emscripten。
 * 两者都找不到就给出 emsdk 的安装指引后退出。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(projectRoot, 'native', 'cppsmoke');
const buildDirectory = join(sourceDirectory, 'build');
const outputDirectory = join(projectRoot, 'shared', 'native', 'wasm');
const outputPath = join(outputDirectory, 'cppsmoke.wasm');

/** Windows 上 emcmake 是 .bat；其余平台是无扩展名的脚本。 */
const emcmakeNames = process.platform === 'win32' ? ['emcmake.bat', 'emcmake'] : ['emcmake'];

/**
 * @returns {string | undefined} emcmake 的可执行路径
 */
function locateEmcmake() {
  const searchRoots = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (process.env.EMSDK) searchRoots.push(join(process.env.EMSDK, 'upstream', 'emscripten'));

  for (const root of searchRoots) {
    for (const name of emcmakeNames) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const emcmake = locateEmcmake();
if (!emcmake) {
  console.error(
    '找不到 emcmake。请先安装 Emscripten：\n'
    + '  git clone https://github.com/emscripten-core/emsdk.git\n'
    + '  cd emsdk && ./emsdk install latest && ./emsdk activate latest\n'
    + '  source ./emsdk_env.sh   # Windows 用 emsdk_env.bat\n'
    + '产物已签入仓库，只有改了 native/cppsmoke/ 下的 C++ 才需要这一步。',
  );
  process.exit(1);
}

/** Ninja 装了就用，没装退回 CMake 的默认生成器，保持跨平台可用。 */
const hasNinja = spawnSync('ninja', ['--version'], { stdio: 'ignore' }).status === 0;

const configure = spawnSync(
  emcmake,
  [
    'cmake',
    '-S', sourceDirectory,
    '-B', buildDirectory,
    ...(hasNinja ? ['-G', 'Ninja'] : []),
    '-DCMAKE_BUILD_TYPE=Release',
  ],
  { stdio: 'inherit' },
);
if (configure.error) {
  console.error('无法执行 emcmake：', configure.error.message);
  process.exit(1);
}
if (configure.status !== 0) process.exit(configure.status ?? 1);

const build = spawnSync('cmake', ['--build', buildDirectory], { stdio: 'inherit' });
if (build.error) {
  console.error('无法执行 cmake，请确认 CMake 已安装并在 PATH 上');
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(join(buildDirectory, 'cppsmoke.wasm'), outputPath);
console.log(`cppsmoke.wasm 已更新：${statSync(outputPath).size} 字节`);

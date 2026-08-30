import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;
const CANDIDATE_SUFFIXES = ['.ts', '/index.ts'];

/**
 * `src/` 里按 Vite 的习惯写不带扩展名的相对导入，而 Node 的 ESM 解析要求写全。
 * 这个钩子只在「相对路径 + 没有扩展名 + 同名 .ts 确实存在」时补上扩展名，
 * 让测试可以直接引用 src 模块，其余解析一概交回 Node 默认行为。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !HAS_EXTENSION.test(specifier) && context.parentURL) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelativeTypeScriptImport =
      error?.code === 'ERR_MODULE_NOT_FOUND'
      && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !specifier.match(/\.[a-z0-9]+$/i);
    if (!isRelativeTypeScriptImport) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}

/** 让当前 Node 20 测试进程使用项目已有的 TypeScript 编译器加载纯逻辑测试。 */
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);

  const filename = fileURLToPath(url);
  const source = await readFile(filename, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      sourceMap: true,
    },
  });

  return {
    format: 'module',
    source: transpiled.outputText,
    shortCircuit: true,
  };
}

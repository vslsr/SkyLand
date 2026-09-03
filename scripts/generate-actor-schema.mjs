/**
 * 从模型描述符的 `fields` 生成 `config/actors/actor.schema.json` 的 render 段。
 *
 * 这一段原来是手工维护的：280 行，把 `ActorCatalog.validateRender` 的规则又抄了
 * 一遍。它**没有任何运行时消费者**（只有各 `*.actor.json` 的 `$schema` 引用它，
 * 编辑器读；真正的校验走 `ActorCatalog`），也**没有任何测试比对过两者**——于是
 * 两份已经漂了：木筏的 length/width、货箱的 length/width/height、礁石的
 * radius/height 在 schema 里没有上限，运行时却有。编辑器放行，服务端启动时报错。
 *
 * 现在两边读同一份 `fields`。`server/tests/ActorSchemaGeneration.test.mjs` 会在
 * 每次 `npm test` 时重新生成并与文件比对，漂移当场变红。
 *
 * 用法：`node scripts/generate-actor-schema.mjs` 就地重写；不带参数只写 render 段，
 * 文件其余部分逐字节不动。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actorModelIds, actorModel } from '../shared/actor/models/index.mjs';
import { fieldSpecToJsonSchema } from '../shared/actor/models/fieldSpec.mjs';

export const SCHEMA_PATH = fileURLToPath(new URL('../config/actors/actor.schema.json', import.meta.url));

/** 文件现有排版：叶子对象能一行放下就放一行，放不下才展开。缩进 2 空格。 */
const WIDTH = 100;

function inline(value) {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  const body = Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`)
    .join(', ');
  return body ? `{ ${body} }` : '{}';
}

function format(value, indent) {
  const pad = ' '.repeat(indent);
  const compact = inline(value);
  if (typeof value !== 'object' || value === null) return compact;
  if (indent + compact.length <= WIDTH) return compact;
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => `${pad}  ${format(item, indent + 2)}`).join(',\n')}\n${pad}]`;
  }
  const items = Object.entries(value)
    .map(([key, item]) => `${pad}  ${JSON.stringify(key)}: ${format(item, indent + 2)}`);
  return `{\n${items.join(',\n')}\n${pad}}`;
}

/** render 段的 JSON 对象。分支顺序 = 注册表登记顺序。 */
export function buildRenderSchema() {
  return {
    oneOf: actorModelIds().map((id) => {
      const fields = actorModel(id).fields;
      const properties = { model: { const: id } };
      for (const [name, spec] of Object.entries(fields)) {
        properties[name] = fieldSpecToJsonSchema(spec);
      }
      return {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      };
    }),
  };
}

/** 整份 schema 文件应有的文本：只替换 render 段，其余逐字节保留。 */
export function renderSchemaFileText(current = readFileSync(SCHEMA_PATH, 'utf8')) {
  const start = current.indexOf('        "render": {');
  if (start === -1) throw new Error('actor.schema.json 里找不到 render 段');
  const closing = '\n        }';
  const end = current.indexOf(`${closing}\n`, start) + closing.length;
  if (end < closing.length) throw new Error('actor.schema.json 的 render 段没有闭合');
  return current.slice(0, start)
    + `        "render": ${format(buildRenderSchema(), 8)}`
    + current.slice(end);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const before = readFileSync(SCHEMA_PATH, 'utf8');
  const after = renderSchemaFileText(before);
  if (before === after) {
    console.log('actor.schema.json 已是最新');
  } else {
    writeFileSync(SCHEMA_PATH, after);
    console.log('actor.schema.json 的 render 段已重新生成');
  }
}

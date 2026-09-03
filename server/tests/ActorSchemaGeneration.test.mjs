import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ActorCatalog, DEFAULT_ACTOR_DIRECTORY } from '../actors/ActorCatalog.mjs';
import { actorModel, actorModelIds } from '../../shared/actor/models/index.mjs';
import { SCHEMA_PATH, renderSchemaFileText } from '../../scripts/generate-actor-schema.mjs';

/**
 * `config/actors/actor.schema.json` 的 render 段是生成物。
 *
 * 它以前是手抄的第二份规则，**没有运行时消费者也没有测试**——于是和
 * `ActorCatalog.validateRender` 漂了七个字段（木筏 length/width、货箱三个尺寸、
 * 礁石 radius/height：schema 无上限，运行时有）。编辑器放行、服务端启动时报错。
 *
 * 现在两边读同一份 `fields`。这条用例是那个「没人验证」的窟窿的补丁：
 * 改了字段规格却忘了跑 `node scripts/generate-actor-schema.mjs`，这里当场变红。
 */
test('actor.schema.json 的 render 段与模型字段规格一致', () => {
  const onDisk = readFileSync(SCHEMA_PATH, 'utf8');
  assert.equal(
    renderSchemaFileText(onDisk),
    onDisk,
    'render 段已过期：跑 `node scripts/generate-actor-schema.mjs` 重新生成',
  );
});

test('schema 的每个 render 分支都对应一个注册模型，且字段清单相同', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const branches = schema.properties.components.properties.render.oneOf;
  assert.deepEqual(
    branches.map((branch) => branch.properties.model.const).sort(),
    [...actorModelIds()].sort(),
  );
  for (const branch of branches) {
    const id = branch.properties.model.const;
    assert.deepEqual(
      Object.keys(branch.properties),
      ['model', ...Object.keys(actorModel(id).fields)],
      `${id} 的 schema 字段与 fields 声明不一致`,
    );
    // required 必须覆盖全部字段：render 没有可选字段，漏一个就等于放行了缺字段的 JSON。
    assert.deepEqual(branch.required, Object.keys(branch.properties), id);
    assert.equal(branch.additionalProperties, false, id);
  }
});

test('仓库里每一份 actor JSON 都仍然通过校验', async () => {
  // 生成器改的是 schema，校验走 fields——两者出自同一份声明，
  // 这条用例保证那份声明对真实 authoring 值仍然成立。
  const catalog = await ActorCatalog.load(DEFAULT_ACTOR_DIRECTORY);
  const withRender = [...catalog.definitions.values()]
    .filter((archetype) => archetype.components.render);
  assert.ok(withRender.length >= 16, `带 render 的原型只有 ${withRender.length} 个`);
  for (const archetype of withRender) {
    const { model, ...fields } = archetype.components.render;
    assert.ok(actorModel(model), `${archetype.id} 的 ${model} 不在注册表里`);
    assert.deepEqual(
      Object.keys(fields),
      Object.keys(actorModel(model).fields),
      `${archetype.id} 净化后的字段与 fields 声明不一致`,
    );
  }
});

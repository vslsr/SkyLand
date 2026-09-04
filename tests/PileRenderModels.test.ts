import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorCatalog, PILE_RENDER_MODELS as VALIDATED_PILE_MODELS } from '../server/actors/ActorCatalog.mjs';
import { PILE_RENDER_MODELS as DRAWN_PILE_MODELS } from '../src/render/three/ThreeHighCountBatchVisual';
import { createMushroomParts } from '../src/models/actors/createMushroomPileModel';

/**
 * 掉落物与手持物走的是合批绘制，而合批只认这张表里的模型。表外的 itemStack 原型
 * **一声不响地什么都不画**：地上的那堆和手上那件同时消失，没有任何报错指向配置。
 *
 * 配置校验因此按同一张表拦人。两张表分居两侧（一份是玩法事实、一份是渲染实现），
 * 这条把它们钉在一起——只在一边登记新堆叠物，是那类失败的唯一入口。
 */
test('校验用的堆叠模型表和合批真的画得出来的那张，逐项相等', () => {
  assert.deepEqual(
    [...VALIDATED_PILE_MODELS].sort(),
    [...DRAWN_PILE_MODELS].sort(),
  );
});

test('每个带 itemStack 的原型都用画得出来的堆叠模型', async () => {
  const catalog = await ActorCatalog.load();
  const stacks = [...catalog.archetypes()].filter((archetype) => archetype.components.itemStack);
  assert.ok(stacks.length > 0);
  for (const archetype of stacks) {
    assert.ok(
      DRAWN_PILE_MODELS.has(archetype.components.render?.model),
      `${archetype.id} 的 ${archetype.components.render?.model} 合批画不出来`,
    );
  }
});

/**
 * 采下来的弹弹菇和世界里长着的那株共用同一份几何：菌柄、菌盖、三点白斑。
 * 借果子堆的模板画蘑菇时，玩家在手上看到的是一小捧浆果。
 */
test('弹弹菇的堆叠模型就是蘑菇本体：菌柄、菌盖和三点白斑', () => {
  const parts = createMushroomParts(0.26, 0.5);
  assert.deepEqual(
    parts.map((part) => part.part),
    ['stem', 'cap', 'spot', 'spot', 'spot'],
  );
  for (const part of parts) {
    assert.ok(part.geometry.getAttribute('position').count > 0, `${part.part} 没有几何`);
  }
  // 菌盖压在菌柄顶端，不在原点上：整朵蘑菇是立着的。
  assert.ok(parts[1].matrix.elements[13] > 0.2);
});

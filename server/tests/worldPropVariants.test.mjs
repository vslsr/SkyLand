import assert from 'node:assert/strict';
import test from 'node:test';
import { PROP_KIND } from '../../shared/world/worldConfig.mjs';
import { selectWorldPropVariant } from '../../shared/world/worldPropVariants.mjs';

const VARIANTS = [
  { archetypeId: 'ordinary-tree', weight: 5 },
  { archetypeId: 'fruit-tree', weight: 1 },
];

test('世界物件变体由种子与放置地址稳定选择', () => {
  const select = (seed) => Array.from({ length: 64 }, (_, propIndex) => (
    selectWorldPropVariant(seed, PROP_KIND.TREE, -3, 7, propIndex, VARIANTS)?.archetypeId
  ));
  const first = select(0x5c1a2d0b);
  assert.deepEqual(select(0x5c1a2d0b), first);
  assert.notDeepEqual(select(0x5c1a2d0c), first);
  assert.ok(first.includes('ordinary-tree'));
  assert.ok(first.includes('fruit-tree'));
});

test('单项配置恒定命中，非法列表安全地不选择', () => {
  const only = [{ archetypeId: 'large-rock', weight: 1 }];
  for (let propIndex = 0; propIndex < 64; propIndex += 1) {
    assert.equal(
      selectWorldPropVariant(123, PROP_KIND.ROCK, 0, 0, propIndex, only)?.archetypeId,
      'large-rock',
    );
  }
  assert.equal(selectWorldPropVariant(123, PROP_KIND.ROCK, 0, 0, 0, []), undefined);
  assert.equal(
    selectWorldPropVariant(123, PROP_KIND.ROCK, 0, 0, 0, [{ weight: 0 }]),
    undefined,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TagContainer,
  defineTag,
  getParentTags,
  isTagDescendantOf,
  isTagParentOf,
  isValidTag,
  tagMatches,
} from '../src/tags/index.ts';

test('标签格式使用非空的点分层级', () => {
  assert.equal(defineTag('Input.Player.Move'), 'Input.Player.Move');
  assert.equal(isValidTag('Input.Player_1.Move2'), true);
  assert.equal(isValidTag('Input..Move'), false);
  assert.equal(isValidTag('.Input.Move'), false);
  assert.equal(isValidTag('Input.Move '), false);
  assert.throws(() => defineTag('Input..Move'), TypeError);
});

test('标签关系是精确或由子级向父级匹配', () => {
  assert.equal(tagMatches('Input.Player.Move', 'Input.Player.Move'), true);
  assert.equal(tagMatches('Input.Player.Move', 'Input.Player'), true);
  assert.equal(tagMatches('Input.Player', 'Input.Player.Move'), false);
  assert.equal(tagMatches('Input.PlayerMove', 'Input.Player'), false);
  assert.equal(isTagDescendantOf('Input.Player.Move', 'Input.Player'), true);
  assert.equal(isTagDescendantOf('Input.Player', 'Input.Player'), false);
  assert.equal(isTagParentOf('Input.Player', 'Input.Player.Move'), true);
});

test('可以取得从直接父级到根级的父标签', () => {
  assert.deepEqual(getParentTags('Input.Player.Move.Fast'), [
    'Input.Player.Move',
    'Input.Player',
    'Input',
  ]);
  assert.deepEqual(getParentTags('Input'), []);
});

test('容器去重并保留显式标签', () => {
  const tags = TagContainer.from('Input.Player.Move', 'Input.Player.Move');
  tags.add('Input.Player.Sprint');

  assert.equal(tags.size, 2);
  assert.deepEqual(tags.toArray(), ['Input.Player.Move', 'Input.Player.Sprint']);
  assert.equal(tags.hasExact('Input.Player.Move'), true);
  assert.equal(tags.delete('Input.Player.Move'), true);
  assert.equal(tags.hasExact('Input.Player.Move'), false);
});

test('容器的层级查询不会把父标签当成具体子标签', () => {
  const childContainer = TagContainer.from('Input.Player.Move');
  assert.equal(childContainer.hasTag('Input.Player'), true);
  assert.equal(childContainer.hasExact('Input.Player'), false);

  const parentContainer = TagContainer.from('Input.Player');
  assert.equal(parentContainer.hasTag('Input.Player.Move'), false);
});

test('容器支持 Any、All 及其精确匹配版本', () => {
  const tags = TagContainer.from('Input.Player.Move', 'State.Player.Stunned');

  assert.equal(tags.hasAny(['Input.UI.Accept', 'Input.Player']), true);
  assert.equal(tags.hasAll(['Input.Player', 'State.Player']), true);
  assert.equal(tags.hasAnyExact(['Input.Player', 'State.Player.Stunned']), true);
  assert.equal(tags.hasAllExact(['Input.Player', 'State.Player.Stunned']), false);
  assert.equal(tags.hasAny([]), false);
  assert.equal(tags.hasAll([]), true);
});

test('容器可由单个标签、可迭代对象或另一个容器构造和克隆', () => {
  const single = new TagContainer('Input.Player.Move');
  const combined = new TagContainer(new Set(['Input.Player.Sprint']));
  combined.addAll(single);
  const cloned = combined.clone();

  combined.clear();
  assert.deepEqual(cloned.toArray(), ['Input.Player.Sprint', 'Input.Player.Move']);
  assert.equal(combined.size, 0);
});

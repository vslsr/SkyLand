import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryName } from '../../shared/temporaryName.mjs';

test('temporary names use a human name and retain a four-digit suffix', () => {
  const values = [0, 0, 0, 0.999999, 0.999999, 0.999999];
  const random = () => values.shift();

  assert.equal(createTemporaryName(random), '林悠-1000');
  assert.equal(createTemporaryName(random), '叶秋-9999');
});

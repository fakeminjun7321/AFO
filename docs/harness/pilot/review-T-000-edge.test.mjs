import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from './format-duration.mjs';

test('invalid inputs throw RangeError', () => {
  for (const v of [-1, NaN, 1.5, Infinity, '5', null, undefined, -0.5]) {
    assert.throws(() => formatDuration(v), RangeError, String(v));
  }
});
test('boundaries', () => {
  assert.equal(formatDuration(59999), '59s');
  assert.equal(formatDuration(60000), '1m 00s');
  assert.equal(formatDuration(3599999), '59m 59s');
  assert.equal(formatDuration(3600000), '1h 00m 00s');
  assert.equal(formatDuration(86399999), '23h 59m 59s');
});

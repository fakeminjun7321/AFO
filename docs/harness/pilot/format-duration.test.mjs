import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from './format-duration.mjs';

test('zero and sub-second', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(999), '0s');
  assert.equal(formatDuration(1999), '1s');
});
test('seconds only', () => assert.equal(formatDuration(3000), '3s'));
test('minutes', () => assert.equal(formatDuration(123000), '2m 03s'));
test('hours', () => assert.equal(formatDuration(3723000), '1h 02m 03s'));
test('hours with zero minutes', () => assert.equal(formatDuration(3603000), '1h 00m 03s'));
test('days', () => {
  assert.equal(formatDuration(90061000), '1d 1h 01m 01s');
  assert.equal(formatDuration(86400000), '1d 0h 00m 00s');
});
test('invalid input throws RangeError', () => {
  for (const v of [-1, NaN, 1.5, Infinity, -Infinity]) {
    assert.throws(() => formatDuration(v), RangeError);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { FileSchema, ProfileSchema, RelativePathSchema, ScanSchema } from '../packages/contracts/src/index.js';
import { scanFixture } from './helpers.js';

test('portable relative paths reject traversal, absolute paths and Windows aliases', () => {
  for (const value of ['../secret', '/secret', 'C:/secret', 'a\\b', 'a//b', './a', 'a/../b', 'NUL.txt', 'a/CON', 'a./b', 'a\0b'])
    assert.equal(RelativePathSchema.safeParse(value).success, false, value);
  for (const value of ['물리/실험 보고서.hwpx', '사진/😀.jpg', '문서/a.pdf'])
    assert.equal(RelativePathSchema.parse(value), value);
});
test('file contracts require complete, correctly typed evidence', () => {
  const file = scanFixture(['a.pdf']).files[0]!;
  const { modifiedNs: _, ...missing } = file;
  assert.throws(() => FileSchema.parse(missing));
  assert.throws(() => FileSchema.parse({ ...file, size: '20' }));
  assert.throws(() => FileSchema.parse({ ...file, size: 0.5 }));
  assert.throws(() => FileSchema.parse({ ...file, approved: true }));
});
test('scans reject duplicate records and spoofed boolean state', () => {
  const scan = scanFixture(['a.pdf']);
  assert.throws(() => ScanSchema.parse({ ...scan, files: [scan.files[0], scan.files[0]] }));
  assert.throws(() => ScanSchema.parse({ ...scan, complete: 'true' }));
  assert.throws(() => ProfileSchema.parse({ status: 'confirmed', rules: [] }));
});

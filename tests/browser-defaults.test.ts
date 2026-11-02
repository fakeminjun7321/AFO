import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultCategory, extensionOfName } from '../packages/engine/src/defaults.js';
import { classifyFile } from '../packages/engine/src/classify.js';

test('browser default classification agrees with the shared CLI classification', () => {
  for (const name of ['report.pdf', 'PHOTO.JPG', 'archive.tar.gz', 'report.pdf.exe', 'unknown.zzz', 'noext', '한글.hwpx', 'src.tar.xz', 'hw1.py', 'movie.mp4.part', 'types.ts', 'dump.sql.gz']) {
    assert.equal(extensionOfName(name), path.posix.extname(name).toLowerCase());
    const browser = defaultCategory(name), cli = classifyFile(name);
    assert.equal(browser.category, cli.category, name);
    assert.equal(browser.reason, cli.reasonCode, name);
  }
  for (const name of ['file.', '..foo', '.env', '...'])
    assert.equal(extensionOfName(name), path.posix.extname(name).toLowerCase());
});

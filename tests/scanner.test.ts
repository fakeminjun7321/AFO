import test from 'node:test';
import assert from 'node:assert/strict';
import { link, symlink, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { analyzeFolder, scanFolder } from '../packages/filesystem/src/index.js';
import { fixture, manifest } from './helpers.js';

test('real scan and content duplicate analysis preserve every original', async (t) => {
  const root = await fixture(t, { '사진 😀.jpg': 'image', 'first.pdf': 'same', 'copy.pdf': 'same',
    'different.pdf': 'diff', '.private': 'untouched', 'nested/보고서.hwpx': 'report' });
  const before = await manifest(root);
  const scan = await scanFolder(root);
  assert.equal(scan.files.length, 5);
  assert.ok(scan.files.every((f) => f.sha256 === null));
  const { preview } = await analyzeFolder(root);
  assert.equal(preview.duplicates.length, 1);
  assert.deepEqual([preview.duplicates[0]!.suggestedKeep, ...preview.duplicates[0]!.candidates].sort(), ['copy.pdf', 'first.pdf']);
  assert.equal(preview.scanComplete, true);
  assert.deepEqual(await manifest(root), before);
});
test('empty folders produce a valid empty preview', async (t) => {
  const root = await fixture(t);
  const { preview } = await analyzeFolder(root);
  assert.deepEqual(preview.items, []); assert.deepEqual(preview.duplicates, []);
  assert.equal(preview.scanComplete, true);
});
test('scanner skips bundles and development projects, including nested projects', async (t) => {
  const root = await fixture(t, { 'ok.pdf': 'ok', 'Tool.app/private': 'bundle',
    'code/package.json': '{}', 'code/secret.ts': 'source', 'node_modules/mod/file': 'dependency' });
  const before = await manifest(root);
  const scan = await scanFolder(root);
  assert.deepEqual(scan.files.map((f) => f.relativePath), ['ok.pdf']);
  assert.equal(scan.skipped.length, 3);
  await assert.rejects(scanFolder(path.join(root, 'code')), /프로젝트/u);
  assert.deepEqual(await manifest(root), before);
});
test('links and hardlinks are excluded without reading the external tree', async (t) => {
  const root = await fixture(t, { 'single.pdf': 'data', 'source.pdf': 'hardlink data' });
  const external = await fixture(t, { 'outside.pdf': 'outside' });
  await link(path.join(root, 'source.pdf'), path.join(root, 'alias.pdf'));
  await symlink(external, path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await manifest(root); const outside = await manifest(external);
  const scan = await scanFolder(root);
  assert.deepEqual(scan.files.map((f) => f.relativePath), ['single.pdf']);
  assert.equal(scan.skipped.length, 3);
  await assert.rejects(scanFolder(path.join(root, 'shortcut')), /직접 선택/u);
  assert.deepEqual(await manifest(root), before); assert.deepEqual(await manifest(external), outside);
});
test('file and depth limits visibly return incomplete scans', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a', 'b.pdf': 'b', 'deep/inside.pdf': 'c' });
  assert.equal((await scanFolder(root, { maxFiles: 1 })).complete, false);
  assert.equal((await scanFolder(root, { maxDepth: 0 })).complete, false);
  await assert.rejects(scanFolder(root, { maxFiles: -1 }), /한도/u);
});
test('cancellation stops analysis and makes no changes', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'x' }); const before = await manifest(root);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeFolder(root, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await manifest(root), before);
});
test('a nested unreadable folder reports an error instead of false completeness', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX chmod is not a Windows ACL test.'); return; }
  const root = await fixture(t, { 'locked/private.pdf': 'private', 'ok.pdf': 'ok' });
  const locked = path.join(root, 'locked');
  await chmod(locked, 0);
  try {
    const scan = await scanFolder(root);
    assert.equal(scan.complete, false);
    assert.ok(scan.skipped.some((item) => item.reason.includes('EACCES')));
  } finally { await chmod(locked, 0o700); }
});
test('overlapping reference folders preserve their files and only propose unconfirmed rules', async (t) => {
  const root = await fixture(t, { 'new.pdf': 'new', '참고/과제/a.pdf': 'old1', '참고/과제/b.pdf': 'old2' });
  const before = await manifest(root);
  const { preview, suggestedProfile } = await analyzeFolder(root, { reference: path.join(root, '참고') });
  assert.equal(suggestedProfile!.status, 'draft');
  assert.equal(preview.items.find((x) => x.source === 'new.pdf')!.destination, '문서/new.pdf');
  const originals = preview.items.filter((x) => x.source.startsWith('참고/'));
  assert.ok(originals.every((x) => x.action === 'keep'));
  assert.deepEqual(preview.duplicates, []);
  assert.deepEqual(await manifest(root), before);
});
test('non-folder roots and missing paths fail without creating anything', async (t) => {
  const root = await fixture(t, { 'file.pdf': 'x' }); const before = await manifest(root);
  await assert.rejects(scanFolder(path.join(root, 'file.pdf')), /폴더/u);
  await assert.rejects(scanFolder(path.join(root, 'missing')));
  await mkdir(path.join(root, 'empty'));
  assert.deepEqual((await scanFolder(path.join(root, 'empty'))).files, []);
  const after = await manifest(root); delete after['empty'];
  assert.deepEqual(after, before);
});

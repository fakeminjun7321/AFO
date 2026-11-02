import test from 'node:test';
import assert from 'node:assert/strict';
import { link, symlink, chmod, mkdir, open, writeFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ScanProgressSchema, isAfoError, skipCodeDescriptions } from '../packages/contracts/src/index.js';
import type { ScanProgress } from '../packages/contracts/src/index.js';
import { suggestProfile } from '../packages/engine/src/index.js';
import { analyzeFolder, analyzeRoot, hashCandidates, issueReferenceGrant, issueRootGrant, readReference, scanFolder, scanRoot }
  from '../packages/filesystem/src/index.js';
import { createFixture, fixture, manifest, sampleSpec } from './helpers.js';

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
  if (process.getuid?.() === 0) { t.skip('root ignores POSIX permissions; run as a normal user.'); return; }
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

/* ---- #6/#7 scanner: grants, exclusion codes, progress, cancellation, hashing ---- */
const ok = (f: { relativePath: string }): string => f.relativePath;
const visibleFiles = (m: Awaited<ReturnType<typeof manifest>>): string[] =>
  Object.entries(m).filter(([name, e]) => e.type === 'file' && !name.split('/').some((p) => p.startsWith('.'))).map(([n]) => n).sort();
const abortAt = (n: number) => {
  const c = new AbortController(); let seen = 0;
  return { signal: c.signal, onProgress: () => { if (++seen === n) c.abort(); } };
};

test('every exclusion carries a machine code with a Korean explanation; deliberate exclusions keep the scan complete', async (t) => {
  const root = await fixture(t, { 'keep.pdf': 'k', '.hidden.pdf': 'h', '.cache/x.pdf': 'x', 'Tool.app/a': 'b',
    'node_modules/m/i.js': 'm', 'code/package.json': '{}', 'code/a.ts': 'a', 'Thumbs.db': 't', 'hard.pdf': 'linked' });
  await link(path.join(root, 'hard.pdf'), path.join(root, 'hard-alias.pdf'));
  // A folder junction needs no extra privilege on Windows; lstat reports it as a link on both OSes.
  await symlink(path.join(root, 'code'), path.join(root, 'link.pdf'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await manifest(root);
  const scan = await scanRoot(await issueRootGrant(root));
  assert.deepEqual(scan.files.map(ok), ['keep.pdf']);
  const codes = Object.fromEntries(scan.skipped.map((s) => [s.relativePath, s.code]));
  assert.deepEqual(codes, { '.cache': 'HIDDEN', '.hidden.pdf': 'HIDDEN', 'Thumbs.db': 'SYSTEM_PATH', 'Tool.app': 'APP_BUNDLE',
    code: 'DEV_PROJECT', 'hard-alias.pdf': 'HARDLINK', 'hard.pdf': 'HARDLINK', 'link.pdf': 'LINK', node_modules: 'DEV_PROJECT' });
  for (const s of scan.skipped) { assert.ok(s.reason.length > 0); assert.ok(skipCodeDescriptions[s.code!].length > 0); }
  assert.equal(scan.complete, true);
  assert.deepEqual(await manifest(root), before);
});
test('special files, unsupported names and sparse (cloud-only-like) files are excluded with codes', async (t) => {
  if (process.platform === 'win32') { t.skip('mkfifo, ":" names and APFS blocks are POSIX/macOS cases.'); return; }
  const root = await fixture(t, { 'ok.pdf': 'ok' });
  await writeFile(path.join(root, 'a:b.pdf'), 'colon', { flag: 'wx' });
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  const handle = await open(path.join(root, 'sparse.pdf'), 'w'); await handle.truncate(1 << 20); await handle.close();
  const before = await manifest(root);
  const scan = await scanFolder(root);
  const codes = Object.fromEntries(scan.skipped.map((s) => [s.relativePath, s.code]));
  assert.equal(codes['a:b.pdf'], 'UNSUPPORTED_NAME'); assert.equal(codes['pipe'], 'NOT_REGULAR');
  if (process.platform === 'darwin') {
    assert.equal(codes['sparse.pdf'], 'CLOUD_PLACEHOLDER');
    assert.deepEqual(scan.files.map(ok), ['ok.pdf']);
    assert.ok(scan.files[0]!.allocatedBytes! > 0);
  } else t.diagnostic('cloud placeholder heuristic is macOS-only; not checked here');
  assert.equal(scan.complete, true);
  assert.deepEqual(await manifest(root), before);
});
test('Korean NFC/NFD, spaces, emoji and empty folders match an independent manifest before and after', async (t) => {
  const { root } = await createFixture(sampleSpec(), t);
  const before = await manifest(root);
  const scan = await scanFolder(root);
  assert.deepEqual(scan.files.map(ok).sort(), visibleFiles(before));
  for (const f of scan.files) assert.equal(String(f.size), (before[f.relativePath] as { bytes: string }).bytes);
  assert.ok(scan.files.some((f) => f.relativePath === `문서/${'한글'.normalize('NFD')}.txt`), 'NFD spelling is preserved');
  assert.ok(scan.directories.includes('빈 폴더'));
  assert.equal(scan.complete, true);
  const { preview } = await analyzeFolder(root);
  assert.deepEqual(preview.duplicates.map((d) => [d.suggestedKeep, d.candidates]), [['같은 내용 1.zip', ['같은 내용 2.zip']]]);
  assert.deepEqual(await manifest(root), before);
});
test('depth and count limits are reported with codes and an incomplete result', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a', 'b.pdf': 'b', 'deep/inside.pdf': 'c', 'deep/more/x.pdf': 'd' });
  const depth = await scanFolder(root, { maxDepth: 0 });
  assert.deepEqual(depth.skipped.map((s) => [s.relativePath, s.code]), [['deep', 'DEPTH_LIMIT']]);
  assert.equal(depth.complete, false);
  const count = await scanFolder(root, { maxFiles: 2 });
  assert.deepEqual(count.files.map(ok), ['a.pdf', 'b.pdf']);
  assert.deepEqual(count.skipped.map((s) => s.code), ['COUNT_LIMIT']);
  assert.equal(count.complete, false);
  await assert.rejects(scanFolder(root, { hashConcurrency: 0 }), /한도/u);
  await assert.rejects(analyzeFolder(root, { hashConcurrency: 17 }), /한도/u);
});
test('access-denied folders and files give an accurate partial result instead of stopping', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX chmod is not a Windows ACL test.'); return; }
  const root = await fixture(t, { 'locked/private.pdf': 'private', 'same-a.pdf': 'same!', 'same-b.pdf': 'same!',
    'same-c.pdf': 'same!', 'ok.txt': 'ok' });
  await chmod(path.join(root, 'locked'), 0); await chmod(path.join(root, 'same-b.pdf'), 0);
  try {
    const { preview } = await analyzeFolder(root);
    assert.equal(preview.scanComplete, false);
    const skipped = Object.fromEntries(preview.skipped.map((s) => [s.relativePath, [s.code, s.detail]]));
    assert.deepEqual(skipped['locked'], ['READ_FAILED', 'EACCES']);
    assert.deepEqual(skipped['same-b.pdf'], ['HASH_FAILED', 'EACCES']);
    assert.equal(preview.items.find((i) => i.source === 'same-b.pdf')!.action, 'review');
    assert.deepEqual(preview.duplicates.map((d) => [d.suggestedKeep, d.candidates]), [['same-a.pdf', ['same-c.pdf']]]);
    assert.deepEqual(preview.duplicateNotes, [{ relativePath: 'same-b.pdf', code: 'HASH_UNAVAILABLE',
      reason: '내용을 확인하지 못해 중복 여부를 판단하지 않았습니다.' }]);
    assert.equal(preview.items.find((i) => i.source === 'ok.txt')!.action, 'move');
  } finally { await chmod(path.join(root, 'locked'), 0o700); await chmod(path.join(root, 'same-b.pdf'), 0o600); }
});
test('a file deleted during the scan is reported alone; the rest of the folder is still read', async (t) => {
  const root = await fixture(t, { 'dir/a.pdf': 'a', 'dir/b.pdf': 'b', 'z.pdf': 'z' });
  let events = 0;
  const scan = await scanFolder(root, { onProgress: (p) => {
    if (p.phase === 'scan' && ++events === 2) unlinkSync(path.join(root, 'dir', 'b.pdf'));
  } });
  assert.deepEqual(scan.files.map(ok), ['dir/a.pdf', 'z.pdf']);
  assert.deepEqual(scan.skipped.map((s) => [s.relativePath, s.code, s.detail]), [['dir/b.pdf', 'READ_FAILED', 'ENOENT']]);
  assert.equal(scan.complete, false);
});
test('progress reports scan and hash phases with monotonic counters', async (t) => {
  const root = await fixture(t, { 'a/1.pdf': 'same', 'a/2.pdf': 'same', 'b/3.pdf': 'diff', 'c.txt': 'unique text' });
  const events: ScanProgress[] = [];
  await analyzeFolder(root, { onProgress: (p) => { events.push(ScanProgressSchema.parse({ ...p })); } });
  const scanEvents = events.filter((e) => e.phase === 'scan'); const hashEvents = events.filter((e) => e.phase === 'hash');
  assert.equal(scanEvents.length, 3);
  assert.ok(hashEvents.length >= 2);
  const last = hashEvents.at(-1)!;
  assert.deepEqual([last.hashTargets, last.hashedFiles, last.bytesToHash, last.bytesHashed], [3, 3, 12, 12]);
  for (let i = 1; i < events.length; i++) assert.ok(events[i]!.bytesHashed >= events[i - 1]!.bytesHashed);
});
test('cancellation mid-scan rejects or returns a marked partial result; nothing changes on disk', async (t) => {
  const root = await fixture(t, { 'a/1.pdf': '1', 'b/2.pdf': '2', 'c/3.pdf': '3' });
  const before = await manifest(root);
  await assert.rejects(scanFolder(root, abortAt(2)), { name: 'AbortError' });
  await assert.rejects(analyzeFolder(root, abortAt(2)), (e: unknown) => isAfoError(e, 'CANCELLED'));
  const partial = await scanFolder(root, { ...abortAt(2), onAbort: 'partial' });
  assert.equal(partial.cancelled, true); assert.equal(partial.complete, false);
  assert.ok(partial.files.length < 3);
  const { preview } = await analyzeFolder(root, { ...abortAt(2), onAbort: 'partial' });
  assert.equal(preview.cancelled, true); assert.equal(preview.scanComplete, false);
  assert.deepEqual(await manifest(root), before);
});
test('cancellation during hashing stops every worker and leaves unhashed files without a hash', async (t) => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const root = await fixture(t, { 'a.bin': big, 'b.bin': big, 'c.bin': big, 'd.bin': big });
  const before = await manifest(root);
  const grant = await issueRootGrant(root);
  const scan = await scanRoot(grant);
  const abortAfterMiB = () => { const c = new AbortController();
    return { signal: c.signal, hashConcurrency: 2, onProgress: (p: ScanProgress) => { if (p.bytesHashed >= 1024 * 1024) c.abort(); } }; };
  await assert.rejects(hashCandidates(grant, scan, abortAfterMiB()), { name: 'AbortError' });
  const partial = await hashCandidates(grant, scan, { ...abortAfterMiB(), onAbort: 'partial' });
  assert.equal(partial.cancelled, true); assert.equal(partial.complete, false);
  assert.ok(partial.files.some((f) => f.sha256 === null));
  assert.ok(scan.files.every((f) => f.sha256 === null), 'input scan is not modified');
  assert.deepEqual(await manifest(root), before);
});
test('a file modified while being hashed is excluded alone and the result is marked incomplete', async (t) => {
  const big = Buffer.alloc(4 * 1024 * 1024, 1);
  const root = await fixture(t, { 'a-big1.bin': big, 'a-big2.bin': big, 'z-small1.txt': 'small', 'z-small2.txt': 'small' });
  let touched = false;
  const { preview } = await analyzeFolder(root, { hashConcurrency: 1, onProgress: (p) => {
    if (!touched && p.phase === 'hash' && p.bytesHashed > 0 && p.hashedFiles === 0) {
      touched = true; appendFileSync(path.join(root, 'a-big1.bin'), 'changed');
    }
  } });
  assert.ok(touched);
  assert.deepEqual(preview.skipped.map((s) => [s.relativePath, s.code]), [['a-big1.bin', 'FILE_CHANGED']]);
  assert.equal(preview.scanComplete, false);
  assert.deepEqual(preview.duplicates.map((d) => [d.suggestedKeep, d.candidates]), [['z-small1.txt', ['z-small2.txt']]]);
  assert.equal(preview.items.find((i) => i.source === 'a-big1.bin')!.action, 'review');
});
test('32 MiB files are hashed by streaming without loading them into memory', async (t) => {
  const root = await fixture(t);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31) & 0xff;
  for (const name of ['big-a.bin', 'big-b.bin']) {
    const handle = await open(path.join(root, name), 'wx');
    for (let i = 0; i < 32; i++) await handle.write(chunk);
    await handle.close();
  }
  const expected = createHash('sha256'); for (let i = 0; i < 32; i++) expected.update(chunk);
  const baseline = process.memoryUsage().arrayBuffers; let peak = baseline;
  const { preview } = await analyzeFolder(root, { onProgress: () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); } });
  assert.equal(preview.duplicates.length, 1);
  assert.equal(preview.duplicates[0]!.sha256, expected.digest('hex'));
  assert.equal(preview.duplicates[0]!.logicalCandidateBytes, 32 * 1024 * 1024);
  t.diagnostic(`arrayBuffers growth during hashing: ${((peak - baseline) / 1048576).toFixed(2)} MiB (2 x 32 MiB files)`);
  assert.ok(peak - baseline < 16 * 1024 * 1024, `memory grew by ${peak - baseline} bytes`);
});
test('same name with different content is not a duplicate; different names with the same content are', async (t) => {
  const root = await fixture(t, { 'a/report.pdf': 'version-1', 'b/report.pdf': 'version-2', 'x.jpg': 'pixels',
    '사진 복사본.jpg': 'pixels', 'empty1.txt': '', 'empty2.txt': '' });
  const { preview } = await analyzeFolder(root);
  assert.deepEqual(preview.duplicates.map((d) => [d.suggestedKeep, d.candidates]), [['x.jpg', ['사진 복사본.jpg']]]);
  assert.deepEqual(preview.duplicateNotes!.map((n) => [n.relativePath, n.code]), [['empty1.txt', 'EMPTY_FILE'], ['empty2.txt', 'EMPTY_FILE']]);
  assert.equal(preview.scanComplete, true);
});
test('analysis is deterministic regardless of hash concurrency', async (t) => {
  const { root } = await createFixture({ ...sampleSpec(), 'x/1.pdf': 'dup', 'y/2.pdf': 'dup', 'z/3.pdf': 'dup' }, t);
  const one = await analyzeFolder(root, { hashConcurrency: 1 });
  const many = await analyzeFolder(root, { hashConcurrency: 8 });
  assert.deepEqual(one, many);
  assert.equal(one.preview.classificationVersion, 'default-3');
});
test('reference reading returns names and extensions only and never opens files', async (t) => {
  const root = await fixture(t, { '과제/물리/물리_1.PDF': 'one', '과제/물리/물리_2.pdf': 'two', 'README': 'r', '.hidden': 'h' });
  const before = await manifest(root);
  // An unreadable reference file is still listed: its content is never opened.
  if (process.platform !== 'win32') await chmod(path.join(root, '과제/물리/물리_1.PDF'), 0);
  try {
    const reference = await readReference(await issueReferenceGrant(root));
    assert.equal(reference.mode, 'reference-metadata'); assert.equal(reference.complete, true);
    assert.deepEqual(reference.files, [{ relativePath: 'README', extension: null },
      { relativePath: '과제/물리/물리_1.PDF', extension: '.pdf' }, { relativePath: '과제/물리/물리_2.pdf', extension: '.pdf' }]);
    for (const f of reference.files) assert.deepEqual(Object.keys(f).sort(), ['extension', 'relativePath']);
    assert.deepEqual(reference.skipped.map((s) => s.code), ['HIDDEN']);
    assert.equal(suggestProfile(reference).rules.length, 1);
  } finally { if (process.platform !== 'win32') await chmod(path.join(root, '과제/물리/물리_1.PDF'), 0o600); }
  assert.deepEqual(await manifest(root), before);
});
test('overlapping roots: reference files inside the work root are protected, never hashed or candidates', async (t) => {
  const parent = await fixture(t, { 'ref/과제/a.pdf': 'same', 'ref/과제/b.pdf': 'other', 'ref/과제/copy.pdf': 'same', 'ref/top.pdf': 'same' });
  const ref = path.join(parent, 'ref'); const work = path.join(parent, 'ref', '과제');
  const before = await manifest(parent);
  // Work root inside the reference folder.
  const inside = await analyzeRoot(await issueRootGrant(work), { reference: await issueReferenceGrant(ref) });
  assert.deepEqual(inside.protected.map((p) => [p.relativePath, p.code]), [['a.pdf', 'REFERENCE_FILE'], ['b.pdf', 'REFERENCE_FILE'],
    ['copy.pdf', 'REFERENCE_FILE']]);
  assert.ok(inside.preview.items.every((i) => i.action === 'keep' && i.reasonCode === 'PROTECTED_REFERENCE'));
  assert.deepEqual(inside.preview.duplicates, []);
  // Reference folder inside the work root.
  const outer = await analyzeRoot(await issueRootGrant(ref), { reference: await issueReferenceGrant(work) });
  assert.deepEqual(outer.protected.map((p) => p.relativePath), ['과제/a.pdf', '과제/b.pdf', '과제/copy.pdf']);
  assert.deepEqual(outer.preview.duplicates, [], 'top.pdf has no unprotected partner; protected files are not read');
  assert.equal(outer.preview.items.find((i) => i.source === 'top.pdf')!.action, 'move');
  assert.deepEqual(await manifest(parent), before);
});
test('a root swapped during the scan is detected and the result refused', async (t) => {
  const parent = await fixture(t, { 'root/a/1.pdf': '1', 'root/b/2.pdf': '2' });
  const root = path.join(parent, 'root');
  const grant = await issueRootGrant(root);
  let swapped = false;
  await assert.rejects(scanRoot(grant, { onProgress: () => {
    if (!swapped) { swapped = true; renameSync(root, path.join(parent, 'old')); mkdirSync(root); }
  } }), (e: unknown) => isAfoError(e, 'FILE_CHANGED'));
});

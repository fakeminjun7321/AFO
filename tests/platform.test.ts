import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { classifyMoveState, deleteFilePermanently, fileIdentity, freeSpace, isTrashSupported, linkMoveNoClobber,
  moveToTrash, sameVolume } from '../packages/filesystem/src/platform.js';
import { scanFolder } from '../packages/filesystem/src/index.js';
import { fixture, manifest } from './helpers.js';

const sha = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
const code = (expected: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, expected); return true;
};
async function trySymlink(t: TestContext, target: string, at: string, type: 'file' | 'dir' | 'junction' = 'file'): Promise<boolean> {
  try { await symlink(target, at, type); return true; } catch (error) {
    if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') { t.skip('Windows symlink privilege missing'); return false; }
    throw error;
  }
}

test('link+unlink move keeps content and identity and leaves no source', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'payload', 'dest/.keep': '' });
  const src = path.join(root, 'a.pdf'); const dst = path.join(root, 'dest', 'a.pdf');
  const hash = await sha(src); const before = (await fileIdentity(src))!;
  const after = await linkMoveNoClobber(src, dst, before);
  assert.equal(await fileIdentity(src), null);
  assert.equal(await sha(dst), hash);
  assert.deepEqual([after.device, after.inode, after.nlink, after.kind], [before.device, before.inode, 1, 'file']);
});

test('existing destination is never overwritten and both files are preserved', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'new', 'dest/a.pdf': 'old' });
  const before = await manifest(root);
  await assert.rejects(linkMoveNoClobber(path.join(root, 'a.pdf'), path.join(root, 'dest', 'a.pdf')), code('DEST_EXISTS'));
  assert.deepEqual(await manifest(root), before);
});

test('move rejects links, hard links, changed files, missing or linked destination folders', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a', 'h.pdf': 'h', 'outside/x.pdf': 'x', 'dest/.keep': '' });
  await link(path.join(root, 'h.pdf'), path.join(root, 'h2.pdf'));
  if (!await trySymlink(t, path.join(root, 'a.pdf'), path.join(root, 'l.pdf'))) return;
  if (!await trySymlink(t, path.join(root, 'outside'), path.join(root, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  const before = await manifest(root);
  const a = path.join(root, 'a.pdf');
  await assert.rejects(linkMoveNoClobber(path.join(root, 'l.pdf'), path.join(root, 'dest', 'l.pdf')), code('LINK_REJECTED'));
  await assert.rejects(linkMoveNoClobber(path.join(root, 'h.pdf'), path.join(root, 'dest', 'h.pdf')), code('LINK_REJECTED'));
  await assert.rejects(linkMoveNoClobber(a, path.join(root, 'linkdir', 'a.pdf')), code('LINK_REJECTED'));
  await assert.rejects(linkMoveNoClobber(a, path.join(root, 'nope', 'a.pdf')), code('FILE_CHANGED'));
  await assert.rejects(linkMoveNoClobber(path.join(root, 'gone.pdf'), path.join(root, 'dest', 'g.pdf')), code('SOURCE_MISSING'));
  const id = (await fileIdentity(a))!;
  await assert.rejects(linkMoveNoClobber(a, path.join(root, 'dest', 'a.pdf'), { ...id, size: id.size + 1 }), code('FILE_CHANGED'));
  await assert.rejects(linkMoveNoClobber('relative.pdf', path.join(root, 'dest', 'r.pdf')), code('NOT_SUPPORTED'));
  assert.deepEqual(await manifest(root), before);
  assert.equal((await fileIdentity(path.join(root, 'l.pdf')))!.kind, 'symlink');
  assert.equal((await fileIdentity(path.join(root, 'h.pdf')))!.nlink, 2);
});

test('a different mounted volume is detected by device id and refused before any write', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a' });
  const candidates = process.platform === 'darwin' ? ['/System/Volumes/VM', '/System/Volumes/Preboot', '/dev']
    : process.platform === 'linux' ? ['/proc', '/dev', '/sys'] : [];
  let other: string | null = null;
  for (const dir of candidates) {
    try { if (!await sameVolume(root, dir)) { other = dir; break; } } catch { /* not present */ }
  }
  if (!other) { t.skip('no second volume visible to compare'); return; }
  const before = await manifest(root);
  await assert.rejects(linkMoveNoClobber(path.join(root, 'a.pdf'), path.join(other, `afo-test-${randomBytes(4).toString('hex')}`)),
    code('CROSS_VOLUME'));
  assert.deepEqual(await manifest(root), before);
  assert.equal(await sameVolume(root, path.join(root, 'a.pdf')), true);
  t.diagnostic(`compared against ${other}`);
});

test('interrupted move (link done, unlink not done) is classified, not repaired', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a', 'dest/.keep': '', 'dest/other.pdf': 'z' });
  const src = path.join(root, 'a.pdf'); const dst = path.join(root, 'dest', 'a.pdf');
  const id = (await fileIdentity(src))!;
  assert.equal(await classifyMoveState(src, dst, id), 'not-started');
  await link(src, dst);
  const before = await manifest(root);
  assert.equal(await classifyMoveState(src, dst, id), 'linked-both');
  assert.equal((await fileIdentity(src))!.nlink, 2);
  // A half-finished state must not be moved again by the adapter (nlink 2 is rejected).
  await assert.rejects(linkMoveNoClobber(src, path.join(root, 'dest', 'b.pdf')), code('LINK_REJECTED'));
  assert.deepEqual(await manifest(root), before);
  assert.equal(await classifyMoveState(src, path.join(root, 'dest', 'other.pdf'), id), 'conflict');
  assert.equal(await classifyMoveState(path.join(root, 'x'), path.join(root, 'y'), id), 'missing');
});

test('permanent delete removes only one regular file and records observed free space', async (t) => {
  const root = await fixture(t, { 'big.bin': 'x'.repeat(1 << 20), 'keep.pdf': 'keep', 'folder/inner.pdf': 'i', 'h.pdf': 'h' });
  await link(path.join(root, 'h.pdf'), path.join(root, 'h2.pdf'));
  if (!await trySymlink(t, path.join(root, 'keep.pdf'), path.join(root, 'l.pdf'))) return;
  const before = await manifest(root);
  await assert.rejects(deleteFilePermanently(path.join(root, 'folder')), code('NOT_SUPPORTED'));
  await assert.rejects(deleteFilePermanently(path.join(root, 'l.pdf')), code('LINK_REJECTED'));
  await assert.rejects(deleteFilePermanently(path.join(root, 'h.pdf')), code('LINK_REJECTED'));
  await assert.rejects(deleteFilePermanently(path.join(root, 'missing.pdf')), code('SOURCE_MISSING'));
  const big = path.join(root, 'big.bin'); const id = (await fileIdentity(big))!;
  await assert.rejects(deleteFilePermanently(big, { ...id, inode: '0' }), code('FILE_CHANGED'));
  assert.deepEqual(await manifest(root), before);
  const freeBefore = await freeSpace(root);
  await deleteFilePermanently(big, id);
  const freeAfter = await freeSpace(root);
  assert.equal(await fileIdentity(big), null);
  const expected = { ...before }; delete expected['big.bin'];
  assert.deepEqual(await manifest(root), expected);
  assert.equal(typeof freeBefore, 'number'); assert.equal(typeof freeAfter, 'number');
  t.diagnostic(`statfs bavail*bsize before=${freeBefore} after=${freeAfter} delta=${freeAfter! - freeBefore!} (other processes affect this)`);
});

test('free space is null when not observable', async (t) => {
  const root = await fixture(t);
  assert.ok((await freeSpace(root))! > 0);
  assert.equal(await freeSpace(path.join(root, 'missing')), null);
  assert.equal(await freeSpace('relative'), null);
});

test('OS trash moves one synthetic file and touches nothing else', async (t) => {
  if (!await isTrashSupported()) { t.skip(`${process.platform}: NOT_SUPPORTED`); return; }
  if (process.env['AFO_REAL_TRASH_TEST'] !== '1') { t.skip('실제 OS 휴지통 검사는 AFO_REAL_TRASH_TEST=1에서만 실행'); return; }
  const root = await fixture(t, { 'keep.pdf': 'keep', 'folder/inner.pdf': 'i' });
  const name = `afo-test-trash-${randomBytes(6).toString('hex')}.txt`;
  const target = path.join(root, name);
  await writeFile(target, 'synthetic trash fixture');
  if (!await trySymlink(t, path.join(root, 'keep.pdf'), path.join(root, 'l.pdf'))) return;
  const before = await manifest(root);
  await assert.rejects(moveToTrash(path.join(root, 'l.pdf')), code('LINK_REJECTED'));
  await assert.rejects(moveToTrash(path.join(root, 'folder')), code('NOT_SUPPORTED'));
  await assert.rejects(moveToTrash(path.join(root, 'missing.txt')), code('SOURCE_MISSING'));
  assert.deepEqual(await manifest(root), before);
  await moveToTrash(target);
  assert.equal(await fileIdentity(target), null);
  const expected = { ...before }; delete expected[name];
  assert.deepEqual(await manifest(root), expected);
  t.diagnostic(`trashed ${name} via ${process.platform === 'darwin' ? '/usr/bin/trash' : 'PowerShell SendToRecycleBin'}`);
});

test('measurement: scanFolder over 1,000 small synthetic files (one run, this machine only)', async (t) => {
  const root = await fixture(t);
  for (let d = 0; d < 10; d += 1) {
    await mkdir(path.join(root, `d${d}`));
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(root, `d${d}`, `f${i}.txt`), `file ${d}-${i}`)));
  }
  const started = performance.now();
  const scan = await scanFolder(root);
  const ms = performance.now() - started;
  assert.equal(scan.files.length, 1000);
  assert.equal(scan.complete, true);
  assert.ok((await lstat(root)).isDirectory());
  t.diagnostic(`scanFolder 1000 files: ${ms.toFixed(1)} ms, rss ${(process.memoryUsage().rss / 1048576).toFixed(1)} MiB, ` +
    `node ${process.version} ${process.platform}/${process.arch}`);
});

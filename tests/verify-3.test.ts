// Verifier tests for #3 (OS file-operation adapter). Independent of tests/platform.test.ts.
// Real OS calls on synthetic mkdtemp folders only. The real trash case runs only with AFO_REAL_TRASH_TEST=1.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { deleteFilePermanently, fileIdentity, freeSpace, linkMoveNoClobber, moveToTrash, sameVolume, isTrashSupported }
  from '../packages/filesystem/src/platform.js';

type Entry = { type: 'file'; size: string; mtimeNs: string; dev: string; ino: string; nlink: string; sha256: string }
  | { type: 'dir' } | { type: 'link'; target: string } | { type: 'other' };

/** Verifier's own oracle: never follows links, never opens non-regular files. */
async function snap(root: string): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name); const rel = prefix ? `${prefix}/${name}` : name;
      const s = await lstat(full, { bigint: true });
      if (s.isSymbolicLink()) out[rel] = { type: 'link', target: await readlink(full) };
      else if (s.isDirectory()) { out[rel] = { type: 'dir' }; await walk(full, rel); }
      else if (s.isFile()) out[rel] = { type: 'file', size: String(s.size), mtimeNs: String(s.mtimeNs), dev: String(s.dev),
        ino: String(s.ino), nlink: String(s.nlink), sha256: createHash('sha256').update(await readFile(full)).digest('hex') };
      else out[rel] = { type: 'other' };
    }
  }
  await walk(root, '');
  return out;
}
async function synth(t: TestContext, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'afo-test-v3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), data);
  }
  return root;
}
const rejectsWith = async (p: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(p, (e: unknown) => { assert.equal((e as { code?: string }).code, code, String(e)); return true; });
};
const renamed = (m: Record<string, Entry>, from: string, to: string): Record<string, Entry> => {
  const copy = { ...m }; copy[to] = copy[from]!; delete copy[from]; return copy;
};
async function caseInsensitive(root: string): Promise<boolean> {
  await writeFile(path.join(root, 'probe-case'), '');
  const yes = await lstat(path.join(root, 'PROBE-CASE')).then(() => true, () => false);
  await rm(path.join(root, 'probe-case'));
  return yes;
}

test('V3-01 relative or empty paths are rejected by every adapter entry point and nothing is created', async (t) => {
  const root = await synth(t, { 'a.txt': 'a', 'dest/.keep': '' });
  const rel = `afo-test-rel-${randomBytes(4).toString('hex')}.txt`;
  const before = await snap(root);
  const a = path.join(root, 'a.txt');
  await rejectsWith(linkMoveNoClobber(rel, path.join(root, 'dest', 'x.txt')), 'NOT_SUPPORTED');
  await rejectsWith(linkMoveNoClobber(a, rel), 'NOT_SUPPORTED');
  await rejectsWith(linkMoveNoClobber(a, `dest/${rel}`), 'NOT_SUPPORTED');
  await rejectsWith(linkMoveNoClobber('', path.join(root, 'dest', 'x.txt')), 'NOT_SUPPORTED');
  await rejectsWith(moveToTrash(rel), 'NOT_SUPPORTED');
  await rejectsWith(moveToTrash(''), 'NOT_SUPPORTED');
  await rejectsWith(deleteFilePermanently(rel), 'NOT_SUPPORTED');
  await rejectsWith(deleteFilePermanently('./a.txt'), 'NOT_SUPPORTED');
  await rejectsWith(fileIdentity(rel), 'NOT_SUPPORTED');
  await rejectsWith(sameVolume(rel, root), 'NOT_SUPPORTED');
  assert.deepEqual(await snap(root), before);
  assert.equal(await lstat(path.resolve(rel)).then(() => true, () => false), false, 'nothing created under cwd');
});

test('V3-02 existing destination file, folder, same path and dangling link are never overwritten', async (t) => {
  const root = await synth(t, { 'a.txt': 'new-content', 'dest/a.txt': 'old-content', 'dest/dir/inner.txt': 'inner' });
  await symlink(path.join(root, 'nowhere.txt'), path.join(root, 'dest', 'dangling.txt'));
  const before = await snap(root);
  const a = path.join(root, 'a.txt');
  await rejectsWith(linkMoveNoClobber(a, path.join(root, 'dest', 'a.txt')), 'DEST_EXISTS');
  await rejectsWith(linkMoveNoClobber(a, path.join(root, 'dest', 'dir')), 'DEST_EXISTS');
  await rejectsWith(linkMoveNoClobber(a, a), 'DEST_EXISTS');
  await rejectsWith(linkMoveNoClobber(a, path.join(root, 'dest', 'dangling.txt')), 'DEST_EXISTS');
  assert.deepEqual(await snap(root), before);
  assert.equal(await lstat(path.join(root, 'nowhere.txt')).then(() => true, () => false), false, 'link target not created');
});

test('V3-03 case-only collisions are refused; Unicode-normalization collisions follow the platform and never overwrite', async (t) => {
  const root = await synth(t, { 'Report.txt': 'src', 'dest/report.txt': 'existing', 'dest/.keep': '' });
  const nfc = '보고서 😀.txt'.normalize('NFC'); const nfd = nfc.normalize('NFD');
  await writeFile(path.join(root, nfc), 'src-nfc');
  await writeFile(path.join(root, 'dest', nfd), 'existing-nfd');
  if (!await caseInsensitive(root)) { t.skip('tmpdir filesystem is case-sensitive; collision not applicable'); return; }
  const before = await snap(root);
  await rejectsWith(linkMoveNoClobber(path.join(root, 'Report.txt'), path.join(root, 'dest', 'REPORT.TXT')), 'DEST_EXISTS');
  await rejectsWith(linkMoveNoClobber(path.join(root, 'Report.txt'), path.join(root, 'report.txt')), 'DEST_EXISTS');
  assert.deepEqual(await snap(root), before);
  if (process.platform === 'win32') {
    // NTFS ignores case but distinguishes NFC/NFD: both names must coexist and nothing is overwritten.
    await linkMoveNoClobber(path.join(root, nfc), path.join(root, 'dest', nfc));
    const after = await snap(root);
    assert.deepEqual(after, renamed(before, nfc, `dest/${nfc}`));
    assert.deepEqual(after[`dest/${nfd}`], before[`dest/${nfd}`], 'existing NFD file untouched');
    assert.equal((await readdir(path.join(root, 'dest'))).filter((n) => n.normalize('NFC') === nfc).length, 2);
    t.diagnostic('win32: case-insensitive, normalization-sensitive; NFC and NFD names coexist, hashes preserved');
  } else {
    await rejectsWith(linkMoveNoClobber(path.join(root, nfc), path.join(root, 'dest', nfc)), 'DEST_EXISTS');
    assert.deepEqual(await snap(root), before);
    t.diagnostic(`${process.platform}: case-insensitive + normalization-insensitive lookup; existing hashes preserved`);
  }
});

test('V3-04 destination parent that is a symlink (inside or outside) or a file is refused', async (t) => {
  const root = await synth(t, { 'a.txt': 'a', 'inside/.keep': '', 'outside/.keep': '', 'plain.txt': 'p' });
  await symlink(path.join(root, 'inside'), path.join(root, 'to-inside'));
  await symlink(path.join(root, 'outside'), path.join(root, 'to-outside'));
  await symlink('outside', path.join(root, 'to-outside-rel'));
  const before = await snap(root);
  const a = path.join(root, 'a.txt');
  for (const parent of ['to-inside', 'to-outside', 'to-outside-rel'])
    await rejectsWith(linkMoveNoClobber(a, path.join(root, parent, 'a.txt')), 'LINK_REJECTED');
  await rejectsWith(linkMoveNoClobber(a, path.join(root, 'plain.txt', 'a.txt')), 'LINK_REJECTED');
  assert.deepEqual(await snap(root), before);
});

test('V3-05 source symlink, dir symlink, hard link, folder and FIFO are refused; nothing changes', async (t) => {
  const root = await synth(t, { 'f.txt': 'f', 'h.txt': 'h', 'folder/in.txt': 'i', 'dest/.keep': '' });
  await symlink(path.join(root, 'f.txt'), path.join(root, 'ln.txt'));
  await symlink(path.join(root, 'folder'), path.join(root, 'ln-dir'));
  await link(path.join(root, 'h.txt'), path.join(root, 'h-twin.txt'));
  const fifoSkip = process.platform === 'win32' ? 'win32: POSIX FIFO(mkfifo) 없음 - FIFO 사례만 건너뜀' : false;
  if (!fifoSkip) execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe')]);
  const before = await snap(root);
  const to = (n: string): string => path.join(root, 'dest', n);
  await rejectsWith(linkMoveNoClobber(path.join(root, 'ln.txt'), to('ln.txt')), 'LINK_REJECTED');
  await rejectsWith(linkMoveNoClobber(path.join(root, 'ln-dir'), to('ln-dir')), 'LINK_REJECTED');
  await rejectsWith(linkMoveNoClobber(path.join(root, 'h.txt'), to('h.txt')), 'LINK_REJECTED');
  await rejectsWith(linkMoveNoClobber(path.join(root, 'h-twin.txt'), to('h-twin.txt')), 'LINK_REJECTED');
  await rejectsWith(linkMoveNoClobber(path.join(root, 'folder'), to('folder')), 'NOT_SUPPORTED');
  await t.test('FIFO source is refused', { skip: fifoSkip }, async () => {
    await rejectsWith(linkMoveNoClobber(path.join(root, 'pipe'), to('pipe')), 'NOT_SUPPORTED');
  });
  assert.deepEqual(await snap(root), before);
  assert.deepEqual(before['h.txt'] && before['h.txt'].type === 'file' ? before['h.txt'].nlink : null, '2');
});

test('V3-06 expected mismatch after size, mtime or inode change gives FILE_CHANGED for move and delete (trash is not invoked here)', async (t) => {
  const root = await synth(t, { 's.txt': 'same-size', 'm.txt': 'mtime', 'r.txt': 'replaced', 'dest/.keep': '' });
  const s = path.join(root, 's.txt'); const m = path.join(root, 'm.txt'); const r = path.join(root, 'r.txt');
  const [sId, mId, rId] = [(await fileIdentity(s))!, (await fileIdentity(m))!, (await fileIdentity(r))!];
  await writeFile(s, 'same-size-but-longer');
  await utimes(m, new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));
  const keepR = path.join(root, 'r-hold.txt'); await link(r, keepR); await rm(r); await writeFile(r, 'replaced'); await rm(keepR);
  assert.notEqual((await fileIdentity(m))!.modifiedNs, mId.modifiedNs);
  assert.equal((await fileIdentity(m))!.size, mId.size);
  assert.notEqual((await fileIdentity(r))!.inode, rId.inode, 'replacement got a new inode');
  const before = await snap(root);
  for (const [file, id] of [[s, sId], [m, mId], [r, rId]] as const) {
    await rejectsWith(linkMoveNoClobber(file, path.join(root, 'dest', path.basename(file)), id), 'FILE_CHANGED');
    await rejectsWith(deleteFilePermanently(file, id), 'FILE_CHANGED');
  }
  assert.deepEqual(await snap(root), before);
});

test('V3-07 successful move preserves dev/ino/size/mtime/sha256, removes source, nlink 1, nothing else changes', async (t) => {
  const root = await synth(t, { 'doc.pdf': randomBytes(4096).toString('hex'), 'other.txt': 'o', 'dest/.keep': '' });
  const src = path.join(root, 'doc.pdf'); const dst = path.join(root, 'dest', 'doc.pdf');
  const before = await snap(root); const id = (await fileIdentity(src))!;
  const after = await linkMoveNoClobber(src, dst, id);
  assert.equal(await lstat(src).then(() => true, () => false), false);
  assert.deepEqual([after.kind, after.device, after.inode, after.size, after.modifiedNs, after.nlink],
    ['file', id.device, id.inode, id.size, id.modifiedNs, 1]);
  assert.deepEqual(await snap(root), renamed(before, 'doc.pdf', 'dest/doc.pdf'));
});

test('V3-08 Korean/space/emoji names in NFC and NFD move with content intact', async (t) => {
  const nfc = '한글 파일 😀 v2.txt'.normalize('NFC'); const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  const root = await synth(t, { [`a/${nfc}`]: 'nfc-body', [`b/${nfd}`]: 'nfd-body', 'dest-a/.keep': '', 'dest-b/.keep': '' });
  const before = await snap(root);
  const storedA = (await readdir(path.join(root, 'a')))[0]!; const storedB = (await readdir(path.join(root, 'b')))[0]!;
  await linkMoveNoClobber(path.join(root, 'a', nfc), path.join(root, 'dest-a', nfc));
  await linkMoveNoClobber(path.join(root, 'b', nfd), path.join(root, 'dest-b', nfd));
  const after = await snap(root);
  assert.deepEqual(after, renamed(renamed(before, `a/${storedA}`, `dest-a/${nfc}`), `b/${storedB}`, `dest-b/${nfd}`));
  assert.deepEqual(await readdir(path.join(root, 'a')), []); assert.deepEqual(await readdir(path.join(root, 'b')), []);
  t.diagnostic(`readdir preserved form: a=${storedA === nfc ? 'NFC' : 'other'} b=${storedB === nfd ? 'NFD' : 'other'}`);
});

test('V3-09 deleteFilePermanently refuses folders and links and keeps link targets; deletes only the named file', async (t) => {
  const root = await synth(t, { 'target.txt': 'target-data', 'folder/in.txt': 'i', 'empty/.keep': '', 'h.txt': 'h',
    'victim.txt': 'v', 'sibling.txt': 's' });
  await rm(path.join(root, 'empty', '.keep'));
  await symlink(path.join(root, 'target.txt'), path.join(root, 'ln.txt'));
  await symlink(path.join(root, 'folder'), path.join(root, 'ln-dir'));
  await symlink(path.join(root, 'gone.txt'), path.join(root, 'dangling'));
  await link(path.join(root, 'h.txt'), path.join(root, 'h-twin.txt'));
  const before = await snap(root);
  await rejectsWith(deleteFilePermanently(path.join(root, 'folder')), 'NOT_SUPPORTED');
  await rejectsWith(deleteFilePermanently(path.join(root, 'empty')), 'NOT_SUPPORTED');
  await rejectsWith(deleteFilePermanently(path.join(root, 'ln.txt')), 'LINK_REJECTED');
  await rejectsWith(deleteFilePermanently(path.join(root, 'ln-dir')), 'LINK_REJECTED');
  await rejectsWith(deleteFilePermanently(path.join(root, 'dangling')), 'LINK_REJECTED');
  await rejectsWith(deleteFilePermanently(path.join(root, 'h-twin.txt')), 'LINK_REJECTED');
  await rejectsWith(deleteFilePermanently(path.join(root, 'nope.txt')), 'SOURCE_MISSING');
  assert.deepEqual(await snap(root), before);
  const id = (await fileIdentity(path.join(root, 'victim.txt')))!;
  await deleteFilePermanently(path.join(root, 'victim.txt'), id);
  const expected = { ...before }; delete expected['victim.txt'];
  assert.deepEqual(await snap(root), expected);
});

test('V3-10 freeSpace is a non-negative safe integer or null', async (t) => {
  const root = await synth(t, { 'f.txt': 'f' });
  for (const p of [root, path.join(root, 'f.txt')]) {
    const v = await freeSpace(p);
    assert.equal(typeof v, 'number'); assert.ok(Number.isSafeInteger(v) && v! >= 0, String(v));
  }
  for (const p of [path.join(root, 'missing'), 'relative', '']) assert.equal(await freeSpace(p), null);
});

test('V3-11 documented limit: a link in a grandparent of the destination is not caught by the adapter', async (t) => {
  // ADR decision 3 says the service's realpath/parent checks must cover this. Observe only; data must not be lost.
  const root = await synth(t, { 'work/a.txt': 'payload', 'elsewhere/sub/.keep': '' });
  await symlink(path.join(root, 'elsewhere'), path.join(root, 'work', 'hop'));
  const before = await snap(root);
  const sha = (before['work/a.txt'] as { sha256: string }).sha256;
  const outcome = await linkMoveNoClobber(path.join(root, 'work', 'a.txt'), path.join(root, 'work', 'hop', 'sub', 'a.txt'))
    .then(() => 'moved-through-link', (e: { code?: string }) => `rejected:${e.code}`);
  const after = await snap(root);
  const copies = Object.values(after).filter((e) => e.type === 'file' && e.sha256 === sha);
  assert.equal(copies.length, 1, 'exactly one copy of the content remains');
  t.diagnostic(`grandparent-link destination outcome: ${outcome}`);
});

test('V3-12 real OS trash: one synthetic file only; siblings kept; missing path and folder are refused', async (t) => {
  if (process.env['AFO_REAL_TRASH_TEST'] !== '1') { t.skip('AFO_REAL_TRASH_TEST=1 이 아니므로 실제 휴지통 검사를 건너뜀'); return; }
  if (!await isTrashSupported()) { t.skip(`${process.platform}: NOT_SUPPORTED`); return; }
  const name = `afo-test-verify3-${randomBytes(6).toString('hex')}.txt`;
  const root = await synth(t, { [name]: 'synthetic verify-3 trash fixture', 'sibling-a.txt': 'a', 'folder/in.txt': 'i' });
  await symlink(path.join(root, 'sibling-a.txt'), path.join(root, 'ln.txt'));
  const before = await snap(root);
  await rejectsWith(moveToTrash(path.join(root, 'missing-afo-test.txt')), 'SOURCE_MISSING');
  await rejectsWith(moveToTrash(path.join(root, 'folder')), 'NOT_SUPPORTED');
  await rejectsWith(moveToTrash(path.join(root, 'ln.txt')), 'LINK_REJECTED');
  assert.deepEqual(await snap(root), before, 'refusals changed nothing');
  const id = (await fileIdentity(path.join(root, name)))!;
  await moveToTrash(path.join(root, name), id);
  const expected = { ...before }; delete expected[name];
  assert.deepEqual(await snap(root), expected);
  const inTrash = process.platform === 'win32' ? 'Recycle Bin 내부 관측 안 함'
    : await lstat(path.join(homedir(), '.Trash', name), { bigint: true }).then(
      (s) => `~/.Trash/<name> present size=${s.size}`, (e: { code?: string }) => `~/.Trash/<name> not observable (${e.code})`);
  t.diagnostic(`trashed 1 synthetic file ${name}; ${inTrash}`);
});

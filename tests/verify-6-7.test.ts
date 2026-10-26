/**
 * #6/#7 verifier tests (independent of the builder's tests). Synthetic temp data only (mkdtemp under os.tmpdir()).
 * Expected values below are written by hand; the product's extension table and skip-code list are not imported to build them.
 * A fake HOME (a temp folder) is used for home-folder cases so no real user folder is listed.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, link, lstat, open, readdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAfoError, PreviewSchema, ScanProgressSchema } from '../packages/contracts/src/index.js';
import type { Preview, RuleProfile, ScanProgress, ScanResult, SkippedEntry } from '../packages/contracts/src/index.js';
import { analyzeRoot, currentSessionId, hashCandidates, issueReferenceGrant, issueRootGrant, readReference, scanRoot,
  verifyGrant } from '../packages/filesystem/src/index.js';
import { buildPreview, chooseKeeper, classifyFile, confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { skipCodeDescriptions } from '../packages/contracts/src/index.js';
import { createFixture } from './fixtures/index.js';
import type { FixtureSpec } from './fixtures/index.js';

const run = promisify(execFile);
const posix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const code = (expected: string) => (error: unknown): boolean => isAfoError(error) && error.code === expected;
const sorted = (values: string[]): string[] => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const paths = (items: { relativePath: string }[]): string[] => sorted(items.map((f) => f.relativePath));
const skipMap = (skipped: SkippedEntry[]): Record<string, string | undefined> =>
  Object.fromEntries(skipped.map((s) => [s.relativePath, s.code]));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Fixture whose cleanup first restores permissions and immutable flags (chmod 000 / chflags uchg cases). */
async function make(t: TestContext, spec: FixtureSpec = {}): Promise<string> {
  const { root, cleanup } = await createFixture(spec);
  t.after(async () => {
    if (posix) {
      if (process.platform === 'darwin') await run('/usr/bin/chflags', ['-R', 'nouchg', root]).catch(() => undefined);
      await run('/bin/chmod', ['-R', 'u+rwX', root]).catch(() => undefined);
    }
    await cleanup();
  });
  return root;
}

/**
 * Independent oracle: every entry (hidden/excluded included) with mode, inode, link count, size, mtime, ctime and content hash.
 * atime is deliberately left out. Never follows links and never opens non-regular files.
 */
async function oracle(root: string): Promise<Record<string, string>> {
  const out: [string, string][] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    let names: string[];
    try { names = (await readdir(dir)).sort(); } catch (error) { out.push([`${prefix}/*`, `unreadable:${String((error as NodeJS.ErrnoException).code)}`]); return; }
    for (const name of names) {
      const full = path.join(dir, name); const rel = prefix ? `${prefix}/${name}` : name;
      const s = await lstat(full, { bigint: true });
      const base = `${s.mode}:${s.ino}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      if (s.isSymbolicLink()) out.push([rel, `link:${await readlink(full)}:${base}`]);
      else if (s.isDirectory()) { out.push([rel, `dir:${base}`]); await visit(full, rel); }
      else if (s.isFile()) {
        let h = 'unreadable';
        try { h = sha(await readFile(full)); } catch { /* chmod 000 */ }
        out.push([rel, `file:${base}:${h}`]);
      } else out.push([rel, `other:${base}`]);
    }
  }
  await visit(root, '');
  return Object.fromEntries(out);
}

/** Every skipped entry must carry a known machine code, a Korean reason and a Korean user-facing description. */
function assertExplained(skipped: SkippedEntry[]): void {
  for (const s of skipped) {
    assert.ok(s.code !== undefined, `${s.relativePath}: no code`);
    const description = (skipCodeDescriptions as Record<string, string | undefined>)[s.code];
    assert.ok(description !== undefined && /[가-힣]/u.test(description), `${s.relativePath}: no Korean description for ${s.code}`);
    assert.ok(/[가-힣]/u.test(s.reason), `${s.relativePath}: reason is not Korean`);
  }
}

/** Keeper invariant: every duplicate group keeps one existing member that is never a candidate. */
function assertKeeper(preview: Preview, protectedPaths: string[] = []): void {
  const prot = new Set(protectedPaths.map((p) => p.normalize('NFC').toLowerCase()));
  for (const g of preview.duplicates) {
    const members = (g.members ?? []).map((m) => m.relativePath);
    assert.ok(members.includes(g.suggestedKeep), 'keeper is a member');
    assert.ok(!g.candidates.includes(g.suggestedKeep), 'keeper is not a candidate');
    assert.ok(g.candidates.every((c) => members.includes(c)), 'candidates are members');
    assert.ok(g.candidates.length <= members.length - 1, 'at least one member stays');
    assert.ok(g.candidates.every((c) => !prot.has(c.normalize('NFC').toLowerCase())), 'protected never a candidate');
  }
}

async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env['HOME'];
  process.env['HOME'] = home;
  try { return await body(); } finally { if (saved === undefined) delete process.env['HOME']; else process.env['HOME'] = saved; }
}

/* ======================================================================= #6 roots and grants */

test('V67-R1 refused roots: fake home, its Library and projects, disk root, OS folders, bundles, projects, links, files, Win32 device paths', async (t) => {
  const root = await make(t, { 'home/.git/HEAD': 'ref', 'home/Library/Prefs/p.plist': 'p', 'home/Docs/a.pdf': 'a',
    'home/Proj/package.json': '{}', 'home/Proj/src/x.ts': 'x', 'Viewer.app/Contents/Resources/r.txt': 'r', 'Kit.FRAMEWORK/v/a.txt': 'a',
    'repo/.git/HEAD': 'h', 'repo/notes/n.txt': 'n', 'swift/Package.swift': 's', 'swift/Sources/a.swift': 'a', 'plain/a.pdf': 'a',
    'real/a.pdf': 'a', 'file.pdf': 'f' });
  await symlink(path.join(root, 'real'), path.join(root, 'dir-link'));
  const home = path.join(root, 'home');
  const before = await oracle(root);
  await withHome(home, async () => {
    const refused: string[] = [home, path.join(home, 'Library'), path.join(home, 'Library/Prefs'), path.join(home, 'Proj'),
      path.join(home, 'Proj/src'), '/', path.join(root, 'Viewer.app'), path.join(root, 'Viewer.app/Contents/Resources'),
      path.join(root, 'Kit.FRAMEWORK/v'), path.join(root, 'repo'), path.join(root, 'repo/notes'), path.join(root, 'swift/Sources'),
      path.join(root, 'dir-link'), `${path.join(root, 'dir-link')}/`, path.join(root, 'file.pdf'), path.join(root, 'missing'),
      '\\\\?\\C:\\Users\\x', '\\\\.\\PhysicalDrive0', `\\\\?\\${path.join(root, 'plain')}`, '', 'a\u0000b'];
    if (process.platform === 'darwin') refused.push('/System', '/System/Library', '/usr/bin', '/Library', '/private/var', '/Users',
      '/Volumes', '/tmp', '/private/tmp', '/Applications');
    for (const target of refused) {
      await assert.rejects(issueRootGrant(target), (e: unknown) => isAfoError(e), `work ${JSON.stringify(target)}`);
      await assert.rejects(issueReferenceGrant(target), (e: unknown) => isAfoError(e), `reference ${JSON.stringify(target)}`);
    }
    // A dotfiles repository in home must not block ordinary folders in home; a plain temp folder is allowed.
    assert.equal((await issueRootGrant(path.join(home, 'Docs'))).canonicalPath, path.join(home, 'Docs'));
    assert.equal((await issueRootGrant(path.join(root, 'plain'))).scope, 'work');
  });
  assert.deepEqual(await oracle(root), before, 'issuing/refusing grants changed nothing');
});

test('V67-R2 non-normalized input "<root>/a/../b" is refused at grant issue (CARRYOVER #6)',
  { todo: 'DEFECT V67-1: issueRootGrant accepts and canonicalizes ".." input (see docs/verification/ISSUE_6_7.md)' }, async (t) => {
  const root = await make(t, { 'a/x.pdf': 'x', 'b/y.pdf': 'y' });
  const input = `${root}/a/../b`;
  const result = await issueRootGrant(input).then((g) => g, (e: unknown) => e);
  if (!isAfoError(result)) t.diagnostic(`accepted: canonicalPath=${path.relative(root, (result as { canonicalPath: string }).canonicalPath)}`);
  assert.ok(isAfoError(result), 'non-normalized ".." input was accepted (canonicalized) instead of refused');
});

test('V67-R3 an issued grant always describes the folder at its canonicalPath (".." after a link component)',
  { todo: 'DEFECT V67-2: lstat(path.resolve(input)) vs realpath(input) describe different folders' }, async (t) => {
  // <root>/via -> <root>/deep/x. Lexically "via/../target" is <root>/target; physically it is <root>/deep/target.
  const root = await make(t, { 'deep/x/': '', 'deep/target/p.pdf': 'physical', 'target/l.pdf': 'lexical' });
  await symlink(path.join(root, 'deep/x'), path.join(root, 'via'));
  const result = await issueRootGrant(`${root}/via/../target`).then((g) => g, (e: unknown) => e);
  if (isAfoError(result)) { t.diagnostic(`refused at issue: ${result.code}`); return; }
  const grant = result as Awaited<ReturnType<typeof issueRootGrant>>;
  const s = await lstat(grant.canonicalPath, { bigint: true });
  t.diagnostic(`canonicalPath=${path.relative(root, grant.canonicalPath)}`);
  assert.deepEqual([grant.device, grant.inode], [String(s.dev), String(s.ino)],
    'grant dev/inode belong to a different folder than canonicalPath');
  await verifyGrant(grant, 'work');
});

test('V67-R3b the same ".." trick never yields a grant whose canonicalPath is a file',
  { todo: 'DEFECT V67-2: same root cause; grant issued for a file path (fails closed at verifyGrant)' }, async (t) => {
  // Lexically "via/../ft" is the folder <root>/ft; physically it is the file <root>/deep/ft.
  const root = await make(t, { 'deep/x/': '', 'deep/ft': 'a file', 'ft/': '' });
  await symlink(path.join(root, 'deep/x'), path.join(root, 'via'));
  const result = await issueRootGrant(`${root}/via/../ft`).then((g) => g, (e: unknown) => e);
  if (isAfoError(result)) return;
  const grant = result as Awaited<ReturnType<typeof issueRootGrant>>;
  const s = await lstat(grant.canonicalPath);
  t.diagnostic(`issued grant canonicalPath=${path.relative(root, grant.canonicalPath)} isFile=${s.isFile()}`);
  assert.ok(s.isDirectory(), 'a grant was issued for a regular file');
});

test('V67-R4 dev/inode replacement, link replacement and swap during a scan are refused', async (t) => {
  const parent = await make(t, { 'root/a/1.pdf': '1', 'root/b/2.pdf': '2', 'other/z.pdf': 'z' });
  const root = path.join(parent, 'root');
  const grant = await issueRootGrant(root);
  const reference = await issueReferenceGrant(root);
  await rename(root, path.join(parent, 'away'));
  await rename(path.join(parent, 'other'), root); // different folder, same path
  await assert.rejects(verifyGrant(grant, 'work'), code('FILE_CHANGED'));
  await assert.rejects(scanRoot(grant), code('FILE_CHANGED'));
  await assert.rejects(readReference(reference), code('FILE_CHANGED'));
  await rename(root, path.join(parent, 'other'));
  await symlink(path.join(parent, 'away'), root); // a link to the original folder (same dev/inode behind it)
  await assert.rejects(verifyGrant(grant, 'work'), code('FILE_CHANGED'));
  rmSync(root); await rename(path.join(parent, 'away'), root);
  assert.equal((await verifyGrant(grant, 'work')).id, grant.id, 'moving the original back restores the identity');
  // Swap while hashing (not while walking): the hash pass must refuse too.
  const scan = await scanRoot(grant);
  let swapped = false;
  await assert.rejects(hashCandidates(grant, scan, { onProgress: () => {
    if (!swapped) { swapped = true; renameSync(root, path.join(parent, 'gone')); mkdirSync(root); }
  } }), (e: unknown) => isAfoError(e));
  assert.ok(swapped);
});

test('V67-R5 scope, session, cross-process and forged grants (including a recomputed id) are refused', async (t) => {
  const root = await make(t, { 'a.pdf': 'a' });
  const work = await issueRootGrant(root); const reference = await issueReferenceGrant(root);
  await assert.rejects(scanRoot(reference as never), code('ROOT_FORBIDDEN'));
  await assert.rejects(readReference(work as never), code('ROOT_FORBIDDEN'));
  await assert.rejects(hashCandidates(reference as never, await scanRoot(work)), code('ROOT_FORBIDDEN'));
  await assert.rejects(analyzeRoot(work, { reference: work as never }), code('ROOT_FORBIDDEN'));
  await assert.rejects(verifyGrant({ ...reference, scope: 'work', readOnly: undefined } as never, 'work'), code('ROOT_FORBIDDEN'));
  // Session binding.
  const otherSession = await issueRootGrant(root, { sessionId: 'session-b-0000' });
  await assert.rejects(verifyGrant(otherSession, 'work', { sessionId: currentSessionId() }), code('ROOT_FORBIDDEN'));
  await assert.rejects(verifyGrant(work, 'work', { sessionId: 'session-b-0000' }), code('ROOT_FORBIDDEN'));
  // Forgery: correct dev/inode/path built by hand, any id; and one field edited with the id kept.
  const s = await lstat(root, { bigint: true });
  const fields = { formatVersion: 1 as const, canonicalPath: root, device: String(s.dev), inode: String(s.ino),
    sessionId: currentSessionId(), issuedAt: work.issuedAt };
  const recomputed = sha(JSON.stringify(['work', fields]));
  for (const forged of [{ ...fields, id: recomputed, scope: 'work' as const }, { ...fields, id: randomBytes(32).toString('hex'), scope: 'work' as const },
    { ...work, issuedAt: new Date(0).toISOString() }, { ...work, sessionId: 'session-c-0000' }, { ...work, inode: String(s.ino + 1n) },
    { ...work, id: work.id.toUpperCase() }, { ...work, extra: true }, JSON.parse(JSON.stringify(work).replace('"work"', '"reference"'))]) {
    await assert.rejects(scanRoot(forged as never), code('ROOT_FORBIDDEN'), JSON.stringify(Object.keys(forged)));
  }
  // A grant issued by another process (another session) is not valid here.
  const entry = fileURLToPath(new URL('../packages/filesystem/src/index.js', import.meta.url));
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e',
    'const m = await import(process.argv[1]); console.log(JSON.stringify(await m.issueRootGrant(process.argv[2])));', entry, root]);
  const foreign = JSON.parse(stdout) as typeof work;
  assert.equal(foreign.canonicalPath, root); assert.notEqual(foreign.sessionId, currentSessionId());
  await assert.rejects(verifyGrant(foreign, 'work'), code('ROOT_FORBIDDEN'));
  await assert.rejects(scanRoot(foreign), code('ROOT_FORBIDDEN'));
  // Observation (not a pass/fail criterion of this test): scanRoot itself has no session parameter.
  const accepted = await scanRoot(otherSession).then(() => true, () => false);
  t.diagnostic(`scanRoot accepts an in-process grant issued with another sessionId: ${accepted}`);
});

/* ======================================================================= #6 exclusions and partial results */

test('V67-S1 exclusion table (hand-written) with codes and Korean explanations; the external tree is not read', async (t) => {
  const outside = await make(t, { 'secret.pdf': 'outside' });
  const root = await make(t, { 'ok.pdf': 'ok', 'sub/ok2.txt': 'ok2', '.hidden.txt': 'h', '.secret/s.pdf': 's',
    'node_modules/m/index.js': 'm', 'dist/out.js': 'o', 'sub/proj/package.json': '{}', 'sub/proj/main.ts': 'm',
    'Tool.app/Contents/x': 'x', 'Thumbs.db': 't', 'desktop.ini': 'd', 'hard1.txt': 'same-inode', 'CON.txt': 'c' });
  await link(path.join(root, 'hard1.txt'), path.join(root, 'hard2.txt'));
  await symlink(path.join(root, 'ok.pdf'), path.join(root, 'file-link.pdf'));
  await symlink(path.join(root, 'sub'), path.join(root, 'dir-link'));
  await symlink(outside, path.join(root, 'out-link'));
  const expected: Record<string, string> = { '.hidden.txt': 'HIDDEN', '.secret': 'HIDDEN', node_modules: 'DEV_PROJECT',
    dist: 'DEV_PROJECT', 'sub/proj': 'DEV_PROJECT', 'Tool.app': 'APP_BUNDLE', 'Thumbs.db': 'SYSTEM_PATH', 'desktop.ini': 'SYSTEM_PATH',
    'hard1.txt': 'HARDLINK', 'hard2.txt': 'HARDLINK', 'file-link.pdf': 'LINK', 'dir-link': 'LINK', 'out-link': 'LINK',
    'CON.txt': 'UNSUPPORTED_NAME' };
  if (posix) {
    for (const name of ['a:b.txt', 'back\\slash.txt', 'trail ', 'trail.']) {
      await writeFile(path.join(root, name), 'x', { flag: 'wx' }); expected[name] = 'UNSUPPORTED_NAME';
    }
    await run('/usr/bin/mkfifo', [path.join(root, 'pipe')]); expected['pipe'] = 'NOT_REGULAR';
    const handle = await open(path.join(root, 'sparse.bin'), 'wx'); await handle.truncate(2 * 1024 * 1024); await handle.close();
    const blocks = (await lstat(path.join(root, 'sparse.bin'), { bigint: true })).blocks;
    if (process.platform === 'darwin' && blocks === 0n) expected['sparse.bin'] = 'CLOUD_PLACEHOLDER';
    t.diagnostic(`sparse.bin st_blocks=${blocks}`);
  }
  const before = await oracle(root); const outsideBefore = await oracle(outside);
  const grant = await issueRootGrant(root);
  const scan = await scanRoot(grant);
  const expectedFiles = ['ok.pdf', 'sub/ok2.txt', ...(expected['sparse.bin'] === undefined && posix ? ['sparse.bin'] : [])];
  assert.deepEqual(paths(scan.files), sorted(expectedFiles));
  assert.deepEqual(skipMap(scan.skipped), expected);
  assertExplained(scan.skipped);
  assert.equal(scan.complete, true, 'deliberate exclusions do not make the scan incomplete');
  const { preview } = await analyzeRoot(grant);
  assertExplained(preview.skipped);
  assert.ok(!JSON.stringify(preview).includes('secret.pdf'), 'external tree not listed');
  assert.deepEqual(await oracle(root), before); assert.deepEqual(await oracle(outside), outsideBefore);
});

test('V67-S2 Korean NFC/NFD, spaces, emoji, empty folder and empty file: exact listing, spelling kept', async (t) => {
  const nfdDir = '한글'.normalize('NFD'); const nfdFile = `${'파일'.normalize('NFD')}.txt`;
  const spec: FixtureSpec = { [`${nfdDir}/${nfdFile}`]: 'nfd', [`NFC/${'한글'.normalize('NFC')}.txt`]: 'nfc',
    'with space/공백 있는 이름.pdf': 'space', 'emoji 🎉/🎉 party.jpg': 'emoji', '빈 폴더/': '', 'zero.txt': '' };
  const root = await make(t, spec);
  const before = await oracle(root);
  const scan = await scanRoot(await issueRootGrant(root));
  assert.deepEqual(paths(scan.files), sorted([`${nfdDir}/${nfdFile}`, `NFC/${'한글'.normalize('NFC')}.txt`,
    'with space/공백 있는 이름.pdf', 'emoji 🎉/🎉 party.jpg', 'zero.txt']));
  assert.deepEqual(sorted(scan.directories), sorted([nfdDir, 'NFC', 'with space', 'emoji 🎉', '빈 폴더']));
  assert.ok(scan.files.some((f) => f.relativePath === `${nfdDir}/${nfdFile}`), 'NFD bytes preserved');
  assert.deepEqual(scan.skipped, []); assert.equal(scan.complete, true);
  for (const f of scan.files) {
    const s = await lstat(path.join(root, ...f.relativePath.split('/')), { bigint: true });
    assert.deepEqual([f.size, f.inode, f.modifiedNs], [Number(s.size), String(s.ino), String(s.mtimeNs)], f.relativePath);
  }
  assert.deepEqual(await oracle(root), before);
});

test('V67-S3 depth and count limits: exact partial results, incomplete, coded', async (t) => {
  const root = await make(t, { 'r.txt': 'r', 'a/x.txt': 'x', 'a/b/y.txt': 'y', 'a/b/c/z.txt': 'z' });
  const grant = await issueRootGrant(root);
  const d1 = await scanRoot(grant, { maxDepth: 1 });
  assert.deepEqual(paths(d1.files), ['a/x.txt', 'r.txt']);
  assert.deepEqual(skipMap(d1.skipped), { 'a/b': 'DEPTH_LIMIT' });
  assert.equal(d1.complete, false);
  const d0 = await scanRoot(grant, { maxDepth: 0 });
  assert.deepEqual(paths(d0.files), ['r.txt']); assert.deepEqual(skipMap(d0.skipped), { a: 'DEPTH_LIMIT' });
  const flat = await make(t, { 'a.txt': '1', 'b.txt': '22', 'c.txt': '333', 'd.txt': '4444', 'e.txt': '55555' });
  const c3 = await scanRoot(await issueRootGrant(flat), { maxFiles: 3 });
  assert.deepEqual(paths(c3.files), ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(c3.skipped.map((s) => s.code), ['COUNT_LIMIT']); assert.equal(c3.complete, false);
  assertExplained([...d1.skipped, ...c3.skipped]);
  const c5 = await scanRoot(await issueRootGrant(flat), { maxFiles: 5 });
  assert.equal(c5.complete, true, 'exactly maxFiles files is complete'); assert.equal(c5.files.length, 5);
});

test('V67-S4 access denied (chmod 000 folder and file) and a locked (uchg) file: accurate partial result', { skip: !posix || isRoot }, async (t) => {
  const root = await make(t, { 'locked/in.pdf': 'in', 'secret.pdf': 'AAAA', 'twin.pdf': 'BBBB', 'ok.txt': 'ok',
    'frozen.pdf': 'frozen!', 'frozen-copy.pdf': 'frozen!' });
  await chmod(path.join(root, 'locked'), 0); await chmod(path.join(root, 'secret.pdf'), 0);
  if (process.platform === 'darwin') await run('/usr/bin/chflags', ['uchg', path.join(root, 'frozen.pdf')]);
  const before = await oracle(root);
  const grant = await issueRootGrant(root);
  const scan = await scanRoot(grant);
  assert.deepEqual(paths(scan.files), ['frozen-copy.pdf', 'frozen.pdf', 'ok.txt', 'secret.pdf', 'twin.pdf']);
  assert.deepEqual(scan.skipped.map((s) => [s.relativePath, s.code, s.detail]), [['locked', 'READ_FAILED', 'EACCES']]);
  assert.equal(scan.complete, false);
  const hashed = await hashCandidates(grant, scan);
  const byPath = Object.fromEntries(hashed.files.map((f) => [f.relativePath, f.sha256]));
  assert.equal(byPath['secret.pdf'], null); assert.equal(byPath['twin.pdf'], sha('BBBB'));
  assert.equal(byPath['frozen.pdf'], sha('frozen!')); assert.equal(byPath['frozen-copy.pdf'], sha('frozen!'));
  assert.equal(byPath['ok.txt'], null, 'unique size is not hashed');
  assert.deepEqual(hashed.skipped.filter((s) => s.code === 'HASH_FAILED').map((s) => [s.relativePath, s.detail]), [['secret.pdf', 'EACCES']]);
  const preview = buildPreview(hashed);
  assert.equal(preview.items.find((i) => i.source === 'secret.pdf')?.action, 'review');
  assert.deepEqual(preview.duplicates.map((d) => sorted([d.suggestedKeep, ...d.candidates])), [['frozen-copy.pdf', 'frozen.pdf']]);
  assertExplained(hashed.skipped); assertKeeper(preview);
  assert.deepEqual(await oracle(root), before);
});

test('V67-S5 files and a folder deleted during the scan: only those are reported; the rest is exact', async (t) => {
  const root = await make(t, { 'a.txt': 'a', 'b.txt': 'b', 'c/1.txt': '1', 'd.txt': 'd', 'e/2.txt': '2' });
  let first = true;
  const scan = await scanRoot(await issueRootGrant(root), { onProgress: (p) => {
    if (p.phase === 'scan' && first) { first = false; unlinkSync(path.join(root, 'b.txt')); rmSync(path.join(root, 'c'), { recursive: true }); }
  } });
  assert.deepEqual(paths(scan.files), ['a.txt', 'd.txt', 'e/2.txt']);
  assert.deepEqual(scan.skipped.map((s) => [s.relativePath, s.code, s.detail]), [['b.txt', 'READ_FAILED', 'ENOENT'], ['c', 'READ_FAILED', 'ENOENT']]);
  assert.equal(scan.complete, false);
});

/* ======================================================================= #6 progress, cancellation, preservation */

test('V67-P1 progress: valid events, scan before hash, monotonic counters, streaming intermediates, totals match', async (t) => {
  const big = Buffer.alloc(3 * 1024 * 1024, 3); const other = Buffer.alloc(3 * 1024 * 1024, 4);
  const spec: FixtureSpec = { 'big/a.bin': big, 'big/b.bin': big, 'big/c.bin': other };
  for (let i = 0; i < 5; i++) { spec[`d${i}/x.txt`] = 'x'.repeat(2 * i + 1); spec[`d${i}/y.txt`] = 'y'.repeat(2 * i + 2); }
  const root = await make(t, spec);
  const events: ScanProgress[] = [];
  await analyzeRoot(await issueRootGrant(root), { hashConcurrency: 1, onProgress: (p) => { events.push(ScanProgressSchema.parse(p)); } });
  const firstHash = events.findIndex((e) => e.phase === 'hash');
  assert.ok(firstHash > 0 && events.slice(firstHash).every((e) => e.phase === 'hash'), 'scan events precede hash events');
  const scanEvents = events.slice(0, firstHash); const hashEvents = events.slice(firstHash);
  assert.equal(scanEvents.length, 7, 'one event per listed folder (root + big + d0..d4)');
  for (const [list, keys] of [[scanEvents, ['directories', 'files', 'skipped']], [hashEvents, ['hashedFiles', 'bytesHashed']]] as const)
    for (let i = 1; i < list.length; i++) for (const k of keys) assert.ok(list[i]![k] >= list[i - 1]![k], `${k} decreased`);
  assert.ok(hashEvents.every((e) => e.hashTargets === 3 && e.bytesToHash === 9 * 1024 * 1024));
  const last = hashEvents.at(-1)!;
  assert.deepEqual([last.hashedFiles, last.bytesHashed], [3, 9 * 1024 * 1024]);
  assert.ok(hashEvents.some((e) => e.bytesHashed > 0 && e.bytesHashed % (3 * 1024 * 1024) !== 0), 'events inside a file (streaming)');
});

test('V67-P2 cancellation mid-scan: throw by default, exact partial on request, nothing runs afterwards', async (t) => {
  const root = await make(t, { 'd0/f.txt': '0', 'd1/f.txt': '1', 'd2/f.txt': '2', 'd3/f.txt': '3', 'r.txt': 'r' });
  const before = await oracle(root);
  const grant = await issueRootGrant(root);
  const at = (n: number) => { const c = new AbortController(); let events = 0; const seen: ScanProgress[] = [];
    return { seen, options: { signal: c.signal, onProgress: (p: ScanProgress) => { seen.push(p); if (++events === n) c.abort(); } } }; };
  const thrown = at(3);
  await assert.rejects(scanRoot(grant, thrown.options), (e: unknown) => e instanceof Error && e.name === 'AbortError' && isAfoError(e, 'CANCELLED'));
  const n = thrown.seen.length; await sleep(50); assert.equal(thrown.seen.length, n, 'no events after rejection');
  const partial = at(3);
  const result = await scanRoot(grant, { ...partial.options, onAbort: 'partial' });
  // root (1), d0 (2, its file is read), d1 (3: aborted before its entries)
  assert.deepEqual(paths(result.files), ['d0/f.txt']);
  assert.equal(result.cancelled, true); assert.equal(result.complete, false);
  const m = partial.seen.length; await sleep(50); assert.equal(partial.seen.length, m);
  const pre = new AbortController(); pre.abort(); let calls = 0;
  await assert.rejects(analyzeRoot(grant, { signal: pre.signal, onProgress: () => { calls++; } }), (e: unknown) => isAfoError(e, 'CANCELLED'));
  assert.equal(calls, 0, 'pre-aborted signal: no work started');
  assert.deepEqual(await oracle(root), before);
});

test('V67-P3 cancellation while hashing: partial keeps only fully hashed files with correct hashes; workers stop', async (t) => {
  const mib = 1024 * 1024;
  const content = Buffer.alloc(4 * mib); for (let i = 0; i < content.length; i++) content[i] = (i * 7) & 0xff;
  const root = await make(t, { '1.bin': content, '2.bin': content, '3.bin': content });
  const before = await oracle(root);
  const grant = await issueRootGrant(root);
  const scan = await scanRoot(grant);
  const make1 = () => { const c = new AbortController(); const seen: ScanProgress[] = [];
    return { seen, options: { signal: c.signal, hashConcurrency: 1, onProgress: (p: ScanProgress) => { seen.push(p); if (p.bytesHashed >= 5 * mib) c.abort(); } } }; };
  const a = make1();
  await assert.rejects(hashCandidates(grant, scan, a.options), { name: 'AbortError' });
  const k = a.seen.length; await sleep(50); assert.equal(a.seen.length, k);
  const b = make1();
  const partial = await hashCandidates(grant, scan, { ...b.options, onAbort: 'partial' });
  const k2 = b.seen.length; await sleep(50); assert.equal(b.seen.length, k2);
  assert.deepEqual(partial.files.map((f) => [f.relativePath, f.sha256]), [['1.bin', sha(content)], ['2.bin', null], ['3.bin', null]]);
  assert.equal(partial.cancelled, true); assert.equal(partial.complete, false);
  assert.ok(scan.files.every((f) => f.sha256 === null), 'input not mutated');
  const preview = buildPreview(partial);
  assert.deepEqual(preview.duplicates, [], 'one hashed file cannot form a group');
  assert.deepEqual(await oracle(root), before);
});

test('V67-P4 baseline manifest identical after scan, hash, reference read and full analysis (atime excluded)', async (t) => {
  const root = await make(t, { '보고서.pdf': 'dup', 'copy/보고서 사본.pdf': 'dup', '.hidden': 'h', 'node_modules/a.js': 'a',
    '사진/😀.jpg': 'img', '빈/': '', 'ref/과제/a.hwp': 'hwp-a', 'ref/과제/b.hwp': 'hwp-b', 'e1.txt': '', 'e2.txt': '' });
  await symlink(path.join(root, '보고서.pdf'), path.join(root, 'alias.pdf'));
  await link(path.join(root, '사진/😀.jpg'), path.join(root, '사진/hard.jpg'));
  if (posix) await run('/usr/bin/mkfifo', [path.join(root, 'pipe')]);
  const before = await oracle(root);
  const grant = await issueRootGrant(root); const reference = await issueReferenceGrant(path.join(root, 'ref'));
  const scan = await scanRoot(grant);
  await hashCandidates(grant, scan, { hashConcurrency: 8 });
  await readReference(reference);
  const analysis = await analyzeRoot(grant, { reference });
  assertKeeper(analysis.preview, analysis.protected.map((p) => p.relativePath));
  assert.deepEqual(await oracle(root), before);
});

/* ======================================================================= #6 reference folders */

test('V67-F1 reference read returns names/extensions only; unreadable files and folders still listed by name', { skip: !posix || isRoot }, async (t) => {
  const root = await make(t, { 'notes/a.pdf': 'a', 'notes/b.PDF': 'b', 'README': 'r', 'x.tar.gz': 'x', '.h': 'h' });
  await chmod(path.join(root, 'notes/a.pdf'), 0);
  const before = await oracle(root);
  const ref = await readReference(await issueReferenceGrant(root));
  assert.equal(ref.mode, 'reference-metadata'); assert.equal(ref.complete, true);
  assert.deepEqual(ref.files.map((f) => [f.relativePath, f.extension?.toLowerCase() ?? null]),
    [['README', null], ['notes/a.pdf', '.pdf'], ['notes/b.PDF', '.pdf'], ['x.tar.gz', '.gz']]);
  for (const f of ref.files) assert.deepEqual(Object.keys(f).sort(), ['extension', 'relativePath'], 'no size/identity/hash');
  assert.ok(!/sha256|inode|"size"/u.test(JSON.stringify(ref)));
  assert.deepEqual(skipMap(ref.skipped), { '.h': 'HIDDEN' });
  assert.deepEqual(await oracle(root), before);
});

test('V67-F2 overlap both ways (and same folder, and via a saved profile): reference files never move or become candidates', async (t) => {
  const W = await make(t, { 'new.pdf': 'same-content', 'w2.pdf': 'same-content', '정리됨/old.pdf': 'same-content',
    '정리됨/other.txt': 'other', '정리됨/과제/a.hwp': 'hwp-1', '정리됨/과제/b.hwp': 'hwp-2', 'loose.hwp': 'hwp-1' });
  const before = await oracle(W);
  const ref = path.join(W, '정리됨');
  const protectedExpected = ['정리됨/old.pdf', '정리됨/other.txt', '정리됨/과제/a.hwp', '정리됨/과제/b.hwp'];
  const check = (preview: Preview, prot: string[]): void => {
    assertKeeper(preview, prot);
    const key = new Set(prot);
    for (const i of preview.items) if (key.has(i.source)) {
      assert.equal(i.action, 'keep', i.source); assert.equal(i.reasonCode, 'PROTECTED_REFERENCE'); assert.equal(i.destination, null);
    }
    for (const g of preview.duplicates) for (const c of g.candidates) assert.ok(!key.has(c), `protected candidate ${c}`);
    for (const i of preview.items) if (i.destination !== null) assert.ok(!key.has(i.destination), 'destination onto a protected file');
    assert.ok(preview.largeFiles.every((f) => !key.has(f)));
  };
  // (a) reference inside the work root
  const a = await analyzeRoot(await issueRootGrant(W), { reference: await issueReferenceGrant(ref) });
  assert.deepEqual(paths(a.protected), sorted(protectedExpected));
  check(a.preview, protectedExpected);
  assert.deepEqual(a.preview.duplicates.map((d) => sorted([d.suggestedKeep, ...d.candidates])), [['new.pdf', 'w2.pdf']]);
  // (b) work root inside the reference folder: every work file is a reference file.
  const b = await analyzeRoot(await issueRootGrant(path.join(W, '정리됨/과제')), { reference: await issueReferenceGrant(W) });
  assert.deepEqual(paths(b.protected), ['a.hwp', 'b.hwp']);
  check(b.preview, ['a.hwp', 'b.hwp']);
  assert.ok(b.preview.items.every((i) => i.action === 'keep'));
  // (c) the same folder as both
  const c = await analyzeRoot(await issueRootGrant(W), { reference: await issueReferenceGrant(W) });
  assert.equal(c.protected.length, 7); assert.ok(c.preview.items.every((i) => i.action === 'keep')); assert.deepEqual(c.preview.duplicates, []);
  // (d) later analysis with only the confirmed profile (no live reference read) still protects the reference files.
  const draft = suggestProfile(await readReference(await issueReferenceGrant(ref)));
  assert.ok(draft.rules.length >= 1);
  const profile = confirmProfile(draft, draft.rules.map((r) => r.id));
  const d = await analyzeRoot(await issueRootGrant(W), { profile });
  assert.deepEqual(paths(d.protected), sorted(protectedExpected));
  check(d.preview, protectedExpected);
  assert.equal(d.preview.items.find((i) => i.source === 'loose.hwp')?.destination, '과제/loose.hwp', 'confirmed personal rule applied');
  assert.deepEqual(await oracle(W), before);
});

/* ======================================================================= #7 classification */

const table: [string, 'move' | 'keep' | 'review', string | null, string][] = [
  ['report.pdf', 'move', '문서/report.pdf', 'DEFAULT_EXTENSION'], ['NOTES.TXT', 'move', '문서/NOTES.TXT', 'DEFAULT_EXTENSION'],
  ['Slides.PpTx', 'move', '문서/Slides.PpTx', 'DEFAULT_EXTENSION'], ['과제.hwp', 'move', '문서/과제.hwp', 'DEFAULT_EXTENSION'],
  ['photo.JPEG', 'move', '이미지/photo.JPEG', 'DEFAULT_EXTENSION'], ['scan.Png', 'move', '이미지/scan.Png', 'DEFAULT_EXTENSION'],
  ['clip.MOV', 'move', '영상/clip.MOV', 'DEFAULT_EXTENSION'], ['song.mp3', 'move', '음악/song.mp3', 'DEFAULT_EXTENSION'],
  ['bundle.ZIP', 'move', '압축/bundle.ZIP', 'DEFAULT_EXTENSION'], ['installer.dmg', 'move', '설치/installer.dmg', 'DEFAULT_EXTENSION'],
  ['setup.EXE', 'move', '설치/setup.EXE', 'DEFAULT_EXTENSION'], ['v1.2.pdf', 'move', '문서/v1.2.pdf', 'DEFAULT_EXTENSION'],
  ['README', 'review', null, 'NO_EXTENSION'], ['Makefile', 'review', null, 'NO_EXTENSION'],
  ['backup.tar.gz', 'review', null, 'COMPOUND_EXTENSION'], ['invoice.pdf.exe', 'review', null, 'COMPOUND_EXTENSION'],
  ['data.bin', 'review', null, 'UNKNOWN_EXTENSION'], ['model.xyz123', 'review', null, 'UNKNOWN_EXTENSION'],
  ['문서/already.pdf', 'keep', '문서/already.pdf', 'ALREADY_PLACED'], ['이미지/done.png', 'keep', '이미지/done.png', 'ALREADY_PLACED'],
];

test('V67-C1 default classification matches a hand-written table on real files; deterministic for concurrency 1 and 8', async (t) => {
  const spec: FixtureSpec = {};
  table.forEach(([p], i) => { spec[p] = `content-${i}`; });
  spec['dupe-1.pdf'] = 'dupe'; spec['dupe-2.pdf'] = 'dupe'; // same size as each other only
  const root = await make(t, spec);
  const before = await oracle(root);
  const grant = await issueRootGrant(root);
  const runs = [await analyzeRoot(grant, { hashConcurrency: 1 }), await analyzeRoot(grant, { hashConcurrency: 8 }),
    await analyzeRoot(grant, { hashConcurrency: 1 }), await analyzeRoot(grant, { hashConcurrency: 8 })];
  for (const r of runs.slice(1)) assert.deepEqual(r.preview, runs[0]!.preview);
  const preview = runs[0]!.preview;
  for (const [source, action, destination, reasonCode] of table) {
    const item = preview.items.find((i) => i.source === source);
    assert.ok(item, source);
    assert.deepEqual([item.action, item.destination, item.reasonCode], [action, destination, reasonCode], source);
    assert.ok(/[가-힣]/u.test(item.reason), `${source}: Korean reason`);
  }
  assert.ok(preview.classificationVersion !== undefined && preview.classificationVersion.length > 0, 'rule version reported');
  assert.equal(preview.executionAvailable, false);
  assert.deepEqual(await oracle(root), before);
});

test('V67-C2 destination conflicts: existing file, same name, case-only difference → review, never overwrite', () => {
  const files = ['a.pdf', 'x/a.pdf', 'b.pdf', '문서/b.pdf', 'C.pdf', 'y/c.PDF', 'solo.png'];
  const scan: ScanResult = { root: { id: 'e'.repeat(64), canonicalPath: '/afo-v67', readOnly: true }, complete: true, directories: [], skipped: [],
    files: files.map((relativePath, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), relativePath, size: 10 + i,
      modifiedNs: '1', device: '1', inode: String(i + 1), sha256: null })) };
  const p = buildPreview(scan);
  const got = Object.fromEntries(p.items.map((i) => [i.source, [i.action, i.reasonCode]]));
  assert.deepEqual(got, { 'a.pdf': ['review', 'DEST_COLLISION'], 'x/a.pdf': ['review', 'DEST_COLLISION'], 'b.pdf': ['review', 'DEST_CONFLICT'],
    '문서/b.pdf': ['keep', 'ALREADY_PLACED'], 'C.pdf': ['review', 'DEST_COLLISION'], 'y/c.PDF': ['review', 'DEST_COLLISION'],
    'solo.png': ['move', 'DEFAULT_EXTENSION'] });
  // Same input object twice → identical preview; reordered input → same per-file decisions.
  assert.deepEqual(buildPreview(scan), p);
  const reordered = buildPreview({ ...scan, files: [...scan.files].reverse() });
  assert.deepEqual(Object.fromEntries(reordered.items.map((i) => [i.source, [i.action, i.reasonCode]])), got);
});

test('V67-C3 personal-rule interface: override > confirmed personal rule > default; draft/disabled ignored; no deletion inference', () => {
  const profile: RuleProfile = { formatVersion: 1, id: 'v67-profile', revision: 2, status: 'confirmed',
    referenceRoot: { id: 'd'.repeat(64), canonicalPath: '/ref', readOnly: true }, referenceFiles: ['학교/x.pdf', '학교/y.pdf'],
    rules: [{ id: 'r1', extension: '.pdf', keyword: null, targetDirectory: '학교', evidence: ['학교/x.pdf', '학교/y.pdf'] }] };
  assert.deepEqual([classifyFile('a.pdf', { profile }).targetDirectory, classifyFile('a.pdf', { profile }).source], ['학교', 'personal']);
  assert.deepEqual([classifyFile('a.pdf', { profile, override: '직접/폴더' }).targetDirectory,
    classifyFile('a.pdf', { profile, override: '직접/폴더' }).source], ['직접/폴더', 'override']);
  for (const status of ['draft', 'disabled'] as const)
    assert.deepEqual([classifyFile('a.pdf', { profile: { ...profile, status } }).targetDirectory,
      classifyFile('a.pdf', { profile: { ...profile, status } }).source], ['문서', 'default']);
  assert.equal(classifyFile('a.png', { profile }).source, 'default');
  // A classification never says "delete": the preview's actions are move/keep/review only and execution is unavailable.
  const scan: ScanResult = { root: { id: 'e'.repeat(64), canonicalPath: '/afo-v67', readOnly: true }, complete: true, directories: [], skipped: [],
    files: [{ id: '1'.padStart(64, '0'), relativePath: 'old.pdf', size: 5, modifiedNs: '1', device: '1', inode: '1', sha256: null }] };
  const p = buildPreview(scan, { profile });
  assert.equal(p.items[0]!.destination, '학교/old.pdf'); assert.equal(p.profileRevision, 2);
  assert.deepEqual(p.duplicates, []);
});

/* ======================================================================= #7 duplicates */

test('V67-D1 duplicates on real files: name vs content, same size different content, empty files, 3-way group', async (t) => {
  const root = await make(t, { 'a/report.txt': 'AAAA-1', 'b/report.txt': 'BBBB-2', 'x/photo1.jpg': 'pixels-xyz', 'y/copy.jpg': 'pixels-xyz',
    'e1.txt': '', 'e2.txt': '', 'g/1.bin': 'three-way', 'g/2.bin': 'three-way', 'h/3.bin': 'three-way', 'unique.md': 'only me here' });
  const before = await oracle(root);
  const grant = await issueRootGrant(root);
  const hashed = await hashCandidates(grant, await scanRoot(grant));
  const h = Object.fromEntries(hashed.files.map((f) => [f.relativePath, f.sha256]));
  assert.equal(h['a/report.txt'], sha('AAAA-1')); assert.equal(h['b/report.txt'], sha('BBBB-2'));
  assert.equal(h['e1.txt'], null); assert.equal(h['unique.md'], null, 'empty and unique-size files are not read');
  const preview = buildPreview(hashed);
  assert.deepEqual(sorted(preview.duplicates.map((d) => sorted([d.suggestedKeep, ...d.candidates]).join('|'))),
    sorted(['g/1.bin|g/2.bin|h/3.bin', 'x/photo1.jpg|y/copy.jpg']));
  const three = preview.duplicates.find((d) => d.sha256 === sha('three-way'))!;
  assert.equal(three.candidates.length, 2);
  assert.deepEqual(preview.duplicateNotes?.map((n) => [n.relativePath, n.code]), [['e1.txt', 'EMPTY_FILE'], ['e2.txt', 'EMPTY_FILE']]);
  assertKeeper(preview);
  assert.deepEqual(await oracle(root), before);
});

test('V67-D2 a file changed between scan and hash is excluded alone; the result is incomplete and it is never grouped', async (t) => {
  const root = await make(t, { 'p/one.pdf': 'twin-data', 'p/two.pdf': 'twin-data', 'q/three.pdf': 'twin-data', 'r.txt': 'xx', 's.txt': 'yy' });
  const grant = await issueRootGrant(root);
  const scan = await scanRoot(grant);
  let changed = false;
  const hashed = await hashCandidates(grant, scan, { hashConcurrency: 1, onProgress: () => {
    if (!changed) { changed = true; writeFileSync(path.join(root, 'p/two.pdf'), 'TWIN-DATA'); } // same size, new content and mtime
  } });
  assert.ok(changed);
  assert.deepEqual(hashed.skipped.map((s) => [s.relativePath, s.code]), [['p/two.pdf', 'FILE_CHANGED']]);
  assert.equal(hashed.complete, false);
  const preview = buildPreview(hashed);
  assert.deepEqual(preview.duplicates.map((d) => sorted([d.suggestedKeep, ...d.candidates])), [['p/one.pdf', 'q/three.pdf']]);
  assert.equal(preview.items.find((i) => i.source === 'p/two.pdf')?.action, 'review');
  assert.ok(preview.duplicateNotes?.some((n) => n.relativePath === 'p/two.pdf' && n.code === 'HASH_UNAVAILABLE'));
  // Changed during the read itself (appended while streaming).
  const big = Buffer.alloc(3 * 1024 * 1024, 9);
  const root2 = await make(t, { 'a.bin': big, 'b.bin': big });
  const g2 = await issueRootGrant(root2);
  let touched = false;
  const h2 = await hashCandidates(g2, await scanRoot(g2), { hashConcurrency: 1, onProgress: (p) => {
    if (!touched && p.bytesHashed > 0 && p.hashedFiles === 0) { touched = true; appendFileSync(path.join(root2, 'a.bin'), 'z'); }
  } });
  assert.ok(touched);
  assert.deepEqual(h2.skipped.map((s) => [s.relativePath, s.code]), [['a.bin', 'FILE_CHANGED']]);
  assert.deepEqual(buildPreview(h2).duplicates, []);
});

test('V67-D3 chooseKeeper: change succeeds immutably; outside-group, keeper-as-candidate, protected and case variants are refused', () => {
  const H = (c: string): string => c.repeat(64);
  const files = [['g/1.bin', 1000, H('a'), 4096], ['g/2.bin', 1000, H('a'), 4096], ['g/3.bin', 1000, H('a'), 8192],
    ['h/1.bin', 500, H('b'), 4096], ['h/2.bin', 500, H('b'), null], ['p/ref.bin', 300, H('c'), 4096], ['p/x.bin', 300, H('c'), 4096],
    ['p/y.bin', 300, H('c'), 4096], ['big.mkv', 200 * 1024 * 1024, H('d'), 200 * 1024 * 1024], ['old.txt', 7, H('e'), 4096]] as const;
  const scan: ScanResult = { root: { id: 'e'.repeat(64), canonicalPath: '/afo-v67', readOnly: true }, complete: true, directories: [], skipped: [],
    files: files.map(([relativePath, size, sha256, allocatedBytes], i) => ({ id: (i + 1).toString(16).padStart(64, '0'), relativePath, size,
      modifiedNs: '1', device: '1', inode: String(i + 1), sha256, allocatedBytes })) };
  const preview = buildPreview(scan, { protectedPaths: ['p/ref.bin'] });
  assertKeeper(preview, ['p/ref.bin']);
  const g = (p: Preview, s: string) => p.duplicates.find((d) => d.sha256 === s)!;
  // Hand-computed estimates.
  assert.deepEqual([g(preview, H('a')).suggestedKeep, g(preview, H('a')).candidates], ['g/1.bin', ['g/2.bin', 'g/3.bin']]);
  assert.deepEqual([g(preview, H('a')).logicalCandidateBytes, g(preview, H('a')).allocatedCandidateBytes, g(preview, H('a')).reclaimableEstimateBytes], [2000, 12288, 12288]);
  assert.deepEqual([g(preview, H('b')).logicalCandidateBytes, g(preview, H('b')).allocatedCandidateBytes, g(preview, H('b')).reclaimableEstimateBytes], [500, null, 500]);
  assert.deepEqual([g(preview, H('c')).suggestedKeep, g(preview, H('c')).candidates], ['p/ref.bin', ['p/x.bin', 'p/y.bin']]);
  assert.deepEqual([preview.space?.logicalCandidateBytes, preview.space?.allocatedCandidateBytes, preview.space?.reclaimableEstimateBytes],
    [3100, null, 20980]);
  assert.ok(preview.space !== undefined && /[가-힣]/u.test(preview.space.note));
  // Large / old files are informational only.
  assert.deepEqual(preview.largeFiles, ['big.mkv']);
  assert.ok(preview.duplicates.every((d) => !d.candidates.includes('big.mkv') && !d.candidates.includes('old.txt')));
  assert.equal(preview.items.find((i) => i.source === 'big.mkv')?.action, 'move');
  // Change the keeper.
  const snapshot = structuredClone(preview);
  const changed = chooseKeeper(preview, H('a'), 'g/3.bin');
  assert.deepEqual(preview, snapshot, 'input preview not modified');
  assert.deepEqual([g(changed, H('a')).suggestedKeep, g(changed, H('a')).candidates], ['g/3.bin', ['g/1.bin', 'g/2.bin']]);
  assert.deepEqual([g(changed, H('a')).logicalCandidateBytes, g(changed, H('a')).allocatedCandidateBytes], [2000, 8192]);
  assert.notEqual(changed.id, preview.id); PreviewSchema.parse(changed); assertKeeper(changed, ['p/ref.bin']);
  const partial = chooseKeeper(preview, H('a'), 'g/2.bin', { candidates: ['g/3.bin'] });
  assert.deepEqual(g(partial, H('a')).candidates, ['g/3.bin']); assertKeeper(partial);
  const unprotectedKeep = chooseKeeper(preview, H('c'), 'p/x.bin');
  assert.deepEqual(g(unprotectedKeep, H('c')).candidates, ['p/y.bin'], 'protected member is never added');
  assert.equal(unprotectedKeep.space?.logicalCandidateBytes, 2000 + 500 + 300);
  const refusals: [string, string, { candidates?: string[] }][] = [
    [H('a'), 'h/1.bin', {}], [H('a'), 'g/9.bin', {}], [H('a'), 'G/1.BIN', {}], [H('a'), 'g/1.bin', { candidates: ['h/2.bin'] }],
    [H('a'), 'g/1.bin', { candidates: ['g/1.bin'] }], [H('a'), 'g/1.bin', { candidates: ['g/2.bin', 'g/2.bin'] }],
    [H('a'), 'g/1.bin', { candidates: ['G/2.BIN'] }], [H('c'), 'p/x.bin', { candidates: ['p/ref.bin'] }], [H('f'), 'g/1.bin', {}]];
  for (const [s, keep, opts] of refusals)
    assert.throws(() => chooseKeeper(preview, s, keep, opts), code('KEEPER_INVALID'), `${keep} ${JSON.stringify(opts)}`);
  const tampered = structuredClone(preview); tampered.duplicates[0]!.candidates.push(tampered.duplicates[0]!.suggestedKeep);
  assert.throws(() => chooseKeeper(tampered, H('a'), 'g/2.bin'));
});

test('V67-D4 hard links and protected files are outside reclaim estimates on real files; allocation is reported separately', async (t) => {
  const root = await make(t, { 'h1.dat': 'hardlinked-content', 'h3.dat': 'hardlinked-content', 'm1.dat': 'mirror-bytes', 'm2.dat': 'mirror-bytes' });
  await link(path.join(root, 'h1.dat'), path.join(root, 'h2.dat'));
  const grant = await issueRootGrant(root);
  const { preview } = await analyzeRoot(grant);
  assert.deepEqual(skipMap(preview.skipped), { 'h1.dat': 'HARDLINK', 'h2.dat': 'HARDLINK' });
  assert.deepEqual(preview.duplicates.map((d) => sorted([d.suggestedKeep, ...d.candidates])), [['m1.dat', 'm2.dat']]);
  const group = preview.duplicates[0]!;
  const m2 = await lstat(path.join(root, group.candidates[0]!), { bigint: true });
  assert.equal(group.logicalCandidateBytes, 'mirror-bytes'.length);
  if (process.platform !== 'win32') {
    assert.equal(group.allocatedCandidateBytes, Number(m2.blocks * 512n));
    assert.equal(preview.space?.reclaimableEstimateBytes, Number(m2.blocks * 512n));
  }
  assert.notEqual(preview.space?.logicalCandidateBytes, preview.space?.allocatedCandidateBytes, 'logical and allocated are distinct values here');
  assertKeeper(preview);
});

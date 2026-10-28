import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createManifest, diffManifest } from './fixtures/index.js';
import { executeBatch, listRuns, readRun } from '../packages/filesystem/src/executor.js';
import { PlatformError } from '../packages/filesystem/src/platform.js';
import { issueRootGrant } from '../packages/filesystem/src/grants.js';
import { F, abs, approve, isRoot, journal, makeApproval, makeBatch, makePlan, operation, phases, setup, sha, stateNames }
  from './executor-helpers.js';

const code = (expected: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, expected); return true;
};
async function trySymlink(t: TestContext, target: string, at: string): Promise<boolean> {
  try { await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch (error) {
    if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') { t.skip('Windows symlink privilege missing'); return false; }
    throw error;
  }
}

test('move: approved files move into newly created nested folders; manifest, hashes, journal and run record agree', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'report', [`${F}b.jpg`]: 'image bytes', [`${F}keep.txt`]: 'untouched' });
  const hashes = { a: await sha(abs(env, `${F}a.pdf`)), b: await sha(abs(env, `${F}b.jpg`)) };
  const a = await operation(env, 'move', `${F}a.pdf`, { destination: `${F}문서/2026/${F}a.pdf` });
  const b = await operation(env, 'move', `${F}b.jpg`, { destination: `${F}사진/${F}b.jpg`, hash: true });
  const before = await createManifest(env.root);
  const seen: string[] = [];
  const report = await executeBatch(approve(env, [a, b], 'organize'), { onProgress: (p) => seen.push(`${p.done}/${p.total}`) });
  assert.deepEqual(report.results.map((r) => [r.opId, r.status, r.errorCode]), [[a.id, 'moved', null], [b.id, 'moved', null]]);
  assert.match(report.results[0]!.detail, /폴더 2개/u);
  assert.deepEqual(seen, ['1/2', '2/2']);
  const after = await createManifest(env.root);
  assert.deepEqual(diffManifest(before, after), { removed: [`${F}a.pdf`, `${F}b.jpg`], changed: [],
    added: [`${F}문서`, `${F}문서/2026`, `${F}문서/2026/${F}a.pdf`, `${F}사진`, `${F}사진/${F}b.jpg`].sort() });
  assert.equal(await sha(abs(env, `${F}문서/2026/${F}a.pdf`)), hashes.a);
  assert.equal(await sha(abs(env, `${F}사진/${F}b.jpg`)), hashes.b);
  const entries = await journal(env, report.runId);
  assert.deepEqual(phases(entries), [`${a.id}:intent`, `${a.id}:done`, `${b.id}:intent`, `${b.id}:done`]);
  assert.deepEqual(entries.map((e) => e.seq), [0, 1, 2, 3]);
  const doneA = entries[1]!;
  assert.deepEqual(doneA.after, { device: a.expected.device, inode: a.expected.inode, size: a.expected.size, sha256: hashes.a });
  assert.equal(doneA.approvalId, report.approvalId);
  const saved = await readRun(env.stateDir, report.runId);
  assert.deepEqual(saved?.run.report, report);
  assert.deepEqual(saved?.run.root, { canonicalPath: env.grant.canonicalPath, device: env.grant.device, inode: env.grant.inode });
  assert.deepEqual(saved?.undos, []);
  assert.equal(report.space.logicalBytesSelected, a.expected.size + b.expected.size);
  assert.deepEqual([report.space.freeBytesBefore, report.space.freeBytesAfter], [null, null]);
  assert.match(report.space.note, /확보하지 않습니다/u);
});

test('move: an existing destination is never overwritten (DEST_EXISTS) and both files keep their content', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'new', [`${F}dest/${F}a.pdf`]: 'old' });
  const op = await operation(env, 'move', `${F}a.pdf`, { destination: `${F}dest/${F}a.pdf` });
  const before = await createManifest(env.root);
  const report = await executeBatch(approve(env, [op], 'organize'));
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'DEST_EXISTS']]);
  assert.deepEqual(await createManifest(env.root), before);
  assert.deepEqual(phases(await journal(env, report.runId)), [`${op.id}:intent`, `${op.id}:failed:DEST_EXISTS`]);
});

test('move: a destination parent or grandparent that is a link to outside the root is LINK_REJECTED; outside is untouched (O-1)', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'a', [`${F}b.pdf`]: 'b' });
  const outside = await mkdtemp(path.join(tmpdir(), `${F}outside-`));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(outside, 'sub'));
  if (!await trySymlink(t, outside, abs(env, `${F}link`))) return;
  const a = await operation(env, 'move', `${F}a.pdf`, { destination: `${F}link/${F}a.pdf` });
  const b = await operation(env, 'move', `${F}b.pdf`, { destination: `${F}link/sub/new/${F}b.pdf` });
  const [rootBefore, outsideBefore] = [await createManifest(env.root), await createManifest(outside)];
  const report = await executeBatch(approve(env, [a, b], 'organize'));
  assert.deepEqual(report.results.map((r) => r.errorCode), ['LINK_REJECTED', 'LINK_REJECTED']);
  assert.deepEqual(await createManifest(env.root), rootBefore);
  assert.deepEqual(await createManifest(outside), outsideBefore);
});

test('move: a source reached through a linked parent folder is LINK_REJECTED and nothing moves', async (t) => {
  const env = await setup(t, { [`${F}real/${F}a.pdf`]: 'a' });
  if (!await trySymlink(t, abs(env, `${F}real`), abs(env, `${F}alias`))) return;
  const op = await operation(env, 'move', `${F}alias/${F}a.pdf`, { destination: `${F}a.pdf` });
  const before = await createManifest(env.root);
  const report = await executeBatch(approve(env, [op], 'organize'));
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'LINK_REJECTED']]);
  assert.deepEqual(await createManifest(env.root), before);
});

test('move: content changed with size and mtime restored is caught by the sha256 re-hash (FILE_CHANGED)', async (t) => {
  const when = new Date('2026-01-02T03:04:05Z'); // whole seconds, so utimes can restore mtime exactly
  const env = await setup(t, { [`${F}a.pdf`]: { data: 'original', modified: when } });
  const file = abs(env, `${F}a.pdf`);
  const op = await operation(env, 'move', `${F}a.pdf`, { destination: `${F}moved.pdf`, hash: true });
  await writeFile(file, 'tampered'); // same length
  await utimes(file, when, when);
  const s = await lstat(file, { bigint: true });
  assert.equal(String(s.mtimeNs), op.expected.modifiedNs, 'mtime restored, so only content differs');
  const report = await executeBatch(approve(env, [op], 'organize'));
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'FILE_CHANGED']]);
  assert.equal(await readFile(file, 'utf8'), 'tampered');
  assert.equal((await lstat(abs(env, `${F}moved.pdf`)).catch(() => null)), null);
});

test('move: a permission error on the middle operation fails only that one; the others move', async (t) => {
  if (process.platform === 'win32' || isRoot()) { t.skip('POSIX 권한(chmod) 검사: win32·root에서는 건너뜀'); return; }
  const env = await setup(t, { [`${F}1.txt`]: '1', [`${F}locked/${F}2.txt`]: '2', [`${F}3.txt`]: '3' });
  const ops = [await operation(env, 'move', `${F}1.txt`, { destination: `${F}out/${F}1.txt` }),
    await operation(env, 'move', `${F}locked/${F}2.txt`, { destination: `${F}out/${F}2.txt` }),
    await operation(env, 'move', `${F}3.txt`, { destination: `${F}out/${F}3.txt` })];
  await chmod(abs(env, `${F}locked`), 0o555); // unlink of the source fails with EACCES
  let report;
  try { report = await executeBatch(approve(env, ops, 'organize')); } finally { await chmod(abs(env, `${F}locked`), 0o755); }
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]),
    [['moved', null], ['failed', 'PERMISSION_DENIED'], ['moved', null]]);
  assert.equal(await readFile(abs(env, `${F}locked/${F}2.txt`), 'utf8'), '2');
  assert.equal(await lstat(abs(env, `${F}out/${F}2.txt`)).catch(() => null), null, 'the link made before unlink was rolled back');
  assert.equal(await readFile(abs(env, `${F}out/${F}3.txt`), 'utf8'), '3');
});

test('move: cancelling during the run skips every remaining operation and leaves those files untouched', async (t) => {
  const env = await setup(t, { [`${F}1.txt`]: '1', [`${F}2.txt`]: '2', [`${F}3.txt`]: '3' });
  const ops = await Promise.all([1, 2, 3].map(async (n) => operation(env, 'move', `${F}${n}.txt`, { destination: `${F}out/${F}${n}.txt` })));
  ops.sort((x, y) => x.id < y.id ? -1 : 1);
  const controller = new AbortController();
  const report = await executeBatch(approve(env, ops, 'organize'), { signal: controller.signal, onProgress: () => controller.abort() });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['moved', null], ['skipped', 'CANCELLED'], ['skipped', 'CANCELLED']]);
  const moved = ops[0]!.source; const rest = ops.slice(1).map((op) => op.source);
  assert.equal(await lstat(abs(env, moved)).catch(() => null), null);
  for (const rel of rest) assert.ok((await lstat(abs(env, rel))).isFile());
  assert.deepEqual(phases(await journal(env, report.runId)),
    [`${ops[0]!.id}:intent`, `${ops[0]!.id}:done`, `${ops[1]!.id}:skipped:CANCELLED`, `${ops[2]!.id}:skipped:CANCELLED`]);
});

test('move: when the journal cannot be written nothing is changed (real chmod on the journal folder)', async (t) => {
  if (process.platform === 'win32' || isRoot()) { t.skip('POSIX 권한(chmod) 검사: win32·root에서는 건너뜀'); return; }
  const env = await setup(t, { [`${F}1.txt`]: '1', [`${F}2.txt`]: '2' });
  const ops = [await operation(env, 'move', `${F}1.txt`, { destination: `${F}out/${F}1.txt` }),
    await operation(env, 'move', `${F}2.txt`, { destination: `${F}out/${F}2.txt` })];
  await mkdir(path.join(env.stateDir, 'journal'), { mode: 0o500 });
  const before = await createManifest(env.root);
  const report = await executeBatch(approve(env, ops, 'organize'));
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'JOURNAL_FAILED'], ['skipped', 'JOURNAL_FAILED']]);
  assert.deepEqual(await createManifest(env.root), before);
  assert.deepEqual((await readRun(env.stateDir, report.runId))?.run.report, report);
});

test('move (mock): journal ENOSPC is DISK_FULL and no file changes', async (t) => {
  const env = await setup(t, { [`${F}1.txt`]: '1', [`${F}2.txt`]: '2' });
  const ops = [await operation(env, 'move', `${F}1.txt`, { destination: `${F}1-moved.txt` }),
    await operation(env, 'move', `${F}2.txt`, { destination: `${F}2-moved.txt` })];
  const before = await createManifest(env.root);
  const report = await executeBatch(approve(env, ops, 'organize'), { adapter: { appendJournal: async () => {
    throw Object.assign(new Error('mock ENOSPC'), { code: 'ENOSPC' }); } } });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'DISK_FULL'], ['skipped', 'DISK_FULL']]);
  assert.deepEqual(await createManifest(env.root), before);
});

test('move (mock): cross-volume refusal from the adapter is CROSS_VOLUME with both paths unchanged', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}other/${F}a.txt` });
  const report = await executeBatch(approve(env, [op], 'organize'), { adapter: { linkMoveNoClobber: async () => {
    throw new PlatformError('CROSS_VOLUME', 'mock EXDEV', 'EXDEV'); } } });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'CROSS_VOLUME']]);
  assert.equal(await readFile(abs(env, `${F}a.txt`), 'utf8'), 'a');
  assert.equal(await lstat(abs(env, `${F}other/${F}a.txt`)).catch(() => null), null);
});

test('move (mock): an adapter error that leaves the source gone is reported unknown, never as success', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}b.txt` });
  const report = await executeBatch(approve(env, [op], 'organize'), { adapter: { linkMoveNoClobber: async () => {
    throw new PlatformError('UNKNOWN', 'mock half state'); } } });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['unknown', 'UNKNOWN']]);
  assert.deepEqual(phases(await journal(env, report.runId)), [`${op.id}:intent`, `${op.id}:failed:UNKNOWN`]);
});

test('fault injection: a throw after intent propagates, the journal holds only the intent and files are unchanged', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a', [`${F}b.txt`]: 'b' });
  const ops = [await operation(env, 'move', `${F}a.txt`, { destination: `${F}x/${F}a.txt` }),
    await operation(env, 'move', `${F}b.txt`, { destination: `${F}x/${F}b.txt` })];
  const before = await createManifest(env.root);
  const crash = new Error('simulated crash');
  await assert.rejects(executeBatch(approve(env, ops, 'organize'), { faultInjection: (point) => { if (point === 'after-intent') throw crash; } }),
    (error) => error === crash);
  assert.deepEqual(await createManifest(env.root), before);
  const runs = await stateNames(env);
  assert.ok(runs.includes('journal') && runs.includes('runs'));
  const [runId] = await listRuns(env.stateDir);
  assert.deepEqual(phases(await journal(env, runId!)), [`${ops[0]!.id}:intent`]);
  assert.equal((await readRun(env.stateDir, runId!))?.run.report, null, 'no report after a crash');
});

test('fault injection: a throw after the OS move leaves the file moved with only the intent journaled (#13 input)', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}b.txt` });
  await assert.rejects(executeBatch(approve(env, [op], 'organize'), { faultInjection: (point) => { if (point === 'after-op') throw new Error('crash'); } }),
    /crash/u);
  assert.equal(await readFile(abs(env, `${F}b.txt`), 'utf8'), 'a');
  const [runId] = await listRuns(env.stateDir);
  assert.deepEqual(phases(await journal(env, runId!)), [`${op.id}:intent`]);
});

test('batch checks: mode mismatch, expiry, unconsumed, forged or altered operations, order, root and state folder are refused before any write', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a', [`${F}b.txt`]: 'b' });
  const a = await operation(env, 'move', `${F}a.txt`, { destination: `${F}x/${F}a.txt` });
  const b = await operation(env, 'move', `${F}b.txt`, { destination: `${F}x/${F}b.txt` });
  const plan = makePlan(env, [a, b]);
  const ids = [a.id, b.id];
  const before = await createManifest(env.root);
  const old = Date.now() - 30 * 60_000;
  const cases: [string, ReturnType<typeof makeBatch>, string][] = [
    ['mode', makeBatch(env, plan, makeApproval(plan, ids, 'trash')), 'MODE_MISMATCH'],
    ['expired', makeBatch(env, plan, makeApproval(plan, ids, 'organize', { issuedAt: new Date(old).toISOString(),
      expiresAt: new Date(old + 60_000).toISOString(), usedAt: new Date(old + 1000).toISOString() })), 'APPROVAL_EXPIRED'],
    ['unconsumed', makeBatch(env, plan, makeApproval(plan, ids, 'organize', { usedAt: null })), 'APPROVAL_INVALID'],
    ['subset mismatch', makeBatch(env, plan, makeApproval(plan, [a.id], 'organize'), [a, b]), 'APPROVAL_INVALID'],
    ['order', makeBatch(env, plan, makeApproval(plan, ids, 'organize'), [b, a]), 'APPROVAL_INVALID'],
    ['altered op', makeBatch(env, plan, makeApproval(plan, ids, 'organize'), [a, { ...b, destination: `${F}elsewhere.txt` }]), 'PLAN_CHANGED'],
    ['other plan', makeBatch(env, plan, { ...makeApproval(plan, ids, 'organize'), planId: 'f'.repeat(64) }), 'APPROVAL_INVALID'],
    ['state inside root', { ...makeBatch(env, plan, makeApproval(plan, ids, 'organize')), stateDir: abs(env, `${F}state`) }, 'STATE_DIR_CONFLICT'],
    ['forged grant', { ...makeBatch(env, plan, makeApproval(plan, ids, 'organize')), grant: { ...env.grant, id: 'e'.repeat(64) } }, 'ROOT_FORBIDDEN'],
  ];
  const other = await setup(t, {});
  cases.push(['other root', { ...makeBatch(env, plan, makeApproval(plan, ids, 'organize')), grant: other.grant }, 'ROOT_FORBIDDEN']);
  for (const [name, batch, expected] of cases) await assert.rejects(executeBatch(batch), code(expected), name);
  assert.deepEqual(await createManifest(env.root), before);
  assert.deepEqual(await stateNames(env), [], 'no journal or run record was written');
});

test('batch checks: one approval never runs twice (APPROVAL_USED), and re-running an organized plan moves nothing', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}done/${F}a.txt` });
  const batch = approve(env, [op], 'organize');
  assert.equal((await executeBatch(batch)).results[0]!.status, 'moved');
  const organized = await createManifest(env.root);
  await assert.rejects(executeBatch(batch), code('APPROVAL_USED'));
  const again = await executeBatch(makeBatch(env, batch.plan, makeApproval(batch.plan, [op.id], 'organize')));
  assert.deepEqual(again.results.map((r) => [r.status, r.errorCode]), [['failed', 'SOURCE_MISSING']]);
  assert.deepEqual(await createManifest(env.root), organized);
});

test('a grant re-issued for the same folder and session (new id) is accepted; path, identity and session bind the plan', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}b.txt` });
  const batch = approve(env, [op], 'organize');
  const reissued = await issueRootGrant(env.root, { sessionId: env.grant.sessionId }); // as consumeApproval re-grants
  assert.notEqual(reissued.id, env.grant.id);
  const report = await executeBatch({ ...batch, grant: reissued });
  assert.equal(report.results[0]!.status, 'moved');
});

test('session binding (D1): a grant or approval of another session is refused before any write', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}b.txt` });
  const plan = makePlan(env, [op]);
  const before = await createManifest(env.root);
  const otherSession = await issueRootGrant(env.root, { sessionId: randomUUID() }); // same folder, another session
  await assert.rejects(executeBatch({ ...makeBatch(env, plan, makeApproval(plan, [op.id], 'organize')), grant: otherSession }),
    code('ROOT_FORBIDDEN'), 'grant of another session');
  await assert.rejects(executeBatch(makeBatch(env, plan, makeApproval(plan, [op.id], 'organize', { sessionId: otherSession.sessionId }))),
    code('APPROVAL_INVALID'), 'approval of another session');
  await assert.rejects(executeBatch(makeBatch(env, plan, makeApproval(plan, [op.id], 'organize', { rootGrantId: otherSession.id }))),
    code('APPROVAL_INVALID'), 'approval naming another grant than the plan');
  assert.deepEqual(await createManifest(env.root), before);
  assert.deepEqual(await stateNames(env), [], 'no lock, journal or run record was written');
});

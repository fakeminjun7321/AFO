/**
 * #10 / #11 / #12 verifier, round 2 (commit under test fc5ffc0). Independent of the builder's tests and helpers.
 * Covers the round-1 defects D1 (session binding) and D2 (undo of an unclear forward move), the root lock wired into
 * executeBatch/undoRun (same process and a separate child `node` process), and #8 O-1 through the real
 * savePlan → issueApproval → consumeApproval path with files changed after consumption.
 * Synthetic mkdtemp(os.tmpdir()) folders and a temp state folder only. Before/after manifests (path, size, sha256), raw journal
 * lines, runs/ and the report are compared. Tests that pass `adapter` to simulate an OS result are marked (mock).
 * Gated: AFO_REAL_TRASH_TEST=1 (real OS trash, afo-test- files only, never empties the trash).
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, unlink, utimes, writeFile }
  from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AfoError, ApprovalSchema, OperationPlanSchema, PERMANENT_DELETE_PHRASE, PlanOperationSchema } from '../packages/contracts/src/index.js';
import type { Approval, ApprovalMode, ErrorCode, ExecutionReport, OperationKind, OperationPlan, PlanOperation, RootGrant }
  from '../packages/contracts/src/index.js';
import { approvalChoices, approvalCode, buildPlan, buildPreview } from '../packages/engine/src/index.js';
import { hashCandidates, scanRoot } from '../packages/filesystem/src/index.js';
import { issueRootGrant } from '../packages/filesystem/src/grants.js';
import { consumeApproval, issueApproval, savePlan } from '../packages/filesystem/src/approvals.js';
import { executeBatch, listRuns, readRun, undoRun } from '../packages/filesystem/src/executor.js';
import type { ApprovedBatch } from '../packages/filesystem/src/executor.js';
import { LOCK_RELEASE_WARNING, readRootLock, rootLockFile, withRootLock } from '../packages/filesystem/src/lock.js';
import { PlatformError, linkMoveNoClobber, moveToTrash } from '../packages/filesystem/src/platform.js';

const sh = promisify(execFile);
const PFX = 'afo-test-';
const posix = process.platform !== 'win32';
const darwin = process.platform === 'darwin';
const realTrash = process.env['AFO_REAL_TRASH_TEST'] === '1';
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const shaOf = async (p: string): Promise<string> => sha(await readFile(p));
const iso = (ms: number): string => new Date(ms).toISOString();
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
const WHEN = new Date('2026-02-03T04:05:06Z'); // whole seconds: utimes restores mtimeNs exactly

/* ---------- independent fixture / plan / approval helpers (copy of the round-1 block, plus #8-path helpers) ---------- */
interface Env { base: string; root: string; outside: string; stateDir: string; grant: RootGrant }
async function setup(t: TestContext): Promise<Env> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), `${PFX}v1012r2-`)));
  const root = path.join(base, 'root'); const outside = path.join(base, 'outside'); const stateDir = path.join(base, 'state');
  await Promise.all([mkdir(root), mkdir(outside), mkdir(stateDir)]);
  t.after(async () => {
    if (darwin) await sh('chflags', ['-R', 'nouchg', base]).catch(() => undefined);
    if (posix) await sh('chmod', ['-R', 'u+rwx', base]).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, outside, stateDir, grant: await issueRootGrant(root) };
}
const A = (e: Env, rel: string): string => path.join(e.root, ...rel.split('/'));
async function put(p: string, content: string | Buffer, mtime?: Date): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
  if (mtime !== undefined) await utimes(p, mtime, mtime);
}
/** rel path → 'd' | 'l:<target>' | 'f:<size>:<sha256>' */
async function manifest(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const name of (await readdir(d)).sort()) {
      const p = path.join(d, name); const r = rel ? `${rel}/${name}` : name; const s = await lstat(p);
      if (s.isSymbolicLink()) out[r] = `l:${await readlink(p)}`;
      else if (s.isDirectory()) { out[r] = 'd'; await walk(p, r); }
      else out[r] = `f:${s.size}:${await shaOf(p)}`;
    }
  };
  await walk(dir, '');
  return out;
}

let idSeq = 0x20000000;
const nextId = (): string => (++idSeq).toString(16);
async function op(e: Env, kind: OperationKind, source: string,
  more: { destination?: string; keeper?: string; hash?: boolean } = {}): Promise<PlanOperation> {
  const s = await lstat(A(e, source), { bigint: true });
  const keeper = more.keeper ?? null;
  return PlanOperationSchema.parse({ id: nextId(), kind, fileId: sha(`${source}#${idSeq}`), source, destination: more.destination ?? null,
    reason: 'verify', ruleId: null, keeper,
    expected: { size: Number(s.size), modifiedNs: String(s.mtimeNs), device: String(s.dev), inode: String(s.ino),
      sha256: more.hash === true || keeper !== null ? await shaOf(A(e, source)) : null } });
}
function makePlan(grant: RootGrant, ops: PlanOperation[], deleteMode: 'trash' | 'permanent', over: { sessionId?: string } = {}): OperationPlan {
  const now = Date.now(); const count = (k: OperationKind): number => ops.filter((o) => o.kind === k).length;
  const body = { formatVersion: 1, rootGrantId: grant.id, rootPath: grant.canonicalPath, sessionId: over.sessionId ?? grant.sessionId,
    createdAt: iso(now), expiresAt: iso(now + 3_600_000), profileId: null, profileRevision: null, deleteMode, operations: ops,
    reviewItems: [], summary: { move: count('move'), trash: count('trash'), delete: count('delete'),
      logicalBytes: ops.reduce((n, o) => n + o.expected.size, 0) } };
  return OperationPlanSchema.parse({ ...body, id: sha(JSON.stringify(body)) });
}
function makeApproval(p: OperationPlan, ids: string[], mode: ApprovalMode, over: Partial<Approval> = {}): Approval {
  const now = Date.now();
  return ApprovalSchema.parse({ formatVersion: 1, id: randomUUID(), planId: p.id, sessionId: p.sessionId, rootGrantId: p.rootGrantId,
    operationIds: [...ids].sort(), mode, profileId: null, profileRevision: null, issuedAt: iso(now - 1000),
    expiresAt: iso(now + 5 * 60_000), usedAt: iso(now), ...over });
}
function makeBatch(e: Env, p: OperationPlan, a: Approval, grant?: RootGrant, stateDir?: string): ApprovedBatch {
  const byId = new Map(p.operations.map((o) => [o.id, o]));
  return { plan: p, approval: a, grant: grant ?? e.grant, stateDir: stateDir ?? e.stateDir, operations: a.operationIds.map((id) => byId.get(id)!) };
}
function approveAll(e: Env, ops: PlanOperation[], mode: ApprovalMode, stateDir?: string): ApprovedBatch {
  const p = makePlan(e.grant, ops, mode === 'permanent-delete' ? 'permanent' : 'trash');
  return makeBatch(e, p, makeApproval(p, ops.map((o) => o.id), mode), undefined, stateDir);
}
async function journalLines(stateDir: string, runId: string): Promise<string[]> {
  try { return (await readFile(path.join(stateDir, 'journal', `${runId}.jsonl`), 'utf8')).split('\n').filter((l) => l !== ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
const phases = async (stateDir: string, runId: string): Promise<string[]> => (await journalLines(stateDir, runId)).map((l) => {
  const j = JSON.parse(l) as { opId: string; phase: string; errorCode: string | null };
  return `${j.opId}:${j.phase}${j.errorCode ? `:${j.errorCode}` : ''}`;
});
const statuses = (r: ExecutionReport): string[] => r.results.map((x) => `${x.opId}:${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`);
async function rejectsWith(p: Promise<unknown>, code: ErrorCode, message?: RegExp): Promise<void> {
  await assert.rejects(p, (error: unknown) => {
    assert.ok(error instanceof AfoError, `expected AfoError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}
const manifestDirs = (m: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(m).filter(([, v]) => v === 'd'));
/** Everything under the state folder: relative path → size:sha256 (files) or 'd'. */
async function stateTree(stateDir: string): Promise<Record<string, string>> { return manifest(stateDir); }

/* ---------- child process holding the root lock ---------- */
const here = path.dirname(fileURLToPath(import.meta.url));
const distUrl = (rel: string): string => pathToFileURL(path.join(here, '..', 'packages', 'filesystem', 'src', rel)).href;
interface Holder { child: ChildProcess; info: { pid: number; canonicalPath: string; sessionId: string; grantId: string } }
/** Writes a temp .mjs that imports dist lock.js/grants.js, issues its own grant from `spelling` and holds the lock until stdin ends. */
async function holdLockInChild(e: Env, stateDir: string, spelling: string): Promise<Holder> {
  const script = path.join(e.base, `${PFX}lock-holder-${randomUUID()}.mjs`);
  await writeFile(script, `
    import { withRootLock } from ${JSON.stringify(distUrl('lock.js'))};
    import { issueRootGrant } from ${JSON.stringify(distUrl('grants.js'))};
    const [stateDir, spelling] = process.argv.slice(2);
    const grant = await issueRootGrant(spelling);
    await withRootLock(stateDir, grant, async () => {
      process.stdout.write(JSON.stringify({ pid: process.pid, canonicalPath: grant.canonicalPath, sessionId: grant.sessionId, grantId: grant.id }) + '\\n');
      await new Promise((resolve) => { process.stdin.on('end', resolve); process.stdin.resume(); });
    });
    process.stdout.write('released\\n');
  `);
  const child = spawn(process.execPath, [script, stateDir, spelling], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  const info = await new Promise<Holder['info']>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl >= 0) { try { resolve(JSON.parse(out.slice(0, nl)) as Holder['info']); } catch (error) { reject(error); } }
    });
    child.on('exit', (code) => reject(new Error(`lock holder exited early (${String(code)}): ${err}`)));
  });
  return { child, info };
}
async function releaseChild(h: Holder): Promise<number | null> {
  const exited = once(h.child, 'exit');
  h.child.stdin!.end();
  const [code] = await exited as [number | null];
  return code;
}

/* ============================ D1: session binding ============================ */

test('R2-D1 foreign session grant / approval / plan and another rootGrantId are refused; state folder and files unchanged', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}s.txt`), 'session');
  const o = await op(e, 'move', `${PFX}s.txt`, { destination: `d/${PFX}s.txt` });
  const p = makePlan(e.grant, [o], 'trash');
  const foreign = randomUUID();
  const foreignGrant = await issueRootGrant(e.root, { sessionId: foreign }); // same folder, issued here, other session
  const pForeign = makePlan(foreignGrant, [o], 'trash');                      // plan of the foreign session
  const pOtherSessionOnly = makePlan(e.grant, [o], 'trash', { sessionId: foreign }); // plan.sessionId ≠ grant.sessionId
  const before = await manifest(e.root);
  const cases: Array<[string, ApprovedBatch, ErrorCode, RegExp]> = [
    ['grant of another session', makeBatch(e, p, makeApproval(p, [o.id], 'organize'), foreignGrant), 'ROOT_FORBIDDEN', /다른 세션/u],
    ['approval of another session', makeBatch(e, p, makeApproval(p, [o.id], 'organize', { sessionId: foreign })), 'APPROVAL_INVALID', /다른 세션/u],
    ['approval with another rootGrantId', makeBatch(e, p, makeApproval(p, [o.id], 'organize', { rootGrantId: sha('other-grant') })), 'APPROVAL_INVALID', /다른 계획·폴더/u],
    ['plan.sessionId differs from the grant', makeBatch(e, pOtherSessionOnly, makeApproval(pOtherSessionOnly, [o.id], 'organize')), 'ROOT_FORBIDDEN', /다른 세션/u],
    ['foreign plan+approval, this session grant', makeBatch(e, pForeign, makeApproval(pForeign, [o.id], 'organize')), 'ROOT_FORBIDDEN', /다른 세션/u],
  ];
  for (const [label, b, code, msg] of cases) await t.test(label, async () => { await rejectsWith(executeBatch(b), code, msg); });
  assert.deepEqual(await manifest(e.root), before);
  assert.deepEqual(await readdir(e.stateDir), [], 'no locks/, runs/ or journal/ for refused batches');

  // Same session, re-issued grant (other id, like consumeApproval's regrant): runs.
  const reissued = await issueRootGrant(e.root, { sessionId: e.grant.sessionId });
  assert.notEqual(reissued.id, e.grant.id);
  const report = await executeBatch(makeBatch(e, p, makeApproval(p, [o.id], 'organize'), reissued));
  assert.deepEqual(statuses(report), [`${o.id}:moved`]);
  assert.equal(await readFile(A(e, `d/${PFX}s.txt`), 'utf8'), 'session');
  assert.equal(await exists(A(e, `${PFX}s.txt`)), false);
  // A foreign session is accepted only when plan, approval and grant all carry it (the grant is still issued by this process).
  await put(A(e, `${PFX}f.txt`), 'foreign-consistent');
  const of = await op(e, 'move', `${PFX}f.txt`, { destination: `d/${PFX}f.txt` });
  const pf = makePlan(foreignGrant, [of], 'trash');
  const rf = await executeBatch(makeBatch(e, pf, makeApproval(pf, [of.id], 'organize'), foreignGrant));
  t.diagnostic(`plan+approval+grant all in session ${foreign.slice(0, 8)}… → ${statuses(rf).join(',')}`);
  assert.deepEqual(statuses(rf), [`${of.id}:moved`]);
});

/* ============================ D2: undo of an unclear forward move ============================ */

test('R2-D2 undo reports a forward failed+UNKNOWN move as unknown and never moves it back; definite failures are omitted; repeatable (mock)', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}ok.txt`), 'ok');            // moved normally
  await put(A(e, `${PFX}unclear.txt`), 'unclear');  // real move, then the adapter says UNKNOWN (mock)
  await put(A(e, `${PFX}perm.txt`), 'perm');        // real move, then the adapter says PERMISSION_DENIED (mock) → intact() false → unknown
  await put(A(e, `${PFX}taken.txt`), 'taken');      // destination already exists → definite failed DEST_EXISTS
  await put(A(e, `d/${PFX}taken.txt`), 'occupant');
  const ok = await op(e, 'move', `${PFX}ok.txt`, { destination: `d/${PFX}ok.txt` });
  const un = await op(e, 'move', `${PFX}unclear.txt`, { destination: `d/${PFX}unclear.txt` });
  const pe = await op(e, 'move', `${PFX}perm.txt`, { destination: `d/${PFX}perm.txt` });
  const tk = await op(e, 'move', `${PFX}taken.txt`, { destination: `d/${PFX}taken.txt` });
  const lie: Record<string, 'UNKNOWN' | 'PERMISSION_DENIED'> = { [A(e, `${PFX}unclear.txt`)]: 'UNKNOWN', [A(e, `${PFX}perm.txt`)]: 'PERMISSION_DENIED' };
  const report = await executeBatch(approveAll(e, [ok, un, pe, tk], 'organize'), { adapter: {
    linkMoveNoClobber: async (s, d, x) => { const id = await linkMoveNoClobber(s, d, x); const c = lie[s]; if (c) throw new PlatformError(c, 'sim'); return id; } } });
  assert.deepEqual(statuses(report), [`${ok.id}:moved`, `${un.id}:unknown:UNKNOWN`, `${pe.id}:unknown:UNKNOWN`, `${tk.id}:failed:DEST_EXISTS`]);
  assert.deepEqual(await phases(e.stateDir, report.runId), [`${ok.id}:intent`, `${ok.id}:done`, `${un.id}:intent`, `${un.id}:failed:UNKNOWN`,
    `${pe.id}:intent`, `${pe.id}:failed:UNKNOWN`, `${tk.id}:intent`, `${tk.id}:failed:DEST_EXISTS`]);
  const afterRun = await manifest(e.root);
  const journalAfterRun = await journalLines(e.stateDir, report.runId);

  const u1 = await undoRun(e.stateDir, report.runId, e.grant);
  assert.deepEqual(statuses(u1), [`${ok.id}:moved`, `${un.id}:unknown:UNKNOWN`, `${pe.id}:unknown:UNKNOWN`], 'DEST_EXISTS (definite) not listed');
  assert.match(u1.results[1]!.detail, /결과 불명/u);
  // Unclear files stay where they are (at the destination); only the confirmed move went back.
  const expected = { ...afterRun };
  delete expected[`d/${PFX}ok.txt`]; expected[`${PFX}ok.txt`] = afterRun[`d/${PFX}ok.txt`]!;
  assert.deepEqual(await manifest(e.root), expected);
  assert.equal(await readFile(A(e, `d/${PFX}unclear.txt`), 'utf8'), 'unclear');
  assert.equal(await readFile(A(e, `d/${PFX}taken.txt`), 'utf8'), 'occupant');
  // Undo journaled only the confirmed op.
  const added = (await journalLines(e.stateDir, report.runId)).slice(journalAfterRun.length).map((l) => JSON.parse(l) as { opId: string; phase: string });
  assert.deepEqual(added.map((x) => `${x.opId}:${x.phase}`), [`${ok.id}:undo-intent`, `${ok.id}:undone`]);

  // Second and third undo: still unknown for the unclear ones, nothing moved, nothing journaled.
  const m1 = await manifest(e.root); const j1 = await journalLines(e.stateDir, report.runId);
  for (let i = 0; i < 2; i += 1) {
    const u = await undoRun(e.stateDir, report.runId, e.grant);
    assert.deepEqual(statuses(u), [`${un.id}:unknown:UNKNOWN`, `${pe.id}:unknown:UNKNOWN`]);
  }
  assert.deepEqual(await manifest(e.root), m1);
  assert.deepEqual(await journalLines(e.stateDir, report.runId), j1);
  const rec = await readRun(e.stateDir, report.runId);
  assert.deepEqual(rec?.undos.map((x) => x.undoIndex), [1, 2, 3]);
  assert.deepEqual(statuses(rec!.run.report!), statuses(report), 'original report kept');
});

/* ============================ root lock ============================ */

test('R2-L1 same process: lock held → executeBatch and undoRun LOCKED_BY_OTHER (any grant/session), nothing written; after release both run', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}a.txt`), 'a'); await put(A(e, `${PFX}b.txt`), 'b');
  const a = await op(e, 'move', `${PFX}a.txt`, { destination: `x/${PFX}a.txt` });
  const first = await executeBatch(approveAll(e, [a], 'organize'));
  const b = await op(e, 'move', `${PFX}b.txt`, { destination: `x/${PFX}b.txt` });
  const batch = approveAll(e, [b], 'organize');
  const otherSession = await issueRootGrant(e.root, { sessionId: randomUUID() });
  const before = await manifest(e.root); const stateBefore = await stateTree(e.stateDir);
  // The lock is taken through a grant of another session: the key is the folder's dev/inode only.
  await withRootLock(e.stateDir, otherSession, async () => {
    assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'held');
    await rejectsWith(executeBatch(batch), 'LOCKED_BY_OTHER');
    await rejectsWith(executeBatch({ ...batch, grant: await issueRootGrant(e.root, { sessionId: e.grant.sessionId }) }), 'LOCKED_BY_OTHER');
    await rejectsWith(undoRun(e.stateDir, first.runId, e.grant), 'LOCKED_BY_OTHER');
    await rejectsWith(undoRun(e.stateDir, first.runId, otherSession), 'LOCKED_BY_OTHER');
    assert.deepEqual(await manifest(e.root), before);
    const now = await stateTree(e.stateDir);
    const lockKey = Object.keys(now).find((k) => k.startsWith('locks/') && k.endsWith('.lock'))!;
    delete now[lockKey];
    assert.deepEqual(now, stateBefore, 'no .approval marker, run record, journal line or undo record');
  });
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
  assert.deepEqual(statuses(await executeBatch(batch)), [`${b.id}:moved`], 'the refused attempt did not spend the approval');
  assert.deepEqual(statuses(await undoRun(e.stateDir, first.runId, e.grant)), [`${a.id}:moved`]);
  assert.equal(await readFile(A(e, `${PFX}a.txt`), 'utf8'), 'a');
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
});

test('R2-L2 same process: two batches on the same file started together → one runs, the other is refused or finds nothing; file moved once', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}race.txt`), 'race');
  const o1 = await op(e, 'move', `${PFX}race.txt`, { destination: `one/${PFX}race.txt` });
  const o2 = await op(e, 'move', `${PFX}race.txt`, { destination: `two/${PFX}race.txt` });
  const settled = await Promise.allSettled([executeBatch(approveAll(e, [o1], 'organize')), executeBatch(approveAll(e, [o2], 'organize'))]);
  const outcome = settled.map((s) => s.status === 'fulfilled' ? statuses(s.value)[0]!.split(':').slice(1).join(':')
    : `rejected:${(s.reason as AfoError).code}`);
  t.diagnostic(`outcomes: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.filter((x) => x === 'moved').length, 1);
  assert.ok(outcome.every((x) => ['moved', 'rejected:LOCKED_BY_OTHER', 'failed:SOURCE_MISSING'].includes(x)));
  const m = await manifest(e.root);
  assert.equal(Object.entries(m).filter(([k, v]) => k.endsWith(`${PFX}race.txt`) && v.startsWith('f:')).length, 1);
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
});

test('R2-L3 separate process: a child node holding the lock (other spelling, own grant/session) blocks executeBatch and undoRun; after exit both run', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}a.txt`), 'a'); await put(A(e, `${PFX}b.txt`), 'b');
  const a = await op(e, 'move', `${PFX}a.txt`, { destination: `x/${PFX}a.txt` });
  const first = await executeBatch(approveAll(e, [a], 'organize'));
  const b = await op(e, 'move', `${PFX}b.txt`, { destination: `x/${PFX}b.txt` });
  const batch = approveAll(e, [b], 'organize');
  // macOS: tmpdir() is /var/folders/… (via the /var link) while e.root is the real /private/var/… path.
  const spelling = path.join(tmpdir(), path.basename(e.base), 'root');
  const h = await holdLockInChild(e, e.stateDir, spelling);
  t.after(() => { h.child.kill('SIGKILL'); });
  t.diagnostic(`child pid ${h.info.pid} (parent ${process.pid}) spelling ${spelling === e.root ? 'same' : 'other'}; child grant ${h.info.grantId.slice(0, 8)}… session ${h.info.sessionId.slice(0, 8)}…`);
  assert.notEqual(h.info.pid, process.pid);
  assert.notEqual(h.info.sessionId, e.grant.sessionId);
  assert.equal(h.info.canonicalPath, e.root);
  const before = await manifest(e.root); const stateBefore = await stateTree(e.stateDir);
  const lock = await readRootLock(e.stateDir, e.grant);
  assert.deepEqual([lock.state, lock.holder?.pid], ['held', h.info.pid]);
  await rejectsWith(executeBatch(batch), 'LOCKED_BY_OTHER', new RegExp(`pid ${h.info.pid}`, 'u'));
  await rejectsWith(undoRun(e.stateDir, first.runId, e.grant), 'LOCKED_BY_OTHER');
  assert.deepEqual(await manifest(e.root), before);
  assert.deepEqual(await stateTree(e.stateDir), stateBefore, 'runs/, journal and approval markers unchanged');
  assert.equal(await releaseChild(h), 0);
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
  assert.deepEqual(statuses(await executeBatch(batch)), [`${b.id}:moved`]);
  assert.deepEqual(statuses(await undoRun(e.stateDir, first.runId, e.grant)), [`${a.id}:moved`]);
  assert.equal(await readFile(A(e, `x/${PFX}b.txt`), 'utf8'), 'b');
  assert.equal(await readFile(A(e, `${PFX}a.txt`), 'utf8'), 'a');
});

test('R2-L4 separate process killed (SIGKILL) while holding: stale lock is taken over by the next run; another state folder is not covered (observation)', { skip: !posix && 'POSIX signals' }, async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}k.txt`), 'k'); await put(A(e, `${PFX}s.txt`), 's');
  const h = await holdLockInChild(e, e.stateDir, e.root);
  const exited = once(h.child, 'exit');
  h.child.kill('SIGKILL'); await exited;
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'stale');
  const k = await op(e, 'move', `${PFX}k.txt`, { destination: `x/${PFX}k.txt` });
  assert.deepEqual(statuses(await executeBatch(approveAll(e, [k], 'organize'))), [`${k.id}:moved`]);
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
  assert.deepEqual((await readdir(path.join(e.stateDir, 'locks'))), [], 'stale file and .stale-* side file removed');

  // Observation: the lock lives in the state folder. A holder using another state folder does not block this one.
  const otherState = path.join(e.base, 'state-other');
  const h2 = await holdLockInChild(e, otherState, e.root);
  t.after(() => { h2.child.kill('SIGKILL'); });
  const s = await op(e, 'move', `${PFX}s.txt`, { destination: `x/${PFX}s.txt` });
  const r = await executeBatch(approveAll(e, [s], 'organize'));
  t.diagnostic(`child holds ${path.basename(otherState)}/locks for the same root; this run with ${path.basename(e.stateDir)}: ${statuses(r).join(',')}`);
  assert.deepEqual(statuses(r), [`${s.id}:moved`]);
  assert.equal(await releaseChild(h2), 0);
});

test('R2-L5 a throw inside the locked section releases the lock (faultInjection after-op; corrupt journal in undo); release failure after a run keeps runs/ (STATE_CORRUPT)', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}a.txt`), 'a'); await put(A(e, `${PFX}b.txt`), 'b'); await put(A(e, `${PFX}c.txt`), 'c');
  const a = await op(e, 'move', `${PFX}a.txt`, { destination: `x/${PFX}a.txt` });
  const crash = new Error('sim crash');
  await assert.rejects(executeBatch(approveAll(e, [a], 'organize'), { faultInjection: (point) => { if (point === 'after-op') throw crash; } }),
    (err) => err === crash);
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
  const [crashedRun] = await listRuns(e.stateDir);
  assert.deepEqual(await phases(e.stateDir, crashedRun!), [`${a.id}:intent`], 'crash after the OS call: intent only');
  assert.equal(await readFile(A(e, `x/${PFX}a.txt`), 'utf8'), 'a');
  // Next run is not blocked.
  const b = await op(e, 'move', `${PFX}b.txt`, { destination: `x/${PFX}b.txt` });
  const rb = await executeBatch(approveAll(e, [b], 'organize'));
  assert.deepEqual(statuses(rb), [`${b.id}:moved`]);
  // Undo throws STATE_CORRUPT inside the lock (corrupt journal line) → lock released, files unchanged.
  await appendFile(path.join(e.stateDir, 'journal', `${rb.runId}.jsonl`), '{not json\n');
  const m = await manifest(e.root);
  await rejectsWith(undoRun(e.stateDir, rb.runId, e.grant), 'STATE_CORRUPT');
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
  assert.deepEqual(await manifest(e.root), m);

  // Release failure after a finished run: the lock file is replaced mid-run by another valid holder (other token).
  const c = await op(e, 'move', `${PFX}c.txt`, { destination: `x/${PFX}c.txt` });
  const lockFile = rootLockFile(e.stateDir, e.grant);
  const foreign = `${JSON.stringify({ formatVersion: 1, pid: process.pid, hostname: hostname(),
    startedAt: new Date().toISOString(), token: 'f'.repeat(32) })}\n`;
  const runsBefore = new Set(await listRuns(e.stateDir));
  await rejectsWith(executeBatch(approveAll(e, [c], 'organize'), { onProgress: () => { writeFileSync(lockFile, foreign); } }),
    'STATE_CORRUPT', /작업은 끝났지만/u);
  const [runC] = (await listRuns(e.stateDir)).filter((r) => !runsBefore.has(r));
  const rec = await readRun(e.stateDir, runC!);
  assert.deepEqual(statuses(rec!.run.report!), [`${c.id}:moved`], 'runs/<runId>.json holds the report');
  assert.notEqual(rec!.run.finishedAt, null);
  assert.deepEqual(await phases(e.stateDir, runC!), [`${c.id}:intent`, `${c.id}:done`]);
  assert.equal(await readFile(A(e, `x/${PFX}c.txt`), 'utf8'), 'c');
  assert.equal(await readFile(lockFile, 'utf8'), foreign, 'a lock that is not ours is left in place');
  await unlink(lockFile);

  // fn throws and release also fails: the original error propagates, the release failure is a process warning.
  await put(A(e, `${PFX}d.txt`), 'd');
  const d = await op(e, 'move', `${PFX}d.txt`, { destination: `x/${PFX}d.txt` });
  const warnings: string[] = [];
  const onWarning = (w: Error & { code?: string }): void => { if (w.code === LOCK_RELEASE_WARNING) warnings.push(w.message); };
  process.on('warning', onWarning);
  try {
    await assert.rejects(executeBatch(approveAll(e, [d], 'organize'), { faultInjection: (point) => {
      if (point === 'after-intent') { rmSync(lockFile, { force: true }); throw crash; } } }), (err) => err === crash);
    await new Promise((r) => setImmediate(r));
  } finally { process.off('warning', onWarning); }
  t.diagnostic(`release warnings: ${warnings.length}`);
  assert.equal(warnings.length, 1);
  assert.equal(await readFile(A(e, `${PFX}d.txt`), 'utf8'), 'd');
  assert.equal((await readRootLock(e.stateDir, e.grant)).state, 'free');
});

/* ============================ #8 O-1 through the real approval path ============================ */

interface Real { e: Env; plan: OperationPlan; byName: (name: string) => PlanOperation; keeperOf: (o: PlanOperation) => string }
/** scan → hash → preview → buildPlan → savePlan. Files get whole-second mtimes so they can be restored exactly. */
async function realPlan(t: TestContext, files: Record<string, string>, deleteMode: 'trash' | 'permanent', dups: boolean): Promise<Real> {
  const e = await setup(t);
  for (const [rel, data] of Object.entries(files)) await put(A(e, rel), data, WHEN);
  const scan = await hashCandidates(e.grant, await scanRoot(e.grant));
  const plan = buildPlan(buildPreview(scan), { scan, grant: e.grant, sessionId: e.grant.sessionId, deleteMode, now: new Date(),
    ...(dups ? { deleteSelections: 'all-duplicates' as const } : {}) });
  await savePlan(e.stateDir, plan, e.grant);
  const bySource = new Map(plan.operations.map((o) => [o.source, o]));
  return { e, plan, byName: (name) => { const o = bySource.get(name); assert.ok(o, `${name} is planned: ${[...bySource.keys()].join(',')}`); return o; },
    keeperOf: (o) => { assert.ok(o.keeper); return o.keeper; } };
}
async function approveReal(r: Real, mode: ApprovalMode): Promise<ApprovedBatch> {
  const ids = approvalChoices(r.plan).find((c) => c.mode === mode)!.operationIds;
  const approval = await issueApproval(r.e.stateDir, { planId: r.plan.id, operationIds: ids, mode,
    confirmation: approvalCode(r.plan.id, ids, mode), ...(mode === 'permanent-delete' ? { confirmPhrase: PERMANENT_DELETE_PHRASE } : {}) });
  return consumeApproval(r.e.stateDir, approval.id);
}
/** Same size, other content, mtime restored: only the sha256 can tell. */
async function sameSizeEdit(p: string): Promise<void> {
  const old = await readFile(p);
  const next = Buffer.from(old); next[0] = next[0] === 0x5a ? 0x59 : 0x5a;
  await writeFile(p, next); await utimes(p, WHEN, WHEN);
}
/** Same name, same size and mtime, new inode. */
async function replaceInode(p: string, data: string): Promise<void> {
  const tmp = `${p}.new`;
  await writeFile(tmp, data); await utimes(tmp, WHEN, WHEN);
  await unlink(p); await rename(tmp, p);
}

test('R2-O1a organize: files changed after consumeApproval → FILE_CHANGED/SOURCE_MISSING/DEST_EXISTS, changed files kept, destinations empty, rest moved', async (t) => {
  const r = await realPlan(t, {
    [`${PFX}grow.pdf`]: 'grow-content-0001',
    [`${PFX}same1.pdf`]: 'SAME-SIZE-CONTENT-A', [`${PFX}same2.pdf`]: 'SAME-SIZE-CONTENT-B', // same size → both hashed
    [`${PFX}inode.pdf`]: 'inode-swap-data',
    [`${PFX}gone.pdf`]: 'gone-soon',
    [`${PFX}occupied.jpg`]: 'occupied-dest',
    [`${PFX}ok.jpg`]: 'picture-ok',
  }, 'trash', false);
  const { e } = r;
  const [grow, same1, same2, ino, gone, occ, ok] = ['grow.pdf', 'same1.pdf', 'same2.pdf', 'inode.pdf', 'gone.pdf', 'occupied.jpg', 'ok.jpg']
    .map((n) => r.byName(`${PFX}${n}`));
  assert.notEqual(same1!.expected.sha256, null);
  const batch = await approveReal(r, 'organize');
  assert.equal(batch.grant.sessionId, r.plan.sessionId);
  assert.notEqual(batch.grant.id, r.plan.rootGrantId, 'regranted in consumeApproval');

  await appendFile(A(e, grow!.source), '+'); await utimes(A(e, grow!.source), WHEN, WHEN);
  await sameSizeEdit(A(e, same1!.source));
  await replaceInode(A(e, ino!.source), 'inode-swap-data');
  await unlink(A(e, gone!.source));
  await put(A(e, occ!.destination!), 'user put this here');
  const before = await manifest(e.root);

  const report = await executeBatch(batch);
  const st = new Map(report.results.map((x) => [x.opId, `${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`]));
  assert.deepEqual([grow, same1, ino, gone, occ, same2, ok].map((o) => st.get(o!.id)),
    ['failed:FILE_CHANGED', 'failed:FILE_CHANGED', 'failed:FILE_CHANGED', 'failed:SOURCE_MISSING', 'failed:DEST_EXISTS', 'moved', 'moved']);
  assert.match(report.results.find((x) => x.opId === same1!.id)!.detail, /내용이 바뀌었습니다/u);
  // Expected manifest: only same2 and ok moved; everything else byte-identical to after the user's changes.
  const want = { ...before };
  for (const o of [same2, ok]) { want[o!.destination!] = before[o!.source]!; delete want[o!.source]; }
  for (const k of Object.keys(manifestDirs(await manifest(e.root)))) want[k] ??= 'd';
  assert.deepEqual(await manifest(e.root), want);
  for (const o of [grow, same1, ino, gone]) assert.equal(await exists(A(e, o!.destination!)), false, o!.source);
  assert.equal(await readFile(A(e, occ!.destination!), 'utf8'), 'user put this here');
  const lines = (await journalLines(e.stateDir, report.runId)).map((l) => JSON.parse(l) as { opId: string; phase: string });
  assert.equal(lines.filter((x) => x.phase === 'intent').length, 7);
  assert.equal(lines.filter((x) => x.phase === 'done').length, 2);
  await rejectsWith(consumeApproval(e.stateDir, batch.approval.id), 'APPROVAL_USED');
  await rejectsWith(executeBatch(batch), 'APPROVAL_USED');
});

test('R2-O1b permanent delete: keeper edited/deleted after consumeApproval → KEEPER_INVALID, candidate kept; changed candidate FILE_CHANGED; unchanged group deleted', async (t) => {
  const r = await realPlan(t, {
    [`${PFX}ka-1.txt`]: 'group-A-content', [`${PFX}ka-2.txt`]: 'group-A-content',
    [`${PFX}kb-1.txt`]: 'group-B-content', [`${PFX}kb-2.txt`]: 'group-B-content',
    [`${PFX}kc-1.txt`]: 'group-C-content', [`${PFX}kc-2.txt`]: 'group-C-content',
    [`${PFX}kd-1.txt`]: 'group-D-content', [`${PFX}kd-2.txt`]: 'group-D-content',
  }, 'permanent', true);
  const { e } = r;
  const dels = r.plan.operations.filter((o) => o.kind === 'delete');
  assert.equal(dels.length, 4);
  const byGroup = (g: string): PlanOperation => dels.find((o) => o.source.includes(`k${g}-`))!;
  const [opA, opB, opC, opD] = ['a', 'b', 'c', 'd'].map(byGroup);
  const batch = await approveReal(r, 'permanent-delete');
  await sameSizeEdit(A(e, r.keeperOf(opA!)));          // A: keeper same size, other content, mtime restored
  await unlink(A(e, r.keeperOf(opB!)));                // B: keeper deleted
  await sameSizeEdit(A(e, opC!.source));               // C: candidate itself edited (same size, mtime restored)
  const before = await manifest(e.root);
  const report = await executeBatch(batch);
  const st = new Map(report.results.map((x) => [x.opId, `${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`]));
  assert.deepEqual([opA, opB, opC, opD].map((o) => st.get(o!.id)), ['failed:KEEPER_INVALID', 'failed:KEEPER_INVALID', 'failed:FILE_CHANGED', 'deleted']);
  const want = { ...before }; delete want[opD!.source];
  assert.deepEqual(await manifest(e.root), want, 'only the unchanged group D candidate is gone; keepers and changed files intact');
  assert.equal(await readFile(A(e, r.keeperOf(opD!)), 'utf8'), 'group-D-content');
  assert.notEqual(report.space.freeBytesBefore, null);
});

test('R2-O1c trash: keeper edited after consumeApproval → KEEPER_INVALID and the OS trash is never called (guard adapter, not a mock result)', async (t) => {
  const r = await realPlan(t, { [`${PFX}tk-1.txt`]: 'trash-group', [`${PFX}tk-2.txt`]: 'trash-group' }, 'trash', true);
  const { e } = r;
  const [del] = r.plan.operations.filter((o) => o.kind === 'trash');
  const batch = await approveReal(r, 'trash');
  await sameSizeEdit(A(e, r.keeperOf(del!)));
  const before = await manifest(e.root);
  let calls = 0;
  const report = await executeBatch(batch, { adapter: { moveToTrash: async () => { calls += 1; throw new PlatformError('NOT_SUPPORTED', 'guard'); } } });
  assert.deepEqual(statuses(report), [`${del!.id}:failed:KEEPER_INVALID`]);
  assert.equal(calls, 0);
  assert.deepEqual(await manifest(e.root), before);
  assert.equal(report.space.freeBytesBefore, null);
});

test('R2-O1d real OS trash through the #8 path: unchanged duplicate trashed, keeper kept; changed keeper refused (AFO_REAL_TRASH_TEST=1, macOS)', { skip: !(realTrash && darwin) && 'AFO_REAL_TRASH_TEST=1 (macOS) 에서만 실제 휴지통 검사' }, async (t) => {
  const tag = randomUUID().slice(0, 8);
  const r = await realPlan(t, {
    [`${PFX}r2-${tag}-g1-a.txt`]: `real-trash-1-${tag}`, [`${PFX}r2-${tag}-g1-b.txt`]: `real-trash-1-${tag}`,
    [`${PFX}r2-${tag}-g2-a.txt`]: `real-trash-2-${tag}`, [`${PFX}r2-${tag}-g2-b.txt`]: `real-trash-2-${tag}`,
  }, 'trash', true);
  const { e } = r;
  const ops = r.plan.operations.filter((o) => o.kind === 'trash');
  const g1 = ops.find((o) => o.source.includes('-g1-'))!; const g2 = ops.find((o) => o.source.includes('-g2-'))!;
  assert.ok(ops.every((o) => path.basename(o.source).startsWith(PFX)));
  const batch = await approveReal(r, 'trash');
  await sameSizeEdit(A(e, r.keeperOf(g2)));
  const before = await manifest(e.root);
  let calls = 0;
  const report = await executeBatch(batch, { adapter: { moveToTrash: async (p, x) => { calls += 1; assert.ok(path.basename(p).startsWith(PFX)); return moveToTrash(p, x); } } });
  const st = new Map(report.results.map((x) => [x.opId, `${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`]));
  assert.deepEqual([st.get(g1.id), st.get(g2.id)], ['trashed', 'failed:KEEPER_INVALID']);
  assert.equal(calls, 1);
  const want = { ...before }; delete want[g1.source];
  assert.deepEqual(await manifest(e.root), want);
  try {
    const inTrash = (await readdir(path.join(homedir(), '.Trash'))).filter((n) => n.includes(`${PFX}r2-${tag}`));
    t.diagnostic(`~/.Trash entries for this run: ${JSON.stringify(inTrash)} (not removed; the trash is never emptied)`);
    assert.equal(inTrash.length, 1);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    t.diagnostic(`~/.Trash not listable here (${(error as NodeJS.ErrnoException).code}); trash contents not checked`);
  }
});

test('R2-O1e lock after consumeApproval: LOCKED_BY_OTHER leaves the consumed batch runnable in this process; the approval cannot be consumed again', async (t) => {
  const r = await realPlan(t, { [`${PFX}late.pdf`]: 'late-lock' }, 'trash', false);
  const { e } = r;
  const o = r.byName(`${PFX}late.pdf`);
  const batch = await approveReal(r, 'organize');
  const before = await manifest(e.root);
  await withRootLock(e.stateDir, e.grant, async () => { await rejectsWith(executeBatch(batch), 'LOCKED_BY_OTHER'); });
  assert.deepEqual(await manifest(e.root), before);
  assert.equal(await exists(path.join(e.stateDir, 'runs')), false);
  await rejectsWith(consumeApproval(e.stateDir, batch.approval.id), 'APPROVAL_USED');
  assert.deepEqual(statuses(await executeBatch(batch)), [`${o.id}:moved`]);
});

/* ============================ observation: root replaced, fresh grant, hand-made batch ============================ */

test('R2-OBS root replaced at the same path + fresh grant in a hand-made batch: batch checks pass, per-file identity decides (recorded behaviour)', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}keep-inode.txt`), 'same inode'); await put(A(e, `${PFX}copy.txt`), 'copied');
  const kept = await op(e, 'move', `${PFX}keep-inode.txt`, { destination: `d/${PFX}keep-inode.txt` });
  const copied = await op(e, 'move', `${PFX}copy.txt`, { destination: `d/${PFX}copy.txt` });
  const p = makePlan(e.grant, [kept, copied], 'trash');
  // The user renames the root away, creates a new folder at the same path and moves one file over (rename keeps the inode)
  // and copies the other (new inode).
  const old = path.join(e.base, 'root-old');
  await rename(e.root, old); await mkdir(e.root);
  await rename(path.join(old, `${PFX}keep-inode.txt`), A(e, `${PFX}keep-inode.txt`));
  await writeFile(A(e, `${PFX}copy.txt`), await readFile(path.join(old, `${PFX}copy.txt`)));
  await rejectsWith(executeBatch(makeBatch(e, p, makeApproval(p, [kept.id, copied.id].sort(), 'organize'))), 'FILE_CHANGED');
  const fresh = await issueRootGrant(e.root, { sessionId: e.grant.sessionId });
  const report = await executeBatch(makeBatch(e, p, makeApproval(p, [kept.id, copied.id].sort(), 'organize'), fresh));
  t.diagnostic(`results with a fresh grant of the replacement folder: ${statuses(report).join(', ')}`);
  const st = new Map(report.results.map((x) => [x.opId, `${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`]));
  assert.equal(st.get(copied.id), 'failed:FILE_CHANGED');
  assert.equal(st.get(kept.id), 'moved', 'executor has no root dev/inode from the plan; consumeApproval (regrant) is what refuses a replaced root');
});

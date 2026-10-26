/**
 * #10/#11/#12 verifier: reproductions of defects found at 59f6b4c. Deliberately NOT named *.test.ts, so `npm test`
 * (dist/tests/*.test.js) does not run it: each case asserts the contract and fails until the product code is fixed.
 * Run after `npm run build`:  node --test dist/tests/verify-10-12.defects.js
 * Helpers are a copy of the block in tests/verify-10-12.test.ts (importing that file would also run its tests).
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AfoError, ApprovalSchema, OperationPlanSchema, PlanOperationSchema } from '../packages/contracts/src/index.js';
import type { Approval, ApprovalMode, ErrorCode, ExecutionReport, OperationKind, OperationPlan, PlanOperation, RootGrant }
  from '../packages/contracts/src/index.js';
import { issueRootGrant } from '../packages/filesystem/src/grants.js';
import { executeBatch, listRuns, undoRun } from '../packages/filesystem/src/executor.js';
import type { ApprovedBatch } from '../packages/filesystem/src/executor.js';
import { PlatformError, linkMoveNoClobber } from '../packages/filesystem/src/platform.js';

const sh = promisify(execFile);
const PFX = 'afo-test-';
const posix = process.platform !== 'win32';
const darwin = process.platform === 'darwin';
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const shaOf = async (p: string): Promise<string> => sha(await readFile(p));
const iso = (ms: number): string => new Date(ms).toISOString();

/* ---------- independent fixture / plan / approval helpers ---------- */
interface Env { base: string; root: string; outside: string; stateDir: string; grant: RootGrant }
async function setup(t: TestContext): Promise<Env> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), `${PFX}v1012-`)));
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
async function put(p: string, content: string | Buffer, mtimeSec?: number): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
  if (mtimeSec !== undefined) await utimes(p, mtimeSec, mtimeSec);
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
const dirs = (m: Record<string, string>): string[] => Object.keys(m).filter((k) => m[k] === 'd').sort();

let idSeq = 0x10000000;
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
function makePlan(grant: RootGrant, ops: PlanOperation[], deleteMode: 'trash' | 'permanent'): OperationPlan {
  const now = Date.now(); const count = (k: OperationKind): number => ops.filter((o) => o.kind === k).length;
  const body = { formatVersion: 1, rootGrantId: grant.id, rootPath: grant.canonicalPath, sessionId: grant.sessionId,
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
function makeBatch(e: Env, p: OperationPlan, a: Approval, ops?: PlanOperation[], grant?: RootGrant): ApprovedBatch {
  const byId = new Map(p.operations.map((o) => [o.id, o]));
  return { plan: p, approval: a, grant: grant ?? e.grant, stateDir: e.stateDir, operations: ops ?? a.operationIds.map((id) => byId.get(id)!) };
}
const deleteModeOf = (mode: ApprovalMode): 'trash' | 'permanent' => mode === 'permanent-delete' ? 'permanent' : 'trash';
function approveAll(e: Env, ops: PlanOperation[], mode: ApprovalMode): ApprovedBatch {
  const p = makePlan(e.grant, ops, deleteModeOf(mode));
  return makeBatch(e, p, makeApproval(p, ops.map((o) => o.id), mode));
}

interface J { runId: string; seq: number; opId: string; phase: string; kind: string; source: string; destination: string | null;
  before: { device: string; inode: string; size: number; sha256: string | null };
  after: { device: string; inode: string; size: number; sha256: string | null } | null; errorCode: string | null; approvalId: string }
async function journal(e: Env, runId: string): Promise<J[]> {
  let text: string;
  try { text = await readFile(path.join(e.stateDir, 'journal', `${runId}.jsonl`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as J);
}
const phases = (j: J[]): string[] => j.map((x) => `${x.opId}:${x.phase}${x.errorCode ? `:${x.errorCode}` : ''}`);
const statuses = (r: ExecutionReport): string[] => r.results.map((x) => `${x.opId}:${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`);
const successCount = (r: ExecutionReport): number => r.results.filter((x) => ['moved', 'trashed', 'deleted'].includes(x.status)).length;
const seqIncreasing = (j: J[]): boolean => j.every((x, i) => i === 0 || x.seq > j[i - 1]!.seq);
async function rejectsWith(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await assert.rejects(p, (error: unknown) => {
    assert.ok(error instanceof AfoError, `expected AfoError ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}
const runIds = async (e: Env): Promise<string[]> => listRuns(e.stateDir);


/* ================================ defects ================================ */

test('D1 approval/plan from another session are executed (sessionId never compared; DESIGN "실행 규칙" 2 requires it)', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}s.txt`), 'session');
  const o = await op(e, 'move', `${PFX}s.txt`, { destination: `d/${PFX}s.txt` });
  const p = makePlan(e.grant, [o], 'trash');
  const foreignSession = randomUUID();
  // Approval issued for another session (e.g. an earlier CLI process), plan and grant of this session.
  const a = makeApproval(p, [o.id], 'organize', { sessionId: foreignSession });
  const before = await manifest(e.root);
  await rejectsWith(executeBatch(makeBatch(e, p, a)), 'APPROVAL_INVALID');
  assert.deepEqual(await manifest(e.root), before);
});

test('D2 undo silently omits a forward op journaled failed+UNKNOWN (unclear) instead of reporting it unknown', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}u.txt`), 'unclear');
  const o = await op(e, 'move', `${PFX}u.txt`, { destination: `d/${PFX}u.txt` });
  // (mock) the real no-clobber move succeeds, then the adapter reports an unclear outcome.
  const report = await executeBatch(approveAll(e, [o], 'organize'), { adapter: {
    linkMoveNoClobber: async (s, d, x) => { await linkMoveNoClobber(s, d, x); throw new PlatformError('UNKNOWN', 'sim unclear'); } } });
  assert.deepEqual(statuses(report), [`${o.id}:unknown:UNKNOWN`]);
  assert.deepEqual(phases(await journal(e, report.runId)), [`${o.id}:intent`, `${o.id}:failed:UNKNOWN`]);
  const u = await undoRun(e.stateDir, report.runId, e.grant);
  t.diagnostic(`undo results: ${JSON.stringify(u.results)}`);
  // executor.ts:463 / ISSUE_10_11_12.md: failed+UNKNOWN is "결과 불명 … 복구 검사 대상"; undo must surface it, not drop it.
  assert.deepEqual(statuses(u), [`${o.id}:unknown:UNKNOWN`]);
});

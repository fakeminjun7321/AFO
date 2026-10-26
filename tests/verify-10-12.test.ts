/**
 * #10 / #11 / #12 verifier tests for packages/filesystem/src/executor.ts (independent of the builder's tests and helpers).
 * Synthetic mkdtemp(os.tmpdir()) folders and a temp state folder only. Each case compares before/after manifests
 * (path, size, sha256), the raw journal lines and the returned report.
 * Tests that pass `adapter` are marked (mock): they are not OS evidence.
 * Gated: AFO_REAL_TRASH_TEST=1 (real OS trash, afo-test- files only, never empties the trash),
 *        AFO_REAL_VOLUME_TEST=1 (macOS: attaches a 16 MiB synthetic disk image inside the temp root, detached afterwards).
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, rmdir, symlink, utimes,
  writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AfoError, ApprovalSchema, OperationPlanSchema, PlanOperationSchema } from '../packages/contracts/src/index.js';
import type { Approval, ApprovalMode, ErrorCode, ExecutionReport, OperationKind, OperationPlan, PlanOperation, RootGrant }
  from '../packages/contracts/src/index.js';
import { issueRootGrant, revokeGrant } from '../packages/filesystem/src/grants.js';
import { executeBatch, listRuns, readRun, undoRun } from '../packages/filesystem/src/executor.js';
import type { ApprovedBatch } from '../packages/filesystem/src/executor.js';
import { PlatformError, deleteFilePermanently, linkMoveNoClobber } from '../packages/filesystem/src/platform.js';
import { appendJournal } from '../packages/filesystem/src/state.js';

const sh = promisify(execFile);
const PFX = 'afo-test-';
const posix = process.platform !== 'win32';
const darwin = process.platform === 'darwin';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const shaOf = async (p: string): Promise<string> => sha(await readFile(p));
const iso = (ms: number): string => new Date(ms).toISOString();
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

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

/* ================================ #10 move ================================ */

test('V10-01 move success: dest sha256 = source, source gone, journal intent→done with seq++ and after identity, runs/ record', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}a.txt`), 'alpha-content');
  await put(A(e, `${PFX}b.txt`), 'bravo-content-2');
  await mkdir(A(e, 'existing'));
  const before = await manifest(e.root);
  const shaA = await shaOf(A(e, `${PFX}a.txt`)); const shaB = await shaOf(A(e, `${PFX}b.txt`));
  const inoA = String((await lstat(A(e, `${PFX}a.txt`), { bigint: true })).ino);
  const o1 = await op(e, 'move', `${PFX}a.txt`, { destination: `정리/문서/${PFX}a.txt` });
  const o2 = await op(e, 'move', `${PFX}b.txt`, { destination: `existing/${PFX}b.txt`, hash: true });
  const b = approveAll(e, [o1, o2], 'organize');
  const report = await executeBatch(b);

  assert.deepEqual(statuses(report), [`${o1.id}:moved`, `${o2.id}:moved`]);
  assert.equal(await shaOf(A(e, `정리/문서/${PFX}a.txt`)), shaA);
  assert.equal(await shaOf(A(e, `existing/${PFX}b.txt`)), shaB);
  assert.equal(await exists(A(e, `${PFX}a.txt`)), false);
  assert.equal(await exists(A(e, `${PFX}b.txt`)), false);
  const after = await manifest(e.root);
  // Only the planned destination parents were created.
  assert.deepEqual(dirs(after), ['existing', '정리', '정리/문서']);
  assert.deepEqual(dirs(before), ['existing']);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 2);

  const j = await journal(e, report.runId);
  assert.deepEqual(phases(j), [`${o1.id}:intent`, `${o1.id}:done`, `${o2.id}:intent`, `${o2.id}:done`]);
  assert.ok(seqIncreasing(j));
  assert.deepEqual(j.map((x) => x.seq), [0, 1, 2, 3]);
  const done1 = j[1]!;
  assert.equal(done1.after?.inode, inoA);
  assert.equal(done1.after?.sha256, shaA, 'after.sha256 recorded even when expected.sha256 was null');
  assert.equal(done1.before.inode, o1.expected.inode);
  assert.equal(j[0]!.after, null);
  assert.ok(j.every((x) => x.approvalId === b.approval.id && x.runId === report.runId));

  assert.equal(report.space.freeBytesBefore, null); assert.equal(report.space.freeBytesAfter, null);
  assert.equal(report.space.logicalBytesSelected, o1.expected.size + o2.expected.size);
  const rec = await readRun(e.stateDir, report.runId);
  assert.ok(rec); assert.deepEqual(rec.run.report, report); assert.notEqual(rec.run.finishedAt, null);
  assert.deepEqual(await runIds(e), [report.runId]);
  const claim = JSON.parse(await readFile(path.join(e.stateDir, 'runs', `${b.approval.id}.approval`), 'utf8')) as { runId: string };
  assert.equal(claim.runId, report.runId);
});

test('V10-02 no overwrite: existing destination (other content), case-folded and NFD/NFC names, and a real link() EEXIST race', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}src.txt`), 'source-content');
  await put(A(e, `dest/${PFX}src.txt`), 'pre-existing-other-content');
  await put(A(e, `${PFX}case.txt`), 'case-source');
  await put(A(e, `fold/${PFX}case.txt`), 'case-existing');
  const nfd = `${PFX}café.txt`; const nfc = `${PFX}café.txt`;
  await put(A(e, `${PFX}uni.txt`), 'unicode-source');
  await put(A(e, `uni/${nfd}`), 'unicode-existing');
  await put(A(e, `${PFX}race.txt`), 'race-source');
  const folded = await exists(A(e, `FOLD/${PFX}CASE.TXT`)); // case-insensitive volume?
  const unifold = await exists(A(e, `uni/${nfc}`));
  const ops = [await op(e, 'move', `${PFX}src.txt`, { destination: `dest/${PFX}src.txt` }),
    await op(e, 'move', `${PFX}case.txt`, { destination: `FOLD/${PFX}CASE.TXT` }),
    await op(e, 'move', `${PFX}uni.txt`, { destination: `uni/${nfc}` }),
    await op(e, 'move', `${PFX}race.txt`, { destination: `race/${PFX}race.txt` })];
  const before = await manifest(e.root);
  // Race: another program creates the destination right before the real link(); executor must not overwrite it.
  const report = await executeBatch(approveAll(e, ops, 'organize'), { adapter: {
    linkMoveNoClobber: async (src, dst, expected) => {
      if (dst.endsWith(`${PFX}race.txt`)) await writeFile(dst, 'raced-in-by-other-program');
      return linkMoveNoClobber(src, dst, expected);
    } } });
  const r = statuses(report);
  assert.equal(r[0], `${ops[0]!.id}:failed:DEST_EXISTS`);
  if (folded) assert.equal(r[1], `${ops[1]!.id}:failed:DEST_EXISTS`); else t.diagnostic('volume is case-sensitive; case fold case not applicable');
  if (unifold) assert.equal(r[2], `${ops[2]!.id}:failed:DEST_EXISTS`); else t.diagnostic('volume is normalization-sensitive');
  assert.equal(r[3], `${ops[3]!.id}:failed:DEST_EXISTS`);
  assert.equal(successCount(report), (folded ? 0 : 1) + (unifold ? 0 : 1));
  const after = await manifest(e.root);
  // Every original file is byte-identical; the raced-in file is kept and the source stays.
  for (const k of Object.keys(before)) if (folded && unifold) assert.equal(after[k], before[k], k);
  assert.equal(await readFile(A(e, `race/${PFX}race.txt`), 'utf8'), 'raced-in-by-other-program');
  assert.equal(await readFile(A(e, `${PFX}race.txt`), 'utf8'), 'race-source');
  assert.equal(await readFile(A(e, `dest/${PFX}src.txt`), 'utf8'), 'pre-existing-other-content');
  const j = await journal(e, report.runId);
  assert.ok(j.filter((x) => x.phase === 'done').length === successCount(report));
});

test('V10-03 folder creation stays on the planned path: nested folders created one by one; nothing when the plan cannot run', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}f.txt`), 'nested');
  await put(A(e, `${PFX}g.txt`), 'blocked');
  await put(A(e, 'blocker'), 'i am a file, not a folder');
  await put(A(e, `${PFX}h.txt`), 'changes-before-run', 1_700_000_000);
  const o1 = await op(e, 'move', `${PFX}f.txt`, { destination: `new/deep/er/${PFX}f.txt` });
  const o2 = await op(e, 'move', `${PFX}g.txt`, { destination: `blocker/sub/${PFX}g.txt` });
  const o3 = await op(e, 'move', `${PFX}h.txt`, { destination: `never/created/${PFX}h.txt` });
  await writeFile(A(e, `${PFX}h.txt`), 'changed-before-runXX'); // size differs → FILE_CHANGED before any mkdir
  const report = await executeBatch(approveAll(e, [o1, o2, o3], 'organize'));
  assert.deepEqual(statuses(report), [`${o1.id}:moved`, `${o2.id}:failed:DEST_EXISTS`, `${o3.id}:failed:FILE_CHANGED`]);
  assert.deepEqual(dirs(await manifest(e.root)), ['new', 'new/deep', 'new/deep/er']);
  assert.equal(await readFile(A(e, `${PFX}g.txt`), 'utf8'), 'blocked');
  assert.equal(await readFile(A(e, 'blocker'), 'utf8'), 'i am a file, not a folder');
});

test('V10-04 links out of the root are refused (O-1): destination grandparent link, destination parent link, source parent link', { skip: !posix && 'symlink needs privileges on Windows' }, async (t) => {
  const e = await setup(t);
  await mkdir(path.join(e.outside, 'g', 'p'), { recursive: true });
  await put(path.join(e.outside, 'g', 'p', 'keep.txt'), 'outside-keep');
  await symlink(path.join(e.outside, 'g'), A(e, 'g'));                 // grandparent of destination
  await mkdir(A(e, 'inner'));
  await symlink(A(e, 'inner'), A(e, 'plink'));                         // parent link to a folder inside the root
  await put(A(e, `${PFX}1.txt`), 'one'); await put(A(e, `${PFX}2.txt`), 'two');
  await put(A(e, `s/${PFX}3.txt`), 'three');
  const o1 = await op(e, 'move', `${PFX}1.txt`, { destination: `g/p/${PFX}1.txt` });
  const o2 = await op(e, 'move', `${PFX}2.txt`, { destination: `plink/${PFX}2.txt` });
  const o3 = await op(e, 'move', `s/${PFX}3.txt`, { destination: `dst/${PFX}3.txt` });
  // After the plan: real folder s is moved out of the root and replaced by a link to it (same inode for the source).
  await rename(A(e, 's'), path.join(e.outside, 's'));
  await symlink(path.join(e.outside, 's'), A(e, 's'));
  const outBefore = await manifest(e.outside); const rootBefore = await manifest(e.root);
  const report = await executeBatch(approveAll(e, [o1, o2, o3], 'organize'));
  assert.deepEqual(statuses(report), [`${o1.id}:failed:LINK_REJECTED`, `${o2.id}:failed:LINK_REJECTED`, `${o3.id}:failed:LINK_REJECTED`]);
  assert.deepEqual(await manifest(e.outside), outBefore);
  assert.deepEqual(await manifest(e.root), rootBefore);
});

test('V10-05a cross volume (mock): adapter CROSS_VOLUME → failed, file untouched, no success counted', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}x.txt`), 'xv');
  const o = await op(e, 'move', `${PFX}x.txt`, { destination: `d/${PFX}x.txt` });
  const report = await executeBatch(approveAll(e, [o], 'organize'), { adapter: {
    linkMoveNoClobber: async () => { throw new PlatformError('CROSS_VOLUME', 'sim EXDEV', 'EXDEV'); } } });
  assert.deepEqual(statuses(report), [`${o.id}:failed:CROSS_VOLUME`]);
  assert.equal(await readFile(A(e, `${PFX}x.txt`), 'utf8'), 'xv');
});

test('V10-05b cross volume (real, macOS disk image mounted inside the root): into and out of the other volume are refused', async (t) => {
  if (!darwin || process.env['AFO_REAL_VOLUME_TEST'] !== '1') { t.skip('AFO_REAL_VOLUME_TEST=1 (macOS) 에서만 실제 두 번째 볼륨 검사'); return; }
  const e = await setup(t);
  const img = path.join(e.base, `${PFX}vol.dmg`); const mnt = A(e, 'mnt');
  await mkdir(mnt);
  await sh('hdiutil', ['create', '-size', '16m', '-fs', 'HFS+', '-volname', 'AFOTESTV', img]);
  await sh('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mnt, img]);
  try {
    assert.notEqual((await lstat(mnt)).dev, (await lstat(e.root)).dev, 'image must be another volume');
    await put(A(e, `${PFX}in.txt`), 'goes-to-other-volume');
    await put(A(e, `mnt/${PFX}out.txt`), 'comes-from-other-volume');
    const o1 = await op(e, 'move', `${PFX}in.txt`, { destination: `mnt/${PFX}in.txt` });
    const o2 = await op(e, 'move', `mnt/${PFX}out.txt`, { destination: `${PFX}out.txt` });
    const report = await executeBatch(approveAll(e, [o1, o2], 'organize'));
    assert.deepEqual(statuses(report), [`${o1.id}:failed:CROSS_VOLUME`, `${o2.id}:failed:CROSS_VOLUME`]);
    assert.equal(await readFile(A(e, `${PFX}in.txt`), 'utf8'), 'goes-to-other-volume');
    assert.equal(await readFile(A(e, `mnt/${PFX}out.txt`), 'utf8'), 'comes-from-other-volume');
    assert.equal(await exists(A(e, `mnt/${PFX}in.txt`)), false);
    assert.equal(await exists(A(e, `${PFX}out.txt`)), false);
  } finally {
    await sh('hdiutil', ['detach', mnt, '-force']).catch(() => undefined);
  }
});

test('V10-06 middle operation permission errors (uchg file / read-only source folder / read-only destination folder): others succeed', { skip: (!darwin || isRoot) && 'macOS chflags, non-root only' }, async (t) => {
  const e = await setup(t);
  for (const n of ['a', 'b', 'c', 'd', 'f']) await put(A(e, `${n === 'd' ? 'ro/' : ''}${PFX}${n}.txt`), `content-${n}`);
  await put(A(e, `${PFX}e.txt`), 'content-e');
  await mkdir(A(e, 'rodest'));
  const ops = [await op(e, 'move', `${PFX}a.txt`, { destination: `out/${PFX}a.txt` }),
    await op(e, 'move', `${PFX}b.txt`, { destination: `out/${PFX}b.txt` }),       // uchg → link EPERM
    await op(e, 'move', `ro/${PFX}d.txt`, { destination: `out/${PFX}d.txt` }),     // source folder 0555 → unlink EACCES after link
    await op(e, 'move', `${PFX}e.txt`, { destination: `rodest/${PFX}e.txt` }),     // destination folder 0555 → link EACCES
    await op(e, 'move', `${PFX}c.txt`, { destination: `out/${PFX}c.txt` })];
  await sh('chflags', ['uchg', A(e, `${PFX}b.txt`)]);
  await chmod(A(e, 'ro'), 0o555); await chmod(A(e, 'rodest'), 0o555);
  const report = await executeBatch(approveAll(e, ops, 'organize'));
  assert.deepEqual(statuses(report), [`${ops[0]!.id}:moved`, `${ops[1]!.id}:failed:PERMISSION_DENIED`,
    `${ops[2]!.id}:failed:PERMISSION_DENIED`, `${ops[3]!.id}:failed:PERMISSION_DENIED`, `${ops[4]!.id}:moved`]);
  assert.equal(successCount(report), 2);
  assert.equal(await readFile(A(e, `${PFX}b.txt`), 'utf8'), 'content-b');
  assert.equal(await readFile(A(e, `ro/${PFX}d.txt`), 'utf8'), 'content-d');
  assert.equal((await lstat(A(e, `ro/${PFX}d.txt`))).nlink, 1, 'rollback removed the extra destination link');
  assert.equal(await readFile(A(e, `${PFX}e.txt`), 'utf8'), 'content-e');
  for (const n of ['b', 'd']) assert.equal(await exists(A(e, `out/${PFX}${n}.txt`)), false);
  assert.equal(await exists(A(e, `rodest/${PFX}e.txt`)), false);
  assert.equal(await readFile(A(e, `out/${PFX}a.txt`), 'utf8'), 'content-a');
  assert.equal(await readFile(A(e, `out/${PFX}c.txt`), 'utf8'), 'content-c');
  const j = await journal(e, report.runId);
  assert.deepEqual(j.filter((x) => x.phase === 'failed').map((x) => x.errorCode), ['PERMISSION_DENIED', 'PERMISSION_DENIED', 'PERMISSION_DENIED']);
});

test('V10-07 cancellation: abort after the first operation → rest skipped CANCELLED (journaled), untouched, not counted', async (t) => {
  const e = await setup(t);
  for (const n of ['1', '2', '3']) await put(A(e, `${PFX}${n}.txt`), `c${n}`);
  const ops = [];
  for (const n of ['1', '2', '3']) ops.push(await op(e, 'move', `${PFX}${n}.txt`, { destination: `d/${PFX}${n}.txt` }));
  const ac = new AbortController();
  const report = await executeBatch(approveAll(e, ops, 'organize'), { signal: ac.signal,
    onProgress: (p) => { if (p.done === 1) ac.abort(); } });
  assert.deepEqual(statuses(report), [`${ops[0]!.id}:moved`, `${ops[1]!.id}:skipped:CANCELLED`, `${ops[2]!.id}:skipped:CANCELLED`]);
  assert.equal(successCount(report), 1);
  assert.equal(await readFile(A(e, `${PFX}2.txt`), 'utf8'), 'c2');
  assert.equal(await readFile(A(e, `${PFX}3.txt`), 'utf8'), 'c3');
  assert.deepEqual(phases(await journal(e, report.runId)), [`${ops[0]!.id}:intent`, `${ops[0]!.id}:done`,
    `${ops[1]!.id}:skipped:CANCELLED`, `${ops[2]!.id}:skipped:CANCELLED`]);
  // Already aborted before start: nothing moves.
  await put(A(e, `${PFX}4.txt`), 'c4');
  const o4 = await op(e, 'move', `${PFX}4.txt`, { destination: `d/${PFX}4.txt` });
  const before = await manifest(e.root);
  const r2 = await executeBatch(approveAll(e, [o4], 'organize'), { signal: AbortSignal.abort() });
  assert.deepEqual(statuses(r2), [`${o4.id}:skipped:CANCELLED`]);
  assert.deepEqual(await manifest(e.root), before);
});

test('V10-08 same-size content change with mtime restored: FILE_CHANGED when expected.sha256 is set; file untouched', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}h.txt`), 'AAAA-original', 1_700_000_000);
  await put(A(e, `${PFX}n.txt`), 'BBBB-original', 1_700_000_000);
  const hashed = await op(e, 'move', `${PFX}h.txt`, { destination: `d/${PFX}h.txt`, hash: true });
  const unhashed = await op(e, 'move', `${PFX}n.txt`, { destination: `d/${PFX}n.txt` });
  await put(A(e, `${PFX}h.txt`), 'ZZZZ-modified', 1_700_000_000);
  await put(A(e, `${PFX}n.txt`), 'YYYY-modified', 1_700_000_000);
  for (const [o, f] of [[hashed, `${PFX}h.txt`], [unhashed, `${PFX}n.txt`]] as const) {
    const s = await lstat(A(e, f), { bigint: true });
    assert.equal(String(s.mtimeNs), o.expected.modifiedNs, 'precondition: mtime restored exactly');
    assert.equal(Number(s.size), o.expected.size, 'precondition: same size');
  }
  const report = await executeBatch(approveAll(e, [hashed, unhashed], 'organize'));
  assert.equal(statuses(report)[0], `${hashed.id}:failed:FILE_CHANGED`);
  assert.equal(await readFile(A(e, `${PFX}h.txt`), 'utf8'), 'ZZZZ-modified');
  assert.equal(await exists(A(e, `d/${PFX}h.txt`)), false);
  // Documented limitation (CARRYOVER #10): without expected.sha256 the same-size/same-mtime edit is not detectable.
  t.diagnostic(`without sha256: ${statuses(report)[1]}`);
  assert.equal(statuses(report)[1], `${unhashed.id}:moved`);
});

test('V10-09 journal cannot be written: no file changes; later ops skipped; runs/ unwritable refuses before any change', { skip: (!posix || isRoot) && 'POSIX permissions, non-root only' }, async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}1.txt`), 'one'); await put(A(e, `${PFX}2.txt`), 'two');
  const o1 = await op(e, 'move', `${PFX}1.txt`, { destination: `d/${PFX}1.txt` });
  const o2 = await op(e, 'move', `${PFX}2.txt`, { destination: `d/${PFX}2.txt` });
  await mkdir(path.join(e.stateDir, 'journal')); await chmod(path.join(e.stateDir, 'journal'), 0o500);
  const before = await manifest(e.root);
  const report = await executeBatch(approveAll(e, [o1, o2], 'organize'));
  assert.deepEqual(statuses(report), [`${o1.id}:failed:JOURNAL_FAILED`, `${o2.id}:skipped:JOURNAL_FAILED`]);
  assert.deepEqual(await manifest(e.root), before);
  assert.equal(successCount(report), 0);
  await chmod(path.join(e.stateDir, 'journal'), 0o700);
  // runs/ not writable: the approval claim fails, nothing changes, no journal.
  await rm(path.join(e.stateDir, 'journal'), { recursive: true });
  await mkdir(path.join(e.stateDir, 'runs'), { recursive: true }); await chmod(path.join(e.stateDir, 'runs'), 0o500);
  await rejectsWith(executeBatch(approveAll(e, [o1, o2], 'organize')), 'JOURNAL_FAILED');
  assert.deepEqual(await manifest(e.root), before);
  assert.equal(await exists(path.join(e.stateDir, 'journal')), false);
});

test('V10-09b journal failures (mock appendJournal): ENOSPC at intent → DISK_FULL; done write fails after a real move → moved + note, rest skipped', async (t) => {
  const e = await setup(t);
  for (const n of ['1', '2', '3']) await put(A(e, `${PFX}${n}.txt`), `c${n}`);
  const ops = [];
  for (const n of ['1', '2', '3']) ops.push(await op(e, 'move', `${PFX}${n}.txt`, { destination: `d/${PFX}${n}.txt` }));
  const before = await manifest(e.root);
  const full = await executeBatch(approveAll(e, ops, 'organize'), { adapter: {
    appendJournal: async () => { throw new AfoError('DISK_FULL', 'sim ENOSPC'); } } });
  assert.deepEqual(statuses(full), [`${ops[0]!.id}:failed:DISK_FULL`, `${ops[1]!.id}:skipped:DISK_FULL`, `${ops[2]!.id}:skipped:DISK_FULL`]);
  assert.deepEqual(await manifest(e.root), before);
  let calls = 0;
  const r = await executeBatch(approveAll(e, ops, 'organize'), { adapter: {
    appendJournal: async (file, entry) => { calls += 1; if (calls === 2) throw new AfoError('JOURNAL_FAILED', 'sim'); return appendJournal(file, entry); } } });
  assert.deepEqual(statuses(r).map((s) => s.split(':').slice(1).join(':')), ['moved', 'skipped:JOURNAL_FAILED', 'skipped:JOURNAL_FAILED']);
  assert.match(r.results[0]!.detail, /저널에 기록하지 못했습니다/u);
  assert.equal(await exists(A(e, `d/${PFX}1.txt`)), true);
  assert.equal(await readFile(A(e, `${PFX}2.txt`), 'utf8'), 'c2');
});

test('V10-10 faultInjection: after-intent throw → propagates, journal has intent only, file untouched; after-op/before-done leave intent-only state', async (t) => {
  const e = await setup(t);
  for (const n of ['1', '2', '3']) await put(A(e, `${PFX}${n}.txt`), `c${n}`);
  const mk = async (n: string): Promise<PlanOperation> => op(e, 'move', `${PFX}${n}.txt`, { destination: `d/${PFX}${n}.txt` });
  const boom = new Error('simulated crash');
  const points = ['after-intent', 'after-op', 'before-done'] as const;
  const seen: Record<string, { phases: string[]; srcExists: boolean; dstExists: boolean; reportNull: boolean }> = {};
  for (const [i, point] of points.entries()) {
    const o = await mk(String(i + 1));
    const runsBefore = new Set(await runIds(e));
    await assert.rejects(executeBatch(approveAll(e, [o], 'organize'), { faultInjection: (p) => { if (p === point) throw boom; } }), (x) => x === boom);
    const runId = (await runIds(e)).find((id) => !runsBefore.has(id))!;
    const rec = await readRun(e.stateDir, runId);
    seen[point] = { phases: phases(await journal(e, runId)).map((s) => s.split(':').slice(1).join(':')),
      srcExists: await exists(A(e, o.source)), dstExists: await exists(A(e, o.destination!)), reportNull: rec?.run.report === null };
  }
  assert.deepEqual(seen['after-intent'], { phases: ['intent'], srcExists: true, dstExists: false, reportNull: true });
  assert.equal(await readFile(A(e, `${PFX}1.txt`), 'utf8'), 'c1');
  assert.deepEqual(seen['after-op'], { phases: ['intent'], srcExists: false, dstExists: true, reportNull: true });
  assert.deepEqual(seen['before-done'], { phases: ['intent'], srcExists: false, dstExists: true, reportNull: true });
  t.diagnostic(`#13 reference: ${JSON.stringify(seen)}`);
});

test('V10-11 batch defenses: mode, expiry, unconsumed, foreign/reordered/subset/edited ops, other plan, profile, grants, reuse, state dir → throw, nothing changes', async (t) => {
  const e = await setup(t);
  const other = await setup(t);
  await put(A(e, `${PFX}1.txt`), 'one'); await put(A(e, `${PFX}2.txt`), 'two');
  await put(path.join(other.root, `${PFX}o.txt`), 'other-root');
  const o1 = await op(e, 'move', `${PFX}1.txt`, { destination: `d/${PFX}1.txt` });
  const o2 = await op(e, 'move', `${PFX}2.txt`, { destination: `d/${PFX}2.txt` });
  const foreign = await op(other, 'move', `${PFX}o.txt`, { destination: `d/${PFX}o.txt` });
  const p = makePlan(e.grant, [o1, o2], 'trash');
  const ids = [o1.id, o2.id];
  const now = Date.now();
  const before = await manifest(e.root); const otherBefore = await manifest(other.root);
  const forgedId = { ...e.grant, id: sha('forged') };
  const tampered = { ...e.grant, inode: '1' };
  const cases: Array<[string, ApprovedBatch, ErrorCode]> = [
    ['mode mismatch', makeBatch(e, p, makeApproval(p, ids, 'trash')), 'MODE_MISMATCH'],
    ['expired', makeBatch(e, p, makeApproval(p, ids, 'organize', { issuedAt: iso(now - 20 * 60_000), expiresAt: iso(now - 11 * 60_000), usedAt: iso(now - 15 * 60_000) })), 'APPROVAL_EXPIRED'],
    ['usedAt null', makeBatch(e, p, makeApproval(p, ids, 'organize', { usedAt: null })), 'APPROVAL_INVALID'],
    ['op not in plan', makeBatch(e, p, makeApproval(p, [o1.id, foreign.id], 'organize'), [o1, foreign]), 'PLAN_CHANGED'],
    ['reordered', makeBatch(e, p, makeApproval(p, ids, 'organize'), [o2, o1]), 'APPROVAL_INVALID'],
    ['subset of approved', makeBatch(e, p, makeApproval(p, ids, 'organize'), [o1]), 'APPROVAL_INVALID'],
    ['edited op same id', makeBatch(e, p, makeApproval(p, [o1.id], 'organize'), [{ ...o1, destination: `elsewhere/${PFX}1.txt` }]), 'PLAN_CHANGED'],
    ['approval of other plan', makeBatch(e, p, { ...makeApproval(p, ids, 'organize'), planId: sha('other-plan') }), 'APPROVAL_INVALID'],
    ['profile changed', makeBatch(e, p, makeApproval(p, ids, 'organize', { profileId: 'prof-1', profileRevision: 2 })), 'PROFILE_CHANGED'],
    ['grant of other root', makeBatch(e, p, makeApproval(p, ids, 'organize'), undefined, other.grant), 'ROOT_FORBIDDEN'],
    ['forged grant id', makeBatch(e, p, makeApproval(p, ids, 'organize'), undefined, forgedId), 'ROOT_FORBIDDEN'],
    ['tampered grant inode', makeBatch(e, p, makeApproval(p, ids, 'organize'), undefined, tampered), 'ROOT_FORBIDDEN'],
    ['state dir inside root', { ...makeBatch(e, p, makeApproval(p, ids, 'organize')), stateDir: A(e, 'state') }, 'STATE_DIR_CONFLICT'],
    ['relative state dir', { ...makeBatch(e, p, makeApproval(p, ids, 'organize')), stateDir: 'rel/state' }, 'STATE_DIR_INVALID'],
  ];
  for (const [label, b, code] of cases) {
    await t.test(label, async () => { await rejectsWith(executeBatch(b), code); });
  }
  assert.deepEqual(await manifest(e.root), before);
  assert.deepEqual(await manifest(other.root), otherBefore);
  assert.deepEqual(await readdir(e.stateDir), [], 'refused batches wrote no state (no runs/, no journal/)');

  // Revoked grant.
  const g2 = await issueRootGrant(e.root);
  const p2 = makePlan(g2, [o1, o2], 'trash');
  revokeGrant(g2);
  await rejectsWith(executeBatch(makeBatch(e, p2, makeApproval(p2, ids, 'organize'), undefined, g2)), 'ROOT_FORBIDDEN');

  // Reuse of one approval: second call refused, first result unchanged.
  const good = makeBatch(e, p, makeApproval(p, ids, 'organize'));
  const first = await executeBatch(good);
  assert.equal(successCount(first), 2);
  const afterFirst = await manifest(e.root);
  await rejectsWith(executeBatch(good), 'APPROVAL_USED');
  await rejectsWith(executeBatch(structuredClone(good)), 'APPROVAL_USED');
  assert.deepEqual(await manifest(e.root), afterFirst);
  assert.deepEqual(await runIds(e), [first.runId]);
});

test('V10-15 re-running an already organized plan: SOURCE_MISSING per op, destinations untouched, nothing counted', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}1.txt`), 'one'); await put(A(e, `${PFX}2.txt`), 'two');
  const o1 = await op(e, 'move', `${PFX}1.txt`, { destination: `d/${PFX}1.txt` });
  const o2 = await op(e, 'move', `${PFX}2.txt`, { destination: `d/${PFX}2.txt` });
  const p = makePlan(e.grant, [o1, o2], 'trash');
  assert.equal(successCount(await executeBatch(makeBatch(e, p, makeApproval(p, [o1.id, o2.id], 'organize')))), 2);
  const organized = await manifest(e.root);
  const again = await executeBatch(makeBatch(e, p, makeApproval(p, [o1.id, o2.id], 'organize')));
  assert.deepEqual(statuses(again), [`${o1.id}:failed:SOURCE_MISSING`, `${o2.id}:failed:SOURCE_MISSING`]);
  assert.equal(successCount(again), 0);
  assert.deepEqual(await manifest(e.root), organized);
});

/* ================================ #10 undo ================================ */

async function organizeOne(e: Env, source: string, destination: string, content: string): Promise<{ op: PlanOperation; report: ExecutionReport }> {
  await put(A(e, source), content);
  const o = await op(e, 'move', source, { destination });
  const report = await executeBatch(approveAll(e, [o], 'organize'));
  assert.deepEqual(statuses(report), [`${o.id}:moved`]);
  return { op: o, report };
}

test('V10-14a undo success: original path restored with same sha256/inode, journal undo entries reuse source/destination/before, second undo is a no-op', async (t) => {
  const e = await setup(t);
  const { op: o, report } = await organizeOne(e, `sub/${PFX}u.txt`, `sorted/${PFX}u.txt`, 'undo-me');
  const shaU = sha('undo-me');
  const ino = String((await lstat(A(e, `sorted/${PFX}u.txt`), { bigint: true })).ino);
  await rmdir(A(e, 'sub')); // user removed the emptied folder; undo recreates it inside the root
  const u = await undoRun(e.stateDir, report.runId, e.grant);
  assert.deepEqual(statuses(u), [`${o.id}:moved`]);
  assert.equal(await shaOf(A(e, `sub/${PFX}u.txt`)), shaU);
  assert.equal(String((await lstat(A(e, `sub/${PFX}u.txt`), { bigint: true })).ino), ino);
  assert.equal(await exists(A(e, `sorted/${PFX}u.txt`)), false);
  const j = await journal(e, report.runId);
  assert.deepEqual(j.map((x) => x.phase), ['intent', 'done', 'undo-intent', 'undone']);
  assert.ok(seqIncreasing(j));
  const [, done, ui, undone] = j as [J, J, J, J];
  for (const x of [ui, undone]) {
    assert.equal(x.source, done.source); assert.equal(x.destination, done.destination); assert.deepEqual(x.before, done.before);
  }
  assert.equal(ui.after, null); assert.equal(undone.after?.inode, ino); assert.equal(undone.after?.sha256, shaU);
  const snapshot = await manifest(e.root);
  const u2 = await undoRun(e.stateDir, report.runId, e.grant);
  assert.deepEqual(u2.results, []);
  assert.deepEqual(await manifest(e.root), snapshot);
  const rec = await readRun(e.stateDir, report.runId);
  assert.equal(rec?.undos.length, 2); assert.deepEqual(rec?.run.report, report, 'original report kept');
  assert.ok(await exists(path.join(e.stateDir, 'runs', `${report.runId}.undo-1.json`)));
  // A re-issued grant for the same folder is accepted (different id, same folder).
  const u3 = await undoRun(e.stateDir, report.runId, await issueRootGrant(e.root));
  assert.deepEqual(u3.results, []);
});

test('V10-14b undo refusals: user file at original path, moved file edited (same size / other size), other root, outside link; nothing overwritten', { skip: !posix && 'symlink' }, async (t) => {
  const e = await setup(t);
  const other = await setup(t);
  const r1 = await organizeOne(e, `${PFX}occupied.txt`, `s/${PFX}occupied.txt`, 'moved-occupied');
  await put(A(e, `${PFX}occupied.txt`), 'user-new-file');
  const r2 = await organizeOne(e, `${PFX}edited.txt`, `s/${PFX}edited.txt`, 'edit-me-0');
  await writeFile(A(e, `s/${PFX}edited.txt`), 'edit-me-9'); // same size, other content
  const r3 = await organizeOne(e, `${PFX}grown.txt`, `s/${PFX}grown.txt`, 'grow');
  await appendFile(A(e, `s/${PFX}grown.txt`), '-more');
  const r4 = await organizeOne(e, `p/${PFX}linked.txt`, `s/${PFX}linked.txt`, 'link-parent');
  await rmdir(A(e, 'p')); await mkdir(path.join(e.outside, 'p')); await symlink(path.join(e.outside, 'p'), A(e, 'p'));
  const before = await manifest(e.root); const outBefore = await manifest(e.outside);
  assert.deepEqual(statuses(await undoRun(e.stateDir, r1.report.runId, e.grant)), [`${r1.op.id}:failed:DEST_EXISTS`]);
  assert.deepEqual(statuses(await undoRun(e.stateDir, r2.report.runId, e.grant)), [`${r2.op.id}:failed:FILE_CHANGED`]);
  assert.deepEqual(statuses(await undoRun(e.stateDir, r3.report.runId, e.grant)), [`${r3.op.id}:failed:FILE_CHANGED`]);
  assert.deepEqual(statuses(await undoRun(e.stateDir, r4.report.runId, e.grant)), [`${r4.op.id}:failed:LINK_REJECTED`]);
  await rejectsWith(undoRun(e.stateDir, r1.report.runId, other.grant), 'ROOT_FORBIDDEN');
  await rejectsWith(undoRun(e.stateDir, 'not-a-run-0000', e.grant), 'APPROVAL_MISSING');
  assert.deepEqual(await manifest(e.root), before);
  assert.deepEqual(await manifest(e.outside), outBefore);
  assert.equal(await readFile(A(e, `${PFX}occupied.txt`), 'utf8'), 'user-new-file');
  assert.equal(await readFile(A(e, `s/${PFX}occupied.txt`), 'utf8'), 'moved-occupied');
  assert.equal(await readFile(A(e, `s/${PFX}edited.txt`), 'utf8'), 'edit-me-9');
  // Corrupt journal line → refuse without guessing.
  await appendFile(path.join(e.stateDir, 'journal', `${r1.report.runId}.jsonl`), '{"torn":\n');
  await rejectsWith(undoRun(e.stateDir, r1.report.runId, e.grant), 'STATE_CORRUPT');
});

test('V10-14c undo is refused for trash and permanent-delete runs (NOT_SUPPORTED); files untouched', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}dup.txt`), 'same'); await put(A(e, `${PFX}keep.txt`), 'same');
  const d = await op(e, 'delete', `${PFX}dup.txt`, { keeper: `${PFX}keep.txt` });
  const del = await executeBatch(approveAll(e, [d], 'permanent-delete'));
  assert.deepEqual(statuses(del), [`${d.id}:deleted`]);
  await put(A(e, `${PFX}t.txt`), 'trash-me');
  const tr = await op(e, 'trash', `${PFX}t.txt`);
  const trashed = await executeBatch(approveAll(e, [tr], 'trash'), { adapter: { moveToTrash: async (p) => { await rename(p, path.join(e.outside, path.basename(p))); } } });
  assert.deepEqual(statuses(trashed), [`${tr.id}:trashed`]); // (mock trash)
  const before = await manifest(e.root);
  await rejectsWith(undoRun(e.stateDir, del.runId, e.grant), 'NOT_SUPPORTED');
  await rejectsWith(undoRun(e.stateDir, trashed.runId, e.grant), 'NOT_SUPPORTED');
  assert.deepEqual(await manifest(e.root), before);
  assert.equal(await exists(A(e, `${PFX}dup.txt`)), false);
});

/* ================================ #11 trash ================================ */

test('V11-01 trash failure (mock) is never turned into permanent deletion; unclear outcomes are unknown, not trashed', async (t) => {
  const e = await setup(t);
  for (const n of ['f', 'g', 'h']) await put(A(e, `${PFX}${n}.txt`), `trash-${n}`);
  const ops = [];
  for (const n of ['f', 'g', 'h']) ops.push(await op(e, 'trash', `${PFX}${n}.txt`));
  let deletes = 0;
  const before = await manifest(e.root);
  const report = await executeBatch(approveAll(e, ops, 'trash'), { adapter: {
    deleteFilePermanently: async (p, x) => { deletes += 1; return deleteFilePermanently(p, x); },
    moveToTrash: async (p) => {
      if (p.endsWith(`${PFX}f.txt`)) throw new PlatformError('TRASH_FAILED', 'sim tool failure');
      if (p.endsWith(`${PFX}g.txt`)) return;                       // tool claims success but the file is still there
      await rename(p, path.join(e.outside, path.basename(p)));      // file gone but tool reports an error
      throw new PlatformError('TRASH_FAILED', 'sim error after move');
    } } });
  assert.deepEqual(statuses(report), [`${ops[0]!.id}:failed:TRASH_FAILED`, `${ops[1]!.id}:unknown:UNKNOWN`, `${ops[2]!.id}:unknown:UNKNOWN`]);
  assert.equal(deletes, 0);
  assert.equal(successCount(report), 0);
  assert.equal(await readFile(A(e, `${PFX}f.txt`), 'utf8'), 'trash-f');
  assert.equal(await readFile(A(e, `${PFX}g.txt`), 'utf8'), 'trash-g');
  assert.deepEqual(Object.keys(await manifest(e.root)), Object.keys(before).filter((k) => k !== `${PFX}h.txt`));
  assert.deepEqual(phases(await journal(e, report.runId)).map((s) => s.split(':').slice(1).join(':')),
    ['intent', 'failed:TRASH_FAILED', 'intent', 'failed:UNKNOWN', 'intent', 'failed:UNKNOWN']);
});

test('V11-02 trash re-verifies snapshot and keeper before the OS call; report never counts trash as reclaimed space', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}dup.txt`), 'dupdup'); await put(A(e, `${PFX}keep.txt`), 'dupdup');
  await put(A(e, `${PFX}chg.txt`), 'change');
  await put(A(e, `${PFX}ok.txt`), 'okok');
  const o1 = await op(e, 'trash', `${PFX}dup.txt`, { keeper: `${PFX}keep.txt` });
  const o2 = await op(e, 'trash', `${PFX}chg.txt`);
  const o3 = await op(e, 'trash', `${PFX}ok.txt`);
  await writeFile(A(e, `${PFX}keep.txt`), 'DUPDUP');  // keeper content differs now
  await writeFile(A(e, `${PFX}chg.txt`), 'changed!'); // snapshot differs
  const calls: string[] = [];
  const report = await executeBatch(approveAll(e, [o1, o2, o3], 'trash'), { adapter: {
    moveToTrash: async (p) => { calls.push(path.basename(p)); await rename(p, path.join(e.outside, path.basename(p))); } } });
  assert.deepEqual(statuses(report), [`${o1.id}:failed:KEEPER_INVALID`, `${o2.id}:failed:FILE_CHANGED`, `${o3.id}:trashed`]);
  assert.deepEqual(calls, [`${PFX}ok.txt`]);
  assert.equal(report.space.freeBytesBefore, null); assert.equal(report.space.freeBytesAfter, null);
  assert.match(report.space.note, /확보한 공간으로 세지 않습니다/u);
  assert.match(report.space.note, /앱 내 자동 복구 없음/u);
  assert.match(report.results[2]!.detail, /휴지통/u);
  assert.doesNotMatch(report.results[2]!.detail, /영구 삭제/u);
});

test('V11-03 real OS trash: partial approval (2 of 3 afo-test- files) → only approved files leave; sibling kept; ~/.Trash name check', async (t) => {
  if (process.env['AFO_REAL_TRASH_TEST'] !== '1' || !darwin) { t.skip('AFO_REAL_TRASH_TEST=1 (macOS) 에서만 실제 휴지통 검사'); return; }
  const e = await setup(t);
  const tag = randomUUID().slice(0, 8);
  const names = ['a', 'b', 'c'].map((n) => `${PFX}v11-${tag}-${n}.txt`);
  for (const n of names) await put(A(e, n), `real-trash-${n}`);
  await put(A(e, `${PFX}v11-${tag}-sibling.txt`), 'stay');
  const ops = [];
  for (const n of names) ops.push(await op(e, 'trash', n, { hash: true }));
  const p = makePlan(e.grant, ops, 'trash');
  const approved = [ops[0]!, ops[2]!];
  let deletes = 0;
  const report = await executeBatch(makeBatch(e, p, makeApproval(p, approved.map((o) => o.id), 'trash')), { adapter: {
    deleteFilePermanently: async (x, y) => { deletes += 1; return deleteFilePermanently(x, y); } } });
  assert.deepEqual(statuses(report), [`${ops[0]!.id}:trashed`, `${ops[2]!.id}:trashed`]);
  assert.equal(deletes, 0);
  assert.equal(await exists(A(e, names[0]!)), false);
  assert.equal(await exists(A(e, names[2]!)), false);
  assert.equal(await readFile(A(e, names[1]!), 'utf8'), `real-trash-${names[1]}`);
  assert.equal(await readFile(A(e, `${PFX}v11-${tag}-sibling.txt`), 'utf8'), 'stay');
  assert.deepEqual(phases(await journal(e, report.runId)).map((s) => s.split(':').slice(1).join(':')), ['intent', 'done', 'intent', 'done']);
  try {
    const listing = await readdir(path.join(homedir(), '.Trash'));
    t.diagnostic(`~/.Trash has ${names[0]}: ${listing.some((n) => n.startsWith(names[0]!.replace(/\.txt$/u, '')))}, ${names[2]}: ${listing.some((n) => n.startsWith(names[2]!.replace(/\.txt$/u, '')))}`);
  } catch (error) { t.diagnostic(`~/.Trash not listable here (${(error as NodeJS.ErrnoException).code}); restore not checked`); }
});

test('V11-04 real OS trash failure (read-only parent folder): failed, file kept, no permanent-delete fallback', async (t) => {
  if (process.env['AFO_REAL_TRASH_TEST'] !== '1' || !darwin || isRoot) { t.skip('AFO_REAL_TRASH_TEST=1 (macOS, non-root) 에서만'); return; }
  const e = await setup(t);
  const name = `${PFX}v11-ro-${randomUUID().slice(0, 8)}.txt`;
  await put(A(e, `ro/${name}`), 'cannot-leave');
  const o = await op(e, 'trash', `ro/${name}`);
  await chmod(A(e, 'ro'), 0o555);
  let deletes = 0;
  const report = await executeBatch(approveAll(e, [o], 'trash'), { adapter: {
    deleteFilePermanently: async (x, y) => { deletes += 1; return deleteFilePermanently(x, y); } } });
  t.diagnostic(`real trash on read-only folder: ${statuses(report)[0]} — ${report.results[0]!.detail}`);
  assert.equal(report.results[0]!.status, 'failed');
  assert.equal(deletes, 0);
  assert.equal(await readFile(A(e, `ro/${name}`), 'utf8'), 'cannot-leave');
});

/* ============================ #12 permanent delete ============================ */

test('V12-01 permanent delete with valid keeper: target gone, keeper sha256 kept, free space observed separately from logical size', async (t) => {
  const e = await setup(t);
  const big = Buffer.alloc(256 * 1024, 7);
  await put(A(e, `${PFX}dup.bin`), big); await put(A(e, `k/${PFX}keep.bin`), big);
  await put(A(e, `${PFX}other.txt`), 'not selected');
  const keepSha = await shaOf(A(e, `k/${PFX}keep.bin`));
  const o = await op(e, 'delete', `${PFX}dup.bin`, { keeper: `k/${PFX}keep.bin` });
  const report = await executeBatch(approveAll(e, [o], 'permanent-delete'));
  assert.deepEqual(statuses(report), [`${o.id}:deleted`]);
  assert.equal(await exists(A(e, `${PFX}dup.bin`)), false);
  assert.equal(await shaOf(A(e, `k/${PFX}keep.bin`)), keepSha);
  assert.equal(await readFile(A(e, `${PFX}other.txt`), 'utf8'), 'not selected');
  assert.equal(report.space.logicalBytesSelected, big.length);
  assert.equal(typeof report.space.freeBytesBefore, 'number'); assert.equal(typeof report.space.freeBytesAfter, 'number');
  assert.match(report.space.note, /되돌릴 수 없습니다/u);
  assert.match(report.space.note, /정확한 회수량이 아닙니다/u);
  assert.match(report.space.note, /할당 크기 합/u);
  assert.match(report.results[0]!.detail, /할당 크기/u);
  t.diagnostic(`free before=${report.space.freeBytesBefore} after=${report.space.freeBytesAfter} logical=${report.space.logicalBytesSelected}`);
  assert.deepEqual(phases(await journal(e, report.runId)).map((s) => s.split(':').slice(1).join(':')), ['intent', 'done']);
});

test('V12-02 keeper invalid (edited same size / deleted / replaced by link / parent link outside) → KEEPER_INVALID, target kept, no delete call', { skip: !posix && 'symlink' }, async (t) => {
  const e = await setup(t);
  const mk = async (n: string): Promise<PlanOperation> => {
    await put(A(e, `${PFX}${n}-dup.txt`), `dup-${n}`); await put(A(e, `kp/${n}/${PFX}keep.txt`), `dup-${n}`);
    return op(e, 'delete', `${PFX}${n}-dup.txt`, { keeper: `kp/${n}/${PFX}keep.txt` });
  };
  const [edited, gone, linked, outside] = [await mk('e'), await mk('g'), await mk('l'), await mk('o')];
  await writeFile(A(e, `kp/e/${PFX}keep.txt`), 'DUP-e');
  await rm(A(e, `kp/g/${PFX}keep.txt`));
  await put(A(e, `same-l.txt`), 'dup-l'); await rm(A(e, `kp/l/${PFX}keep.txt`)); await symlink(A(e, 'same-l.txt'), A(e, `kp/l/${PFX}keep.txt`));
  await rename(A(e, 'kp/o'), path.join(e.outside, 'o')); await symlink(path.join(e.outside, 'o'), A(e, 'kp/o'));
  let deletes = 0;
  const report = await executeBatch(approveAll(e, [edited, gone, linked, outside], 'permanent-delete'), { adapter: {
    deleteFilePermanently: async (x, y) => { deletes += 1; return deleteFilePermanently(x, y); } } });
  assert.deepEqual(report.results.map((r) => r.errorCode), ['KEEPER_INVALID', 'KEEPER_INVALID', 'KEEPER_INVALID', 'KEEPER_INVALID']);
  assert.equal(deletes, 0);
  for (const n of ['e', 'g', 'l', 'o']) assert.equal(await readFile(A(e, `${PFX}${n}-dup.txt`), 'utf8'), `dup-${n}`);
  assert.equal(await readFile(path.join(e.outside, 'o', `${PFX}keep.txt`), 'utf8'), 'dup-o');
});

test('V12-03 delete refuses folders and hard-linked targets; mode separation (trash approval cannot delete, delete approval cannot trash)', async (t) => {
  const e = await setup(t);
  await put(A(e, `folder/${PFX}inner.txt`), 'inner');
  await put(A(e, `${PFX}hl.txt`), 'hard'); await link(A(e, `${PFX}hl.txt`), A(e, `${PFX}hl-2.txt`));
  const fo = await op(e, 'delete', 'folder');
  const hl = await op(e, 'delete', `${PFX}hl.txt`);
  const before = await manifest(e.root);
  const report = await executeBatch(approveAll(e, [fo, hl], 'permanent-delete'));
  assert.deepEqual(statuses(report), [`${fo.id}:failed:FILE_CHANGED`, `${hl.id}:failed:LINK_REJECTED`]);
  assert.deepEqual(await manifest(e.root), before);
  await put(A(e, `${PFX}m.txt`), 'mode');
  const del = await op(e, 'delete', `${PFX}m.txt`);
  const pDel = makePlan(e.grant, [del], 'permanent');
  await rejectsWith(executeBatch(makeBatch(e, pDel, makeApproval(pDel, [del.id], 'trash'))), 'MODE_MISMATCH');
  const tr = await op(e, 'trash', `${PFX}m.txt`);
  const pTr = makePlan(e.grant, [tr], 'trash');
  await rejectsWith(executeBatch(makeBatch(e, pTr, makeApproval(pTr, [tr.id], 'permanent-delete'))), 'MODE_MISMATCH');
  await rejectsWith(executeBatch(makeBatch(e, pTr, makeApproval(pTr, [tr.id], 'organize'))), 'MODE_MISMATCH');
  assert.equal(await readFile(A(e, `${PFX}m.txt`), 'utf8'), 'mode');
});

test('V12-04 locked (uchg) / permission denied / disk full (mock) / expired / changed: target kept, one attempt only, no retry on re-call', { skip: (!darwin || isRoot) && 'macOS chflags, non-root' }, async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}locked.txt`), 'locked'); await put(A(e, `ro/${PFX}perm.txt`), 'perm');
  await put(A(e, `${PFX}chg.txt`), 'chg-0', 1_700_000_000);
  const lk = await op(e, 'delete', `${PFX}locked.txt`);
  const pm = await op(e, 'delete', `ro/${PFX}perm.txt`);
  const cg = await op(e, 'delete', `${PFX}chg.txt`, { hash: true });
  await sh('chflags', ['uchg', A(e, `${PFX}locked.txt`)]); await chmod(A(e, 'ro'), 0o555);
  await put(A(e, `${PFX}chg.txt`), 'chg-1', 1_700_000_000);
  let deletes = 0;
  const adapter = { deleteFilePermanently: async (x: string, y?: Parameters<typeof deleteFilePermanently>[1]) => { deletes += 1; return deleteFilePermanently(x, y); } };
  const b = approveAll(e, [lk, pm, cg], 'permanent-delete');
  const report = await executeBatch(b, { adapter });
  assert.deepEqual(statuses(report), [`${lk.id}:failed:PERMISSION_DENIED`, `${pm.id}:failed:PERMISSION_DENIED`, `${cg.id}:failed:FILE_CHANGED`]);
  assert.equal(deletes, 2, 'one OS attempt per readied file, no retry');
  await rejectsWith(executeBatch(b, { adapter }), 'APPROVAL_USED');
  assert.equal(deletes, 2);
  for (const [f, c] of [[`${PFX}locked.txt`, 'locked'], [`ro/${PFX}perm.txt`, 'perm'], [`${PFX}chg.txt`, 'chg-1']] as const)
    assert.equal(await readFile(A(e, f), 'utf8'), c);
  // Expired approval.
  await sh('chflags', ['nouchg', A(e, `${PFX}locked.txt`)]);
  const lk2 = await op(e, 'delete', `${PFX}locked.txt`);
  const p = makePlan(e.grant, [lk2], 'permanent'); const now = Date.now();
  await rejectsWith(executeBatch(makeBatch(e, p, makeApproval(p, [lk2.id], 'permanent-delete',
    { issuedAt: iso(now - 30 * 60_000), expiresAt: iso(now - 21 * 60_000), usedAt: iso(now - 25 * 60_000) }))), 'APPROVAL_EXPIRED');
  // Disk full while journaling (mock): nothing deleted.
  const full = await executeBatch(approveAll(e, [lk2], 'permanent-delete'), { adapter: {
    appendJournal: async () => { throw new AfoError('DISK_FULL', 'sim ENOSPC'); } } });
  assert.deepEqual(statuses(full), [`${lk2.id}:failed:DISK_FULL`]);
  assert.equal(await readFile(A(e, `${PFX}locked.txt`), 'utf8'), 'locked');
});

test('V12-05 after an app restart (separate node process): run record, journal and file absence agree', async (t) => {
  const e = await setup(t);
  await put(A(e, `${PFX}gone.txt`), 'bye'); await put(A(e, `${PFX}keep.txt`), 'bye');
  const o = await op(e, 'delete', `${PFX}gone.txt`, { keeper: `${PFX}keep.txt` });
  const report = await executeBatch(approveAll(e, [o], 'permanent-delete'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exec = pathToFileURL(path.join(here, '..', 'packages', 'filesystem', 'src', 'executor.js')).href;
  const state = pathToFileURL(path.join(here, '..', 'packages', 'filesystem', 'src', 'state.js')).href;
  const script = `
    import { readRun, listRuns } from ${JSON.stringify(exec)};
    import { readJournal, journalFile } from ${JSON.stringify(state)};
    import { lstat } from 'node:fs/promises';
    const [stateDir, runId, target, keeper] = process.argv.slice(1);
    const rec = await readRun(stateDir, runId);
    const j = await readJournal(journalFile(stateDir, runId));
    const gone = await lstat(target).then(() => false, () => true);
    const kept = await lstat(keeper).then(() => true, () => false);
    console.log(JSON.stringify({ pid: process.pid, runs: await listRuns(stateDir), finished: rec.run.finishedAt !== null,
      statuses: rec.run.report.results.map((r) => r.status), phases: j.entries.map((x) => x.phase), corrupt: j.corrupt.length, gone, kept }));`;
  const { stdout } = await sh(process.execPath, ['--input-type=module', '-e', script, e.stateDir, report.runId, A(e, `${PFX}gone.txt`), A(e, `${PFX}keep.txt`)]);
  const seen = JSON.parse(stdout) as { pid: number; runs: string[]; finished: boolean; statuses: string[]; phases: string[]; corrupt: number; gone: boolean; kept: boolean };
  assert.notEqual(seen.pid, process.pid);
  assert.deepEqual({ ...seen, pid: 0 }, { pid: 0, runs: [report.runId], finished: true, statuses: ['deleted'], phases: ['intent', 'done'], corrupt: 0, gone: true, kept: true });
});

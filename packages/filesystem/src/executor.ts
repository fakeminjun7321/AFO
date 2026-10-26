import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AfoError, ApprovalModeSchema, ApprovalSchema, ErrorCodeSchema, ExecutionReportSchema, OpaqueIdSchema, OperationIdSchema,
  OperationPlanSchema, PlanOperationSchema, RelativePathSchema, approvalModeKind, isAfoError } from '../../contracts/src/index.js';
import type { Approval, ApprovalMode, ErrorCode, ExecutionReport, JournalEntry, OperationPlan, PlanOperation, RootGrant }
  from '../../contracts/src/index.js';
import { verifyGrant, within } from './grants.js';
import { PlatformError, deleteFilePermanently, freeSpace, linkMoveNoClobber, moveToTrash } from './platform.js';
import { appendJournal, assertStateDirOutside, journalFile, readJournal, readJson, writeJsonAtomic } from './state.js';

/**
 * Executor (#10 move, #11 trash, #12 permanent delete). Runs an already validated and consumed approval, one operation at a
 * time: journal intent (fsync) → re-verify root/parents/identity/content → OS call → independent check → journal done/failed.
 * Re-checks narrow but cannot close the gap between a check and the OS call (ADR 0001 decision 3).
 */
export interface ApprovedBatch { plan: OperationPlan; approval: Approval; operations: PlanOperation[]; grant: RootGrant; stateDir: string }

/** OS and journal calls. Tests may replace them; such results are mock results, not OS evidence. */
export interface ExecutorAdapter {
  linkMoveNoClobber: typeof linkMoveNoClobber; moveToTrash: typeof moveToTrash;
  deleteFilePermanently: typeof deleteFilePermanently; freeSpace: typeof freeSpace; appendJournal: typeof appendJournal;
}
const realAdapter: ExecutorAdapter = { linkMoveNoClobber, moveToTrash, deleteFilePermanently, freeSpace, appendJournal };
export type FaultPoint = 'after-intent' | 'after-op' | 'before-done';
export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Called after each operation's journal entry is closed. Errors thrown here are ignored. */
  onProgress?: (p: { done: number; total: number }) => void;
  /** Test only (#13). A throw propagates out of executeBatch unchanged and nothing more is written, like a crash. */
  faultInjection?: (point: FaultPoint, opId: string) => void;
  /** Test only: replace OS/journal calls (e.g. simulated EXDEV, ENOSPC, trash failure). */
  adapter?: Partial<ExecutorAdapter>;
}
export interface UndoOptions { signal?: AbortSignal; /** Test only, as in ExecuteOptions. */ adapter?: Partial<ExecutorAdapter> }

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const DigitsSchema = z.string().regex(/^\d+$/u);
const issue = (ctx: z.RefinementCtx, message: string): void => { ctx.addIssue({ code: 'custom', message }); };
const sameRun = (runId: string, report: ExecutionReport): boolean => report.runId === runId;
/** runs/<runId>.json: written before the first operation (report null), rewritten with the report at the end. */
export const RunRecordSchema = z.strictObject({
  formatVersion: z.literal(1), runId: OpaqueIdSchema, planId: Sha256Schema, approvalId: OpaqueIdSchema, rootGrantId: Sha256Schema,
  mode: ApprovalModeSchema, root: z.strictObject({ canonicalPath: z.string().min(1), device: DigitsSchema, inode: DigitsSchema }),
  operationIds: z.array(OperationIdSchema).min(1), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  report: ExecutionReportSchema.nullable(),
}).superRefine((r, ctx) => {
  if ((r.finishedAt === null) !== (r.report === null)) issue(ctx, '끝난 실행만 결과를 가집니다.');
  if (r.report && (!sameRun(r.runId, r.report) || r.report.planId !== r.planId || r.report.approvalId !== r.approvalId))
    issue(ctx, '실행 결과의 ID가 실행 기록과 다릅니다.');
});
/** runs/<runId>.undo-<n>.json: one file per undo attempt, so the original report is never overwritten. */
export const UndoRecordSchema = z.strictObject({
  formatVersion: z.literal(1), runId: OpaqueIdSchema, undoIndex: z.number().int().positive(), startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(), report: ExecutionReportSchema,
}).superRefine((r, ctx) => { if (!sameRun(r.runId, r.report)) issue(ctx, '되돌리기 결과의 실행 ID가 다릅니다.'); });
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type UndoRecord = z.infer<typeof UndoRecordSchema>;

/** The run finished but its record could not be saved; the journal still has every entry. */
export class RunRecordError extends AfoError {
  constructor(code: ErrorCode, message: string, readonly report: ExecutionReport, options?: { cause?: unknown }) {
    super(code, message, options); this.name = 'RunRecordError';
  }
}

const runsDir = (stateDir: string): string => path.join(stateDir, 'runs');
const runIdOf = (runId: unknown): string => {
  const parsed = OpaqueIdSchema.safeParse(runId);
  if (!parsed.success) throw new AfoError('APPROVAL_MISSING', '실행 ID 형식이 아닙니다.');
  return parsed.data;
};
export const runFile = (stateDir: string, runId: string): string => path.join(runsDir(stateDir), `${runIdOf(runId)}.json`);
const undoFile = (stateDir: string, runId: string, n: number): string => path.join(runsDir(stateDir), `${runId}.undo-${n}.json`);
const claimFile = (stateDir: string, approvalId: string): string => path.join(runsDir(stateDir), `${approvalId}.approval`);

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK = 64 * 1024;
const errnoOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const codeOf = (error: unknown): ErrorCode => {
  if (error instanceof AfoError || error instanceof PlatformError) {
    const parsed = ErrorCodeSchema.safeParse(error.code);
    return parsed.success ? parsed.data : 'UNKNOWN';
  }
  const e = errnoOf(error);
  return e === 'ENOSPC' || e === 'EDQUOT' ? 'DISK_FULL' : e === 'EACCES' || e === 'EPERM' || e === 'EROFS' ? 'PERMISSION_DENIED'
    : e === 'ENOENT' ? 'SOURCE_MISSING' : e === 'EBUSY' ? 'FILE_BUSY' : 'UNKNOWN';
};
/** Korean adapter/service messages carry no paths; raw Node messages do, so only their errno is shown. */
const messageOf = (error: unknown): string => error instanceof AfoError || error instanceof PlatformError ? error.message
  : `예상하지 못한 오류입니다(${/^[A-Z0-9_]{1,32}$/u.test(errnoOf(error)) ? errnoOf(error) : 'unknown'}).`;
const journalCode = (error: unknown): ErrorCode => codeOf(error) === 'DISK_FULL' ? 'DISK_FULL' : 'JOURNAL_FAILED';

async function lstatOrNull(p: string): Promise<BigIntStats | null> {
  try { return await lstat(p, { bigint: true }); }
  catch (error) { if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return null; throw error; }
}
const sameStat = (a: BigIntStats, b: BigIntStats): boolean => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.nlink === b.nlink;
const changed = (message = '미리보기 이후 파일이 바뀌었습니다.'): AfoError => new AfoError('FILE_CHANGED', message);

/** Streams one file (64 KiB chunks, O_NOFOLLOW); the open handle must stay the same dev/ino/size throughout. */
async function hashFile(abs: string, expected: BigIntStats): Promise<string> {
  const handle = await open(abs, constants.O_RDONLY | NOFOLLOW);
  try {
    const same = (s: BigIntStats): boolean => s.isFile() && s.dev === expected.dev && s.ino === expected.ino && s.size === expected.size;
    if (!same(await handle.stat({ bigint: true }))) throw changed();
    const hash = createHash('sha256'); const buffer = Buffer.alloc(CHUNK);
    let total = 0n;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead)); total += BigInt(bytesRead);
      if (total > expected.size) throw changed();
    }
    if (total !== expected.size || !same(await handle.stat({ bigint: true }))) throw changed();
    return hash.digest('hex');
  } finally { await handle.close(); }
}

interface Ctx { root: string; device: bigint; inode: bigint; adapter: ExecutorAdapter }
interface Track { created: number; phase: 'prepare' | 'os' }
type Identity = NonNullable<JournalEntry['after']>;
interface Outcome { status: ExecutionReport['results'][number]['status']; errorCode: ErrorCode | null; detail: string;
  after: Identity | null; allocated: number | null }
const unknown = (detail: string): Outcome => ({ status: 'unknown', errorCode: 'UNKNOWN', detail, after: null, allocated: null });

function inside(ctx: Ctx, rel: string): { abs: string; parts: string[] } {
  const parsed = RelativePathSchema.safeParse(rel);
  if (!parsed.success) throw new AfoError('PATH_OUTSIDE_ROOT', '지원하지 않는 상대 경로입니다.');
  const parts = parsed.data.split('/');
  const abs = path.join(ctx.root, ...parts);
  if (abs === ctx.root || !within(ctx.root, abs)) throw new AfoError('PATH_OUTSIDE_ROOT', '선택한 폴더 밖의 경로입니다.');
  return { abs, parts };
}

/**
 * Every folder from the root down to the parent of `parts`: a real folder, not a link, on the root's volume (CARRYOVER O-1).
 * With `onCreate`, a missing folder is created one level at a time (non-recursive) and re-checked. The final real path must be inside the root.
 */
async function folders(ctx: Ctx, parts: string[], onCreate: (() => void) | null): Promise<void> {
  const root = await lstat(ctx.root, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== ctx.device || root.ino !== ctx.inode)
    throw changed('선택한 폴더가 바뀌었습니다(다른 폴더·링크로 교체).');
  let dir = ctx.root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let stat = await lstatOrNull(dir);
    if (!stat && onCreate) {
      try { await mkdir(dir); onCreate(); } catch (error) { if (errnoOf(error) !== 'EEXIST') throw error; }
      stat = await lstatOrNull(dir);
    }
    if (!stat) throw new AfoError(onCreate ? 'FILE_CHANGED' : 'SOURCE_MISSING', '경로의 폴더가 없습니다.');
    if (stat.isSymbolicLink()) throw new AfoError('LINK_REJECTED', '경로 중간에 링크·바로가기가 있어 다루지 않습니다.');
    if (!stat.isDirectory()) throw new AfoError(onCreate ? 'DEST_EXISTS' : 'FILE_CHANGED', '경로 중간에 폴더가 아닌 항목이 있습니다.');
    if (stat.dev !== ctx.device) throw new AfoError('CROSS_VOLUME', '경로 중간 폴더가 다른 볼륨에 있습니다.');
  }
  if (!within(ctx.root, await realpath(dir))) throw new AfoError('PATH_OUTSIDE_ROOT', '실제 위치가 선택한 폴더 밖입니다.');
}

/** Source right before the OS call: single-link regular file equal to the plan snapshot; content re-hashed when a hash exists. */
async function checkSource(ctx: Ctx, rel: string, expected: PlanOperation['expected']): Promise<{ abs: string; stat: BigIntStats }> {
  const { abs, parts } = inside(ctx, rel);
  await folders(ctx, parts, null);
  const stat = await lstatOrNull(abs);
  if (!stat) throw new AfoError('SOURCE_MISSING', '원본 파일이 없습니다.');
  if (stat.isSymbolicLink()) throw new AfoError('LINK_REJECTED', '링크·바로가기는 다루지 않습니다.');
  if (!stat.isFile()) throw changed('원본이 일반 파일이 아닙니다.');
  if (stat.nlink !== 1n) throw new AfoError('LINK_REJECTED', '하드링크가 여러 개인 파일은 다루지 않습니다.');
  if (String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode || stat.size !== BigInt(expected.size) ||
      String(stat.mtimeNs) !== expected.modifiedNs) throw changed();
  if (expected.sha256 !== null) {
    if (await hashFile(abs, stat) !== expected.sha256) throw changed('미리보기 이후 파일 내용이 바뀌었습니다.');
    const again = await lstatOrNull(abs);
    if (!again || !sameStat(again, stat)) throw changed();
  }
  return { abs, stat };
}

/** Duplicate deletion: the file to keep must exist, be a separate single-link regular file and have the same content. */
async function checkKeeper(ctx: Ctx, op: PlanOperation): Promise<void> {
  if (op.keeper === null) return; // explicit user selection of a non-duplicate file (CARRYOVER #8)
  try {
    const { abs, parts } = inside(ctx, op.keeper);
    await folders(ctx, parts, null);
    const stat = await lstatOrNull(abs);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n ||
        (String(stat.dev) === op.expected.device && String(stat.ino) === op.expected.inode)) throw new Error('keeper');
    if (await hashFile(abs, stat) !== op.expected.sha256) throw new Error('keeper content');
    const again = await lstatOrNull(abs);
    if (!again || !sameStat(again, stat)) throw new Error('keeper changed');
  } catch (error) {
    throw new AfoError('KEEPER_INVALID', '남길 파일이 없거나 바뀌어 삭제하지 않았습니다.', { cause: error });
  }
}

/** After a failed OS call: was the file left exactly where it was (failed) or is the outcome unclear (unknown)? */
async function intact(holder: string, other: string | null, device: string, inode: string): Promise<boolean> {
  const s = await lstatOrNull(holder);
  if (!s || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || String(s.dev) !== device || String(s.ino) !== inode) return false;
  const o = other === null ? null : await lstatOrNull(other);
  return !(o && o.dev === s.dev && o.ino === s.ino);
}
async function failure(error: unknown, track: Track, check: () => Promise<boolean>): Promise<Outcome> {
  const code = codeOf(error);
  const folderNote = track.created > 0 ? ` 새로 만든 폴더 ${track.created}개는 그대로 남아 있습니다.` : '';
  if (track.phase === 'os' && (code === 'UNKNOWN' || !await check().catch(() => false)))
    return unknown(`결과를 확인할 수 없습니다(${code}). ${messageOf(error)}${folderNote}`);
  return { status: 'failed', errorCode: code, detail: `${messageOf(error)}${folderNote}`, after: null, allocated: null };
}

/** Moved file after the move: same inode at the destination, nothing at the source. Hashed so undo can detect later edits. */
async function confirmMove(src: string, dst: string, before: BigIntStats, expectedSha: string | null): Promise<Outcome | Identity> {
  if (await lstatOrNull(src)) return unknown('이동 후에도 원래 경로에 파일이 있습니다.');
  const d = await lstatOrNull(dst);
  if (!d || d.isSymbolicLink() || !d.isFile() || d.dev !== before.dev || d.ino !== before.ino || d.size !== before.size || d.nlink !== 1n)
    return unknown('이동 후 목적지 파일을 확인할 수 없습니다.');
  let sha: string | null = null;
  try { sha = await hashFile(dst, d); } catch (error) { if (expectedSha !== null) return unknown(`이동한 파일 내용을 확인하지 못했습니다(${codeOf(error)}).`); }
  if (expectedSha !== null && sha !== expectedSha) return unknown('이동한 파일의 내용이 예상과 다릅니다.');
  return { device: String(d.dev), inode: String(d.ino), size: Number(d.size), sha256: sha };
}
const isOutcome = (value: Outcome | Identity): value is Outcome => 'status' in value;

/** organize, trash and permanent delete each say exactly what their numbers do and do not mean. */
function spaceNote(mode: ApprovalMode, before: number | null, after: number | null, allocated: number | null): string {
  if (mode === 'organize') return '이동은 같은 볼륨 안에서 위치만 바꾸므로 저장 공간을 확보하지 않습니다. 논리 크기는 선택한 파일 크기의 합입니다.';
  if (mode === 'trash') return '휴지통으로 보낸 파일은 같은 디스크에 남아 있어 확보한 공간으로 세지 않습니다. ' +
    '논리 크기는 선택한 파일 크기의 합이며 여유 공간은 관측하지 않았습니다. 복원은 Finder 휴지통·Windows 휴지통에서 직접 합니다(앱 내 자동 복구 없음).';
  return '영구 삭제는 되돌릴 수 없습니다. 논리 크기(선택한 파일 크기 합)' +
    `${allocated === null ? '' : `, 삭제한 파일의 할당 크기 합(관측 ${allocated}바이트)`}과 파일시스템 여유 공간 전후 관측치는 서로 다른 값입니다. ` +
    (before === null || after === null ? '여유 공간을 관측하지 못했습니다. '
      : '여유 공간 변화는 다른 프로그램의 쓰기·스냅샷·복제(clone) 파일의 영향을 받으므로 정확한 회수량이 아닙니다.');
}

async function checkBatch(batch: ApprovedBatch): Promise<ApprovedBatch> {
  if (batch === null || typeof batch !== 'object') throw new AfoError('APPROVAL_MISSING', '실행할 승인 배치가 없습니다.');
  const parse = <S extends z.ZodType>(schema: S, value: unknown, code: ErrorCode, message: string): z.output<S> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AfoError(code, message, { cause: parsed.error });
    return parsed.data;
  };
  const grant = await verifyGrant(batch.grant, 'work');
  const plan = parse(OperationPlanSchema, batch.plan, 'PLAN_CHANGED', '정리 계획이 계약과 다릅니다.');
  const approval = parse(ApprovalSchema, batch.approval, 'APPROVAL_INVALID', '승인 기록이 계약과 다릅니다.');
  if (!Array.isArray(batch.operations)) throw new AfoError('APPROVAL_INVALID', '승인한 작업 목록이 없습니다.');
  const operations = batch.operations.map((op) => parse(PlanOperationSchema, op, 'APPROVAL_INVALID', '승인한 작업이 계약과 다릅니다.'));
  if (typeof batch.stateDir !== 'string' || !path.isAbsolute(batch.stateDir))
    throw new AfoError('STATE_DIR_INVALID', '상태 폴더는 절대 경로여야 합니다.');
  // The grant is re-issued in this process, so its id may differ from plan.rootGrantId; the folder itself must be the same.
  if (grant.canonicalPath !== plan.rootPath) throw new AfoError('ROOT_FORBIDDEN', '계획의 폴더와 권한을 받은 폴더가 다릅니다.');
  await assertStateDirOutside(batch.stateDir, grant.canonicalPath);
  if (approval.planId !== plan.id || (approval.rootGrantId !== plan.rootGrantId && approval.rootGrantId !== grant.id))
    throw new AfoError('APPROVAL_INVALID', '다른 계획·폴더의 승인입니다.');
  if (approval.profileId !== plan.profileId || approval.profileRevision !== plan.profileRevision)
    throw new AfoError('PROFILE_CHANGED', '승인 이후 개인 규칙 버전이 바뀌었습니다.');
  if (approval.usedAt === null) throw new AfoError('APPROVAL_INVALID', '아직 확인(소비)되지 않은 승인입니다.');
  if (!(Date.parse(approval.expiresAt) > Date.now())) throw new AfoError('APPROVAL_EXPIRED', '승인 유효 시간이 지났습니다. 다시 승인하세요.');
  if (operations.length !== approval.operationIds.length || operations.some((op, i) => op.id !== approval.operationIds[i]))
    throw new AfoError('APPROVAL_INVALID', '승인한 작업 목록과 실행할 작업이 다릅니다.');
  const planned = new Map(plan.operations.map((op) => [op.id, op]));
  if (operations.some((op) => !isDeepStrictEqual(op, planned.get(op.id))))
    throw new AfoError('PLAN_CHANGED', '계획에 없거나 계획과 다른 작업입니다.');
  if (operations.some((op) => op.kind !== approvalModeKind[approval.mode]))
    throw new AfoError('MODE_MISMATCH', '승인한 방식과 작업 종류가 다릅니다.');
  return { plan, approval, operations, grant, stateDir: path.normalize(batch.stateDir) };
}

/** Exclusive marker per approval (open 'wx'): the same approval never starts a second run, even from another process. */
async function claimApproval(stateDir: string, approvalId: string, runId: string): Promise<void> {
  try {
    await mkdir(runsDir(stateDir), { recursive: true, mode: 0o700 });
    const handle = await open(claimFile(stateDir, approvalId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ formatVersion: 1, approvalId, runId })}\n`); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') throw new AfoError('APPROVAL_USED', '이미 실행한 승인입니다.');
    throw new AfoError(journalCode(error), '실행 기록을 시작하지 못해 파일을 바꾸지 않았습니다.', { cause: error });
  }
}
async function saveRun(stateDir: string, record: RunRecord): Promise<void> {
  try { await writeJsonAtomic(runFile(stateDir, record.runId), record, RunRecordSchema); }
  catch (error) { throw new AfoError(journalCode(error), '실행 기록을 저장하지 못했습니다.', { cause: error }); }
}

type Result = ExecutionReport['results'][number];
const toResult = (opId: string, o: Pick<Outcome, 'status' | 'errorCode' | 'detail'>): Result =>
  ({ opId, status: o.status, errorCode: o.errorCode, detail: o.detail });
const success = (status: Result['status']): boolean => status === 'moved' || status === 'trashed' || status === 'deleted';
const identityOf = (expected: PlanOperation['expected']): Identity =>
  ({ device: expected.device, inode: expected.inode, size: expected.size, sha256: expected.sha256 });

/**
 * Runs an approved batch in order (never in parallel). Batch-level checks throw AfoError before any file or journal change.
 * Per operation the result is moved/trashed/deleted only after an independent check; anything not run is skipped, unclear is unknown.
 * Saves runs/<runId>.json (meta + report). Journal: journal/<runId>.jsonl; a `failed` entry with UNKNOWN may be an unclear outcome.
 */
export async function executeBatch(batch: ApprovedBatch, options: ExecuteOptions = {}): Promise<ExecutionReport> {
  const adapter: ExecutorAdapter = { ...realAdapter, ...options.adapter };
  const { plan, approval, operations, grant, stateDir } = await checkBatch(batch);
  // TODO(#13): wrap in withRootLock(stateDir, grant.id, ...) once lock.ts lands
  const runId = randomUUID();
  const record: RunRecord = { formatVersion: 1, runId, planId: plan.id, approvalId: approval.id, rootGrantId: plan.rootGrantId,
    mode: approval.mode, root: { canonicalPath: grant.canonicalPath, device: grant.device, inode: grant.inode },
    operationIds: operations.map((op) => op.id), startedAt: new Date().toISOString(), finishedAt: null, report: null };
  await claimApproval(stateDir, approval.id, runId);
  await saveRun(stateDir, record);

  const ctx: Ctx = { root: grant.canonicalPath, device: BigInt(grant.device), inode: BigInt(grant.inode), adapter };
  const file = journalFile(stateDir, runId);
  let seq = 0;
  const write = (phase: JournalEntry['phase'], op: PlanOperation, after: Identity | null, errorCode: ErrorCode | null): Promise<void> =>
    adapter.appendJournal(file, { formatVersion: 1, runId, seq: seq++, opId: op.id, planId: plan.id, rootGrantId: plan.rootGrantId,
      approvalId: approval.id, phase, kind: op.kind, source: op.source, destination: op.destination, before: identityOf(op.expected),
      after, errorCode, at: new Date().toISOString() });
  const permanent = approval.mode === 'permanent-delete';
  const freeBytesBefore = permanent ? await adapter.freeSpace(ctx.root) : null;
  const results: Result[] = [];
  let broken: ErrorCode | null = null; let cancelled = false; let skipJournal = true; let allocated: number | null = 0;
  const progress = (): void => { try { options.onProgress?.({ done: results.length, total: operations.length }); } catch { /* UI callback */ } };

  for (const op of operations) {
    if (broken) { results.push(toResult(op.id, { status: 'skipped', errorCode: broken, detail: '저널을 기록할 수 없어 실행하지 않았습니다.' })); progress(); continue; }
    if (cancelled || options.signal?.aborted) {
      cancelled = true;
      if (skipJournal) skipJournal = await write('skipped', op, null, 'CANCELLED').then(() => true, () => false);
      results.push(toResult(op.id, { status: 'skipped', errorCode: 'CANCELLED', detail: '취소해 실행하지 않았습니다.' })); progress(); continue;
    }
    try { await write('intent', op, null, null); } catch (error) {
      broken = journalCode(error);
      results.push(toResult(op.id, { status: 'failed', errorCode: broken, detail: '실행 전 저널을 기록하지 못해 파일을 바꾸지 않았습니다.' }));
      progress(); continue;
    }
    options.faultInjection?.('after-intent', op.id);
    const outcome = await runOperation(ctx, op, options);
    options.faultInjection?.('before-done', op.id);
    if (outcome.status === 'deleted') allocated = allocated === null || outcome.allocated === null ? null : allocated + outcome.allocated;
    try { await write(success(outcome.status) ? 'done' : 'failed', op, outcome.after, outcome.errorCode); } catch (error) {
      broken = journalCode(error);
      outcome.detail += ' 결과를 저널에 기록하지 못했습니다(복구 검사 필요).';
    }
    results.push(toResult(op.id, outcome)); progress();
  }

  const freeBytesAfter = permanent ? await adapter.freeSpace(ctx.root) : null;
  const deletedAny = results.some((r) => r.status === 'deleted');
  const report = ExecutionReportSchema.parse({ formatVersion: 1, runId, planId: plan.id, approvalId: approval.id, results,
    space: { logicalBytesSelected: operations.reduce((sum, op) => sum + op.expected.size, 0), freeBytesBefore, freeBytesAfter,
      note: spaceNote(approval.mode, freeBytesBefore, freeBytesAfter, deletedAny ? allocated : null) } });
  try { await saveRun(stateDir, { ...record, finishedAt: new Date().toISOString(), report }); }
  catch (error) {
    throw new RunRecordError(isAfoError(error) ? error.code : 'JOURNAL_FAILED',
      '실행은 끝났지만 결과 파일을 저장하지 못했습니다. 항목별 결과는 저널에 있습니다.', report, { cause: error });
  }
  return report;
}

async function runOperation(ctx: Ctx, op: PlanOperation, options: ExecuteOptions): Promise<Outcome> {
  const track: Track = { created: 0, phase: 'prepare' };
  const expected = { device: op.expected.device, inode: op.expected.inode, size: op.expected.size, modifiedNs: op.expected.modifiedNs };
  let src = ''; let dst: string | null = null; let before: BigIntStats;
  try {
    ({ abs: src, stat: before } = await checkSource(ctx, op.source, op.expected));
    if (op.kind === 'move') {
      if (op.destination === null) throw new AfoError('PLAN_CHANGED', '이동 목적지가 없습니다.');
      const target = inside(ctx, op.destination);
      dst = target.abs;
      await folders(ctx, target.parts, () => { track.created += 1; });
      if (await lstatOrNull(dst)) throw new AfoError('DEST_EXISTS', '목적지에 이미 파일이 있어 덮어쓰지 않았습니다.');
      track.phase = 'os';
      await ctx.adapter.linkMoveNoClobber(src, dst, expected);
    } else {
      await checkKeeper(ctx, op);
      track.phase = 'os';
      // Never retried, and a trash failure never falls back to permanent deletion or recursive removal.
      if (op.kind === 'trash') await ctx.adapter.moveToTrash(src, expected);
      else await ctx.adapter.deleteFilePermanently(src, expected);
    }
  } catch (error) {
    return failure(error, track, () => intact(src || path.join(ctx.root, ...op.source.split('/')), dst, op.expected.device, op.expected.inode));
  }
  options.faultInjection?.('after-op', op.id);
  const folderNote = track.created > 0 ? ` 폴더 ${track.created}개를 만들었습니다.` : '';
  try {
    if (op.kind === 'move') {
      const checked = await confirmMove(src, dst!, before, op.expected.sha256);
      if (isOutcome(checked)) return checked;
      return { status: 'moved', errorCode: null, detail: `이동했습니다.${folderNote}`, after: checked, allocated: null };
    }
    if (await lstatOrNull(src)) return unknown('작업 후에도 원래 경로에 파일이 있습니다.');
    if (op.kind === 'trash') return { status: 'trashed', errorCode: null, after: null, allocated: null,
      detail: '휴지통으로 보냈습니다. 복원은 Finder 휴지통·Windows 휴지통에서 직접 합니다.' };
    const allocatedBytes = process.platform === 'win32' ? null : Number(before.blocks * 512n);
    return { status: 'deleted', errorCode: null, after: null, allocated: allocatedBytes,
      detail: `영구 삭제했습니다(되돌릴 수 없음). 할당 크기 ${allocatedBytes === null ? '알 수 없음' : `관측 ${allocatedBytes}바이트`}.` };
  } catch (error) { return unknown(`작업 후 결과를 확인하지 못했습니다(${codeOf(error)}).`); }
}

async function undoIndexes(stateDir: string, runId: string): Promise<number[]> {
  let names: string[];
  try { names = await readdir(runsDir(stateDir)); }
  catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw new AfoError('STATE_CORRUPT', '실행 기록 폴더를 읽을 수 없습니다.', { cause: error });
  }
  const pattern = new RegExp(`^${runId}\\.undo-([1-9]\\d{0,8})\\.json$`, 'u');
  return names.flatMap((name) => { const m = pattern.exec(name); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b);
}

/** Run meta + report and every undo attempt; null when the run does not exist. Damaged records are STATE_CORRUPT. */
export async function readRun(stateDir: string, runId: string): Promise<{ run: RunRecord; undos: UndoRecord[] } | null> {
  const id = runIdOf(runId);
  const run = await readJson(runFile(stateDir, id), RunRecordSchema);
  if (!run) return null;
  if (run.runId !== id) throw new AfoError('STATE_CORRUPT', '실행 기록의 ID가 파일 이름과 다릅니다.');
  const undos: UndoRecord[] = [];
  for (const n of await undoIndexes(stateDir, id)) {
    const undo = await readJson(undoFile(stateDir, id, n), UndoRecordSchema);
    if (undo && (undo.runId !== id || undo.undoIndex !== n)) throw new AfoError('STATE_CORRUPT', '되돌리기 기록이 실행 기록과 다릅니다.');
    if (undo) undos.push(undo);
  }
  return { run, undos };
}

/** Run IDs with a record in stateDir/runs, sorted. */
export async function listRuns(stateDir: string): Promise<string[]> {
  let names: string[];
  try { names = await readdir(runsDir(stateDir)); }
  catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw new AfoError('STATE_CORRUPT', '실행 기록 폴더를 읽을 수 없습니다.', { cause: error });
  }
  return names.flatMap((name) => { const m = /^([a-z0-9-]{8,128})\.json$/u.exec(name); return m ? [m[1]!] : []; })
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

interface UndoState { started: boolean; finished: boolean; done: JournalEntry | null; undoOpen: boolean; undoUnknown: boolean; undone: boolean }
/**
 * Journal per op. After an `undo-intent`, a later `failed`/`skipped` of the same op is that undo's outcome, not the original op's.
 */
function undoStates(entries: JournalEntry[]): Map<string, UndoState> {
  const states = new Map<string, UndoState>();
  for (const e of entries) {
    const s = states.get(e.opId) ?? { started: false, finished: false, done: null, undoOpen: false, undoUnknown: false, undone: false };
    states.set(e.opId, s);
    if (e.phase === 'intent') s.started = true;
    else if (e.phase === 'done') { s.done = e; s.finished = true; }
    else if (e.phase === 'undo-intent') { s.undoOpen = true; s.undoUnknown = false; }
    else if (e.phase === 'undone') { s.undoOpen = false; s.undone = true; }
    else if (s.undoOpen) { s.undoOpen = false; s.undoUnknown = e.errorCode === 'UNKNOWN'; }
    else s.finished = true;
  }
  return states;
}

/**
 * Moves files of a finished organize run back, only where the moved file is unchanged (dev/ino/size, sha256 when recorded)
 * and the original path is empty; never overwrites. Trash and permanent delete are not undone here (restore from the OS trash).
 * Already undone operations are left out of the report; interrupted or unclear ones are reported unknown and not touched.
 * Empty folders created by the move are not removed. Saves runs/<runId>.undo-<n>.json and keeps the original report.
 */
export async function undoRun(stateDir: string, runId: string, grantInput: RootGrant, options: UndoOptions = {}): Promise<ExecutionReport> {
  const adapter: ExecutorAdapter = { ...realAdapter, ...options.adapter };
  const grant = await verifyGrant(grantInput, 'work');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new AfoError('STATE_DIR_INVALID', '상태 폴더는 절대 경로여야 합니다.');
  await assertStateDirOutside(stateDir, grant.canonicalPath);
  // TODO(#13): wrap in withRootLock(stateDir, grant.id, ...) once lock.ts lands
  const found = await readRun(stateDir, runId);
  if (!found) throw new AfoError('APPROVAL_MISSING', '해당 실행 기록이 없습니다.');
  const { run } = found;
  if (run.root.canonicalPath !== grant.canonicalPath) throw new AfoError('ROOT_FORBIDDEN', '이 실행은 다른 폴더에서 했습니다.');
  if (run.root.device !== grant.device || run.root.inode !== grant.inode) throw changed('실행한 뒤 선택한 폴더가 바뀌었습니다.');
  if (run.mode !== 'organize') throw new AfoError('NOT_SUPPORTED',
    '휴지통 이동·영구 삭제는 되돌리기 대상이 아닙니다. 휴지통 복원은 Finder 휴지통·Windows 휴지통에서 직접 합니다.');
  const journal = await readJournal(journalFile(stateDir, run.runId));
  if (journal && journal.corrupt.length > 0) throw new AfoError('STATE_CORRUPT', '저널에 손상된 줄이 있어 추측하지 않고 되돌리기를 거부했습니다.');
  const entries = journal?.entries ?? [];
  if (entries.some((e) => e.runId !== run.runId || e.planId !== run.planId || e.approvalId !== run.approvalId || e.kind !== 'move'))
    throw new AfoError('STATE_CORRUPT', '저널이 실행 기록과 다릅니다.');
  const states = undoStates(entries);
  const startedAt = new Date().toISOString();
  const ctx: Ctx = { root: grant.canonicalPath, device: BigInt(grant.device), inode: BigInt(grant.inode), adapter };
  const file = journalFile(stateDir, run.runId);
  let seq = entries.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
  const write = (phase: JournalEntry['phase'], done: JournalEntry, after: Identity | null, errorCode: ErrorCode | null): Promise<void> =>
    adapter.appendJournal(file, { ...done, seq: seq++, phase, after, errorCode, at: new Date().toISOString() });
  const results: Result[] = []; let broken: ErrorCode | null = null; let logical = 0;

  for (const opId of run.operationIds) {
    const state = states.get(opId);
    if (!state || state.undone) continue;
    if (!state.done) {
      if (state.started && !state.finished) results.push(toResult(opId, unknown('실행 결과가 확인되지 않아 되돌리지 않았습니다. 복구 검사가 필요합니다.')));
      continue;
    }
    if (state.undoOpen || state.undoUnknown) {
      results.push(toResult(opId, unknown('이전 되돌리기의 결과가 확인되지 않아 다시 시도하지 않았습니다. 복구 검사가 필요합니다.'))); continue;
    }
    const done = state.done; const after = done.after!;
    logical += after.size;
    if (broken) { results.push(toResult(opId, { status: 'skipped', errorCode: broken, detail: '저널을 기록할 수 없어 되돌리지 않았습니다.' })); continue; }
    if (options.signal?.aborted) { results.push(toResult(opId, { status: 'skipped', errorCode: 'CANCELLED', detail: '취소해 되돌리지 않았습니다.' })); continue; }
    try { await write('undo-intent', done, null, null); } catch (error) {
      broken = journalCode(error);
      results.push(toResult(opId, { status: 'failed', errorCode: broken, detail: '저널을 기록하지 못해 파일을 바꾸지 않았습니다.' })); continue;
    }
    const outcome = await undoOperation(ctx, done, after);
    try { await write(success(outcome.status) ? 'undone' : 'failed', done, success(outcome.status) ? after : null, outcome.errorCode); }
    catch (error) { broken = journalCode(error); outcome.detail += ' 결과를 저널에 기록하지 못했습니다(복구 검사 필요).'; }
    results.push(toResult(opId, outcome));
  }

  const report = ExecutionReportSchema.parse({ formatVersion: 1, runId: run.runId, planId: run.planId, approvalId: run.approvalId, results,
    space: { logicalBytesSelected: logical, freeBytesBefore: null, freeBytesAfter: null,
      note: '되돌리기는 같은 볼륨 안에서 위치만 바꾸므로 저장 공간을 바꾸지 않습니다. 이동하면서 만든 빈 폴더는 지우지 않습니다.' } });
  const n = ((await undoIndexes(stateDir, run.runId)).at(-1) ?? 0) + 1;
  try {
    await writeJsonAtomic(undoFile(stateDir, run.runId, n),
      { formatVersion: 1, runId: run.runId, undoIndex: n, startedAt, finishedAt: new Date().toISOString(), report }, UndoRecordSchema);
  } catch (error) {
    throw new RunRecordError(isAfoError(error) ? error.code : 'JOURNAL_FAILED',
      '되돌리기는 끝났지만 결과 파일을 저장하지 못했습니다. 항목별 결과는 저널에 있습니다.', report, { cause: error });
  }
  return report;
}

async function undoOperation(ctx: Ctx, done: JournalEntry, after: Identity): Promise<Outcome> {
  const track: Track = { created: 0, phase: 'prepare' };
  let from = ''; let to = ''; let current: BigIntStats;
  try {
    if (done.destination === null) throw new AfoError('STATE_CORRUPT', '이동 기록에 목적지가 없습니다.');
    const moved = inside(ctx, done.destination); const original = inside(ctx, done.source);
    from = moved.abs; to = original.abs;
    await folders(ctx, moved.parts, null);
    const stat = await lstatOrNull(from);
    if (!stat) throw new AfoError('SOURCE_MISSING', '정리한 위치에 파일이 없어 되돌리지 않았습니다.');
    current = stat;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== after.device ||
        String(stat.ino) !== after.inode || stat.size !== BigInt(after.size)) throw changed('정리한 뒤 파일이 바뀌어 되돌리지 않았습니다.');
    if (after.sha256 !== null) {
      if (await hashFile(from, stat) !== after.sha256) throw changed('정리한 뒤 파일 내용이 바뀌어 되돌리지 않았습니다.');
      const again = await lstatOrNull(from);
      if (!again || !sameStat(again, stat)) throw changed('정리한 뒤 파일이 바뀌어 되돌리지 않았습니다.');
    }
    if (await lstatOrNull(to)) throw new AfoError('DEST_EXISTS', '원래 위치에 다른 파일이 있어 덮어쓰지 않았습니다.');
    await folders(ctx, original.parts, () => { track.created += 1; });
    if (await lstatOrNull(to)) throw new AfoError('DEST_EXISTS', '원래 위치에 다른 파일이 있어 덮어쓰지 않았습니다.');
    track.phase = 'os';
    await ctx.adapter.linkMoveNoClobber(from, to, { device: after.device, inode: after.inode, size: after.size, modifiedNs: String(stat.mtimeNs) });
  } catch (error) {
    return failure(error, track, () => intact(from, to || null, after.device, after.inode));
  }
  try {
    const checked = await confirmMove(from, to, current, after.sha256);
    if (isOutcome(checked)) return checked;
    return { status: 'moved', errorCode: null, after: checked, allocated: null,
      detail: `되돌렸습니다(원래 위치로 이동).${track.created > 0 ? ` 폴더 ${track.created}개를 다시 만들었습니다.` : ''}` };
  } catch (error) { return unknown(`되돌린 뒤 결과를 확인하지 못했습니다(${codeOf(error)}).`); }
}

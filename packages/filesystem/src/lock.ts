import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AfoError } from '../../contracts/src/index.js';
import type { ErrorCode } from '../../contracts/src/index.js';
import { statePaths } from './state.js';

/**
 * One run per work root (#13), keyed on the folder's device+inode, not the grant ID (which differs per issue).
 * Layout: `locks/<key>/<n>.lock` generation files and `<n>.released` markers. A process takes generation m+1 with O_EXCL only
 * when generation m is released or stale, then backs off if any newer generation exists. No process ever deletes or replaces
 * the newest generation, and release only adds a marker, so at most one live holder exists (argument: docs/verification/ISSUE_13.md).
 * Not re-entrant. LOCKED_BY_OTHER and ROOT_FORBIDDEN are thrown only before fn runs; a release error only after fn succeeded.
 * Overlapping roots (a folder and its subfolder) are different locks; per-operation no-clobber and re-verification still apply.
 */
export const MAX_LOCK_BYTES = 32 * 1024; // room for a 4096-character escaped canonicalPath
export const LOCK_ACQUIRE_ATTEMPTS = 5;
export const LOCK_RELEASE_WARNING = 'AFO_LOCK_RELEASE_FAILED';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const GENERATION_NAME = /^([1-9]\d{0,15})\.(lock|released)$/u;
const DigitsSchema = z.string().regex(/^\d{1,40}$/u);
/** Same absolute forms as the contracts: POSIX, drive or UNC; no NUL, no \\?\ or \\.\ device paths. */
const CanonicalPathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\u0000') &&
  (/^\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\(?![?.]\\)[^\\]/u.test(value)));
const RootLockTargetSchema = z.object({ canonicalPath: CanonicalPathSchema, device: DigitsSchema, inode: DigitsSchema });
/** A RootGrant satisfies this structurally. */
export interface RootLockTarget { canonicalPath: string; device: string; inode: string }
/** canonicalPath is for diagnostics and manual release only; the lock decision never uses it. */
export const RootLockSchema = z.strictObject({ formatVersion: z.literal(1), pid: z.number().int().positive(),
  hostname: z.string().min(1).max(255), startedAt: z.iso.datetime(), token: z.string().regex(/^[a-f0-9]{32}$/u),
  canonicalPath: CanonicalPathSchema, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export type RootLockHolder = z.infer<typeof RootLockSchema>;
export type RootLockState = 'free' | 'held' | 'stale' | 'foreign-host' | 'corrupt';
interface Seen { state: RootLockState; holder: RootLockHolder | null; bytes: Buffer | null; reason: string; missing?: true }

const fsCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const failure = (fallback: ErrorCode, message: string, error: unknown): AfoError => {
  if (error instanceof AfoError) return error;
  const code = fsCode(error);
  return new AfoError(code === 'ENOSPC' ? 'DISK_FULL' : code === 'EACCES' || code === 'EPERM' ? 'PERMISSION_DENIED' : fallback,
    message, { cause: error });
};
/** kill(pid, 0): success or EPERM means the process exists. Anything but ESRCH counts as alive (blocks, never frees). */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return fsCode(error) !== 'ESRCH'; }
};

const target = (root: RootLockTarget): RootLockTarget => {
  const parsed = RootLockTargetSchema.safeParse(root);
  if (!parsed.success) throw new AfoError('ROOT_FORBIDDEN', '작업 폴더 식별 정보(절대 경로·device·inode)가 올바르지 않습니다.');
  return parsed.data;
};
const stateRoot = (stateDir: string): string => {
  const absolute = typeof stateDir === 'string' && (process.platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u.test(stateDir) : path.isAbsolute(stateDir));
  if (!absolute || stateDir.includes('\u0000'))
    throw new AfoError('STATE_DIR_INVALID', '상태 폴더는 NUL 없는 절대 경로여야 합니다(상대 경로는 실행 위치마다 달라 잠금이 갈라집니다).');
  return stateDir;
};
/** sha256 of device+inode only, so every spelling (case, Unicode form, link alias) of one folder maps to one lock. */
export const rootLockKey = (root: RootLockTarget): string => {
  const { device, inode } = target(root);
  return createHash('sha256').update(`afo-root-lock-v1\0${device}\0${inode}`).digest('hex');
};
/** The lock folder `<stateDir>/locks/<key>`; deleting it whole is the manual release. Validated before any disk access. */
export const rootLockFile = (stateDir: string, root: RootLockTarget): string =>
  path.join(statePaths(stateRoot(stateDir)).locks, rootLockKey(root));
const lockName = (folder: string, n: number): string => path.join(folder, `${n}.lock`);
const markerName = (folder: string, n: number): string => path.join(folder, `${n}.released`);

/** false when missing (read only); STATE_CORRUPT when a level is a link or not a folder, so it is never reported as free. */
async function lockFolder(stateDir: string, folder: string, create: boolean): Promise<boolean> {
  for (const directory of [path.dirname(folder), folder]) {
    try {
      if (create) {
        if (directory !== folder) await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if (fsCode(error) !== 'EEXIST') throw error; });
      }
      if (!(await lstat(directory)).isDirectory()) throw new AfoError('STATE_CORRUPT', `잠금 폴더가 일반 폴더가 아닙니다: ${directory}`);
    } catch (error) {
      if (!create && fsCode(error) === 'ENOENT') return false;
      throw failure('STATE_CORRUPT', `잠금 폴더를 준비할 수 없습니다: ${directory}`, error);
    }
  }
  return true;
}

interface Generations { max: number; all: number[] }
/** Generation numbers present as `<n>.lock` (max) or either name (all). Unknown names are ignored, never deleted. */
async function generations(folder: string): Promise<Generations> {
  let names: string[];
  try { names = await readdir(folder); }
  catch (error) { throw failure('STATE_CORRUPT', `잠금 폴더를 읽을 수 없습니다: ${folder}`, error); }
  const result: Generations = { max: 0, all: [] };
  for (const name of names) {
    const match = GENERATION_NAME.exec(name);
    const n = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(n)) continue;
    result.all.push(n);
    if (match[2] === 'lock') result.max = Math.max(result.max, n);
  }
  return result;
}

async function inspect(file: string): Promise<Seen> {
  const corrupt = (reason: string, bytes: Buffer | null = null): Seen => ({ state: 'corrupt', holder: null, bytes, reason });
  let handle: FileHandle;
  try {
    if (!(await lstat(file)).isFile()) return corrupt('일반 파일이 아님(링크·폴더 등)');
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return { state: 'free', holder: null, bytes: null, reason: '없음', missing: true };
    if (fsCode(error) === 'ELOOP') return corrupt('일반 파일이 아님(링크)');
    throw failure('STATE_CORRUPT', `잠금 파일을 읽을 수 없습니다: ${file}`, error);
  }
  const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
  let total = 0;
  try {
    if (!(await handle.stat()).isFile()) return corrupt('일반 파일이 아님');
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
  } finally { await handle.close(); }
  const bytes = Buffer.from(buffer.subarray(0, total));
  if (total > MAX_LOCK_BYTES) return corrupt('크기 한도 초과', bytes);
  let holder: RootLockHolder;
  try { holder = RootLockSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { return corrupt(total === 0 ? '비어 있음(다른 실행이 기록 중이거나 기록 전에 중단됨)' : 'JSON이 아니거나 잠금 계약과 다름', bytes); }
  if (`${holder.generation}.lock` !== path.basename(file)) return corrupt('파일 이름과 세대 번호가 다름', bytes);
  if (holder.hostname !== hostname()) return { state: 'foreign-host', holder, bytes, reason: '다른 컴퓨터' };
  return alive(holder.pid) ? { state: 'held', holder, bytes, reason: '실행 중' } : { state: 'stale', holder, bytes, reason: '프로세스 없음' };
}

/** State of generation n: a regular `<n>.released` marker frees it; otherwise the lock file decides. */
async function judge(folder: string, n: number): Promise<Seen> {
  try {
    if ((await lstat(markerName(folder, n))).isFile()) return { state: 'free', holder: null, bytes: null, reason: '해제됨' };
    return { state: 'corrupt', holder: null, bytes: null, reason: '해제 표시가 일반 파일이 아님' };
  } catch (error) {
    if (fsCode(error) !== 'ENOENT') throw failure('STATE_CORRUPT', `해제 표시를 확인할 수 없습니다: ${markerName(folder, n)}`, error);
  }
  return inspect(lockName(folder, n));
}

const busy = (folder: string, n: number, seen: Seen): AfoError => {
  const h = seen.holder;
  const manual = `실행 중인 AFO가 하나도 없음을 확인한 뒤 잠금 폴더를 통째로 지우세요: ${folder}`;
  if (h && seen.state === 'held') return new AfoError('LOCKED_BY_OTHER',
    `다른 AFO 실행(pid ${h.pid}, ${h.startedAt} 시작)이 이 작업 폴더를 사용 중입니다. 끝난 뒤 다시 시도하세요. ` +
    `그 pid가 AFO가 아니라면(재시작 뒤 번호 재사용) ${manual}`);
  if (h) return new AfoError('LOCKED_BY_OTHER',
    `다른 컴퓨터(${h.hostname})의 AFO 실행(pid ${h.pid}, ${h.startedAt} 시작)이 잠금을 갖고 있어 자동으로 풀지 않습니다. ` +
    `그 컴퓨터에서 실행이 끝났는지 확인한 뒤 ${manual}`);
  return new AfoError('LOCKED_BY_OTHER', `잠금 파일 ${lockName(folder, n)}을 해석할 수 없어 자동으로 풀지 않았습니다(${seen.reason}). ` +
    `다른 실행이 막 시작하는 중일 수 있으니 잠시 뒤 다시 시도하고, 계속되면 ${manual}`);
};

/** Adds `<n>.released` with O_EXCL. Throws the raw error (EEXIST included). */
async function mark(folder: string, n: number, token: string): Promise<void> {
  const handle = await open(markerName(folder, n), EXCLUSIVE, 0o600);
  try { await handle.writeFile(`${JSON.stringify({ formatVersion: 1, generation: n, token })}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function acquire(folder: string, canonicalPath: string): Promise<{ generation: number; token: string }> {
  const token = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    const { max } = await generations(folder);
    if (max > 0) {
      const seen = await judge(folder, max);
      if (seen.missing) continue; // cleaned by a newer holder after we listed; look again
      if (seen.state !== 'free' && seen.state !== 'stale') throw busy(folder, max, seen);
    }
    const generation = max + 1;
    if (!Number.isSafeInteger(generation)) throw new AfoError('STATE_CORRUPT', `잠금 세대 번호가 한도를 넘었습니다. ${folder} 폴더를 직접 지우세요.`);
    const parsed = RootLockSchema.safeParse({ formatVersion: 1, pid: process.pid, hostname: hostname(),
      startedAt: new Date().toISOString(), token, canonicalPath, generation });
    if (!parsed.success) throw new AfoError('NOT_SUPPORTED', '이 컴퓨터 이름·프로세스 번호로는 잠금을 만들 수 없습니다.', { cause: parsed.error });
    let handle: FileHandle;
    try { handle = await open(lockName(folder, generation), EXCLUSIVE, 0o600); }
    catch (error) {
      if (fsCode(error) === 'EEXIST') continue;
      throw failure('UNKNOWN', `잠금 파일을 만들 수 없습니다: ${lockName(folder, generation)}`, error);
    }
    // From here our generation exists. Never delete it (an older generation would become the newest again); mark it released on failure.
    let after: Generations;
    try {
      try { await handle.writeFile(`${JSON.stringify(parsed.data)}\n`); await handle.sync(); } finally { await handle.close(); }
      after = await generations(folder);
    } catch (error) {
      const marked = await mark(folder, generation, token).then(() => true, () => false);
      throw failure('UNKNOWN', `잠금 파일을 기록하지 못했습니다.${marked ? '' : ` 실행 중인 AFO가 없을 때 잠금 폴더를 통째로 지우세요: ${folder}`}`, error);
    }
    if (after.max > generation) {
      // A newer generation exists, so someone else won (we re-created an already-cleaned number from a stale listing).
      await mark(folder, generation, token).catch(() => undefined);
      throw new AfoError('LOCKED_BY_OTHER', '다른 AFO 실행이 방금 이 작업 폴더의 잠금을 얻었습니다. 끝난 뒤 다시 시도하세요.');
    }
    // Best effort: only generations older than ours (Windows may refuse deleting files another process has open).
    for (const n of new Set(after.all)) if (n < generation)
      for (const file of [lockName(folder, n), markerName(folder, n)]) await unlink(file).catch(() => undefined);
    return { generation, token };
  }
  throw new AfoError('LOCKED_BY_OTHER', '다른 실행과 잠금을 계속 다투고 있습니다. 잠시 뒤 다시 시도하세요.');
}

/** Adds our release marker. Never unlinks or renames anything. */
async function release(folder: string, generation: number, token: string): Promise<void> {
  const seen = await inspect(lockName(folder, generation));
  if (seen.holder?.token !== token) throw new AfoError('STATE_CORRUPT', seen.missing
    ? `실행 중 잠금 파일이 사라졌습니다. 같은 폴더를 다른 실행이 동시에 다뤘는지 저널을 확인하세요: ${lockName(folder, generation)}`
    : `실행 중 잠금 파일이 다른 내용으로 바뀌어 해제 표시를 남기지 않았습니다. 저널을 확인하고, 실행 중인 AFO가 없으면 잠금 폴더를 통째로 지우세요: ${folder}`);
  const { max } = await generations(folder);
  try { await mark(folder, generation, token); }
  catch (error) {
    if (fsCode(error) === 'EEXIST') throw new AfoError('STATE_CORRUPT', `해제 표시가 이미 있습니다(다른 실행이 만들었거나 위조됨): ${markerName(folder, generation)}`);
    throw failure('UNKNOWN', `해제 표시를 만들지 못했습니다: ${markerName(folder, generation)}`, error);
  }
  if (max > generation) throw new AfoError('STATE_CORRUPT',
    `실행 중 더 새 잠금(세대 ${max})이 생겼습니다. 같은 폴더를 다른 실행이 동시에 다뤘는지 저널을 확인하세요: ${folder}`);
}

/**
 * Runs fn while holding the newest generation in `rootLockFile(stateDir, root)`. fn's error propagates unchanged; if release
 * also fails then, it is reported via process.emitWarning (code LOCK_RELEASE_WARNING). If fn succeeded and release fails, that error is thrown.
 */
export async function withRootLock<T>(stateDir: string, root: RootLockTarget, fn: () => Promise<T>): Promise<T> {
  const { canonicalPath } = target(root);
  const folder = rootLockFile(stateDir, root);
  await lockFolder(stateDir, folder, true);
  const { generation, token } = await acquire(folder, canonicalPath);
  let result: T;
  try { result = await fn(); }
  catch (error) {
    await release(folder, generation, token).catch((releaseError: unknown) => {
      process.emitWarning(`작업 실패 뒤 잠금 해제도 실패: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        { code: LOCK_RELEASE_WARNING });
    });
    throw error;
  }
  try { await release(folder, generation, token); }
  catch (error) {
    const known = failure('UNKNOWN', '잠금을 풀지 못했습니다.', error);
    throw new AfoError(known.code, `작업은 끝났지만 ${known.message}`, { cause: error });
  }
  return result;
}

/** Read-only view of the newest generation for recovery/GUI ("a run is active"). Never creates, removes or repairs anything. */
export async function readRootLock(stateDir: string, root: RootLockTarget): Promise<{ state: RootLockState; holder: RootLockHolder | null }> {
  const folder = rootLockFile(stateDir, root);
  // Windows open() under a regular file reports ENOENT; checking each folder level keeps that case from reading as 'free'.
  if (!(await lockFolder(stateDir, folder, false))) return { state: 'free', holder: null };
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    const { max } = await generations(folder);
    if (max === 0) return { state: 'free', holder: null };
    const seen = await judge(folder, max);
    if (!seen.missing) return { state: seen.state, holder: seen.state === 'free' ? null : seen.holder };
  }
  return { state: 'held', holder: null }; // generations keep changing: some run is active
}

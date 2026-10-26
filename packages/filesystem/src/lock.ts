import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AfoError } from '../../contracts/src/index.js';
import type { ErrorCode } from '../../contracts/src/index.js';
import { statePaths } from './state.js';

/**
 * One run per work root (#13). Not re-entrant: a second call in the same process is also LOCKED_BY_OTHER.
 * LOCKED_BY_OTHER and ROOT_FORBIDDEN are thrown only before fn runs. A release error is thrown only after fn succeeded.
 * Known limits: a reused pid makes a dead lock look alive (blocks; manual release); SIGKILL leaves the file until the
 * next acquirer finds the pid dead; a three-way race during stale takeover can still admit two holders (docs/verification/ISSUE_13.md).
 */
export const MAX_LOCK_BYTES = 4096;
export const LOCK_ACQUIRE_ATTEMPTS = 3;
export const LOCK_RELEASE_WARNING = 'AFO_LOCK_RELEASE_FAILED';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const RootGrantIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const RootLockSchema = z.strictObject({ formatVersion: z.literal(1), pid: z.number().int().positive(),
  hostname: z.string().min(1).max(255), startedAt: z.iso.datetime(), token: z.string().regex(/^[a-f0-9]{32}$/u) });
export type RootLockHolder = z.infer<typeof RootLockSchema>;
export type RootLockState = 'free' | 'held' | 'stale' | 'foreign-host' | 'corrupt';
interface Seen { state: RootLockState; holder: RootLockHolder | null; bytes: Buffer | null; reason: string }

const fsCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const failure = (fallback: ErrorCode, message: string, error: unknown): AfoError => {
  if (error instanceof AfoError) return error;
  const code = fsCode(error);
  return new AfoError(code === 'ENOSPC' ? 'DISK_FULL' : code === 'EACCES' || code === 'EPERM' ? 'PERMISSION_DENIED' : fallback,
    message, { cause: error });
};
/** kill(pid, 0): success or EPERM means the process exists. Anything but ESRCH counts as alive (blocks, never deletes). */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return fsCode(error) !== 'ESRCH'; }
};

/** ROOT_FORBIDDEN unless the ID is a RootGrant.id (64 lowercase hex), checked before any disk access. */
export const rootLockFile = (stateDir: string, rootGrantId: string): string => {
  if (!RootGrantIdSchema.safeParse(rootGrantId).success)
    throw new AfoError('ROOT_FORBIDDEN', '작업 폴더 ID가 올바르지 않습니다(64자리 소문자 16진수여야 합니다).');
  return path.join(statePaths(stateDir).locks, `${rootGrantId}.lock`);
};

async function inspect(file: string): Promise<Seen> {
  const corrupt = (reason: string, bytes: Buffer | null = null): Seen => ({ state: 'corrupt', holder: null, bytes, reason });
  let handle: FileHandle;
  try {
    if (!(await lstat(file)).isFile()) return corrupt('일반 파일이 아님(링크·폴더 등)');
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return { state: 'free', holder: null, bytes: null, reason: '' };
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
  if (holder.hostname !== hostname()) return { state: 'foreign-host', holder, bytes, reason: '다른 컴퓨터' };
  return alive(holder.pid) ? { state: 'held', holder, bytes, reason: '실행 중' } : { state: 'stale', holder, bytes, reason: '프로세스 없음' };
}

const busy = (file: string, seen: Seen): AfoError => {
  const h = seen.holder;
  const manual = `다른 AFO 실행이 없음을 확인한 뒤 잠금 파일을 직접 지우세요: ${file}`;
  if (h && seen.state === 'held') return new AfoError('LOCKED_BY_OTHER',
    `다른 AFO 실행(pid ${h.pid}, ${h.startedAt} 시작)이 이 작업 폴더를 사용 중입니다. 끝난 뒤 다시 시도하세요. ` +
    `그 pid가 AFO가 아니라면(재시작 뒤 번호 재사용) ${manual}`);
  if (h) return new AfoError('LOCKED_BY_OTHER',
    `다른 컴퓨터(${h.hostname})의 AFO 실행(pid ${h.pid}, ${h.startedAt} 시작)이 잠금을 갖고 있어 자동으로 풀지 않습니다. ` +
    `그 컴퓨터에서 실행이 끝났는지 확인한 뒤 잠금 파일을 직접 지우세요: ${file}`);
  return new AfoError('LOCKED_BY_OTHER', `잠금 파일을 해석할 수 없어 자동으로 지우지 않았습니다(${seen.reason}). ` +
    `다른 실행이 막 시작하는 중일 수 있으니 잠시 뒤 다시 시도하고, 계속되면 ${manual}`);
};

/** Moves the judged-stale file aside, and deletes it only if it still has the bytes we judged; otherwise puts it back. */
async function clearStale(file: string, judged: Buffer): Promise<void> {
  const aside = `${file}.stale-${randomBytes(8).toString('hex')}`;
  try { await rename(file, aside); }
  catch (error) {
    if (fsCode(error) === 'ENOENT') return; // someone else cleared it; retry the exclusive create
    throw failure('UNKNOWN', `오래된 잠금을 치우지 못했습니다: ${file}`, error);
  }
  const moved = await inspect(aside).catch(() => null);
  if (moved?.bytes?.equals(judged)) {
    try { await unlink(aside); return; }
    catch (error) { throw failure('UNKNOWN', `오래된 잠금을 지우지 못했습니다: ${aside}`, error); }
  }
  // A racing process replaced the lock after we read it: restore without clobbering (link fails if the path is taken).
  try { await link(aside, file); }
  catch (error) {
    if (fsCode(error) !== 'EEXIST') throw new AfoError('LOCKED_BY_OTHER',
      `다른 실행의 잠금을 원래 자리로 되돌리지 못했습니다. 실행 중인 AFO가 없을 때 ${aside} 파일을 ${file} 이름으로 되돌리거나 지우세요.`, { cause: error });
  }
  await unlink(aside).catch(() => undefined);
  throw new AfoError('LOCKED_BY_OTHER', '다른 AFO 실행이 방금 이 작업 폴더의 잠금을 얻었습니다. 끝난 뒤 다시 시도하세요.');
}

async function acquire(file: string): Promise<RootLockHolder> {
  const parsed = RootLockSchema.safeParse({ formatVersion: 1, pid: process.pid, hostname: hostname(),
    startedAt: new Date().toISOString(), token: randomBytes(16).toString('hex') });
  if (!parsed.success) throw new AfoError('NOT_SUPPORTED', '이 컴퓨터 이름·프로세스 번호로는 잠금을 만들 수 없습니다.', { cause: parsed.error });
  const bytes = Buffer.from(`${JSON.stringify(parsed.data)}\n`);
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    let handle: FileHandle;
    try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
    catch (error) {
      if (fsCode(error) !== 'EEXIST') throw failure('UNKNOWN', `잠금 파일을 만들 수 없습니다: ${file}`, error);
      const seen = await inspect(file);
      if (seen.state === 'free') continue;
      if (seen.state !== 'stale' || seen.bytes === null) throw busy(file, seen);
      await clearStale(file, seen.bytes);
      continue;
    }
    try { await handle.writeFile(bytes); await handle.sync(); await handle.close(); }
    catch (error) {
      await handle.close().catch(() => undefined);
      // We created it exclusively and unparseable locks are never auto-removed by others, so it is ours to remove.
      const removed = await unlink(file).then(() => true, () => false);
      throw failure('UNKNOWN', `잠금 파일을 기록하지 못했습니다.${removed ? '' : ` 남은 잠금 파일을 직접 지우세요: ${file}`}`, error);
    }
    return parsed.data;
  }
  throw new AfoError('LOCKED_BY_OTHER', '다른 실행과 잠금을 계속 다투고 있습니다. 잠시 뒤 다시 시도하세요.');
}

/** Unlinks the lock only while it still carries our token. */
async function release(file: string, token: string): Promise<void> {
  const seen = await inspect(file);
  if (seen.holder?.token !== token) throw new AfoError('STATE_CORRUPT', seen.state === 'free'
    ? `실행 중 잠금 파일이 사라졌습니다. 같은 폴더를 다른 실행이 동시에 다뤘는지 저널을 확인하세요: ${file}`
    : `실행 중 잠금 파일이 다른 내용으로 바뀌어 지우지 않았습니다. 저널을 확인하고, 실행 중인 AFO가 없으면 직접 지우세요: ${file}`);
  try { await unlink(file); }
  catch (error) { throw failure('UNKNOWN', `잠금 파일을 지우지 못했습니다: ${file}`, error); }
}

/**
 * Runs fn while holding `<stateDir>/locks/<rootGrantId>.lock`. fn's error propagates unchanged; if release also fails
 * then, it is reported via process.emitWarning (code LOCK_RELEASE_WARNING). If fn succeeded and release fails, that error is thrown.
 */
export async function withRootLock<T>(stateDir: string, rootGrantId: string, fn: () => Promise<T>): Promise<T> {
  const file = rootLockFile(stateDir, rootGrantId);
  const directory = path.dirname(file);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new AfoError('STATE_CORRUPT', `잠금 폴더가 일반 폴더가 아닙니다: ${directory}`);
  } catch (error) { throw failure('STATE_CORRUPT', `잠금 폴더를 준비할 수 없습니다: ${directory}`, error); }
  const { token } = await acquire(file);
  let result: T;
  try { result = await fn(); }
  catch (error) {
    await release(file, token).catch((releaseError: unknown) => {
      process.emitWarning(`작업 실패 뒤 잠금 해제도 실패: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        { code: LOCK_RELEASE_WARNING });
    });
    throw error;
  }
  try { await release(file, token); }
  catch (error) {
    const known = failure('UNKNOWN', '잠금을 풀지 못했습니다.', error);
    throw new AfoError(known.code, `작업은 끝났지만 ${known.message}`, { cause: error });
  }
  return result;
}

/** Read-only view for recovery/GUI ("a run is active"). Never creates, removes or repairs anything. */
export async function readRootLock(stateDir: string, rootGrantId: string): Promise<{ state: RootLockState; holder: RootLockHolder | null }> {
  const { state, holder } = await inspect(rootLockFile(stateDir, rootGrantId));
  return { state, holder };
}

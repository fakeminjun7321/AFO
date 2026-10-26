import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { AfoError, JournalEntrySchema, OpaqueIdSchema } from '../../contracts/src/index.js';
import type { ErrorCode, JournalEntry } from '../../contracts/src/index.js';

/** App-local state lives outside every work root. Locks are added with #13. */
export const MAX_STATE_JSON_BYTES = 1024 * 1024;
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const fsCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const failure = (fallback: ErrorCode, message: string, error: unknown): AfoError => {
  if (error instanceof AfoError) return error;
  const code = fsCode(error);
  return new AfoError(code === 'ENOSPC' ? 'DISK_FULL' : code === 'EACCES' || code === 'EPERM' ? 'PERMISSION_DENIED' : fallback,
    message, { cause: error });
};

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  home: string = homedir()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // On Windows '\state' is relative to the current drive; require a drive letter or UNC prefix.
  const absolute = (value: string): boolean => platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u.test(value) : p.isAbsolute(value);
  const explicit = env['AFO_STATE_DIR'];
  if (explicit !== undefined) {
    if (explicit.trim() === '' || !absolute(explicit) || explicit.includes('\u0000'))
      throw new AfoError('STATE_DIR_INVALID', 'AFO_STATE_DIR는 비어 있지 않은 절대 경로여야 합니다.');
    return p.normalize(explicit);
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'AFO');
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return p.join(local && absolute(local) ? local : p.join(home, 'AppData', 'Local'), 'AFO');
  }
  const xdg = env['XDG_STATE_HOME'];
  return xdg && absolute(xdg) ? p.join(xdg, 'afo') : p.join(home, '.local', 'state', 'afo');
}

export const statePaths = (stateDir: string) => ({
  profiles: path.join(stateDir, 'profiles'), plans: path.join(stateDir, 'plans'),
  approvals: path.join(stateDir, 'approvals'), journal: path.join(stateDir, 'journal'), locks: path.join(stateDir, 'locks'),
});
export const journalFile = (stateDir: string, runId: string): string =>
  path.join(statePaths(stateDir).journal, `${OpaqueIdSchema.parse(runId)}.jsonl`);

/** Real path of the nearest existing ancestor plus the not-yet-created tail. */
async function realish(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (true) {
    try { return path.join(await realpath(current), ...tail.reverse()); }
    catch (error) {
      const parent = path.dirname(current);
      if (fsCode(error) !== 'ENOENT' || parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}
const fold = (value: string): string =>
  process.platform === 'darwin' || process.platform === 'win32' ? value.normalize('NFC').toLowerCase() : value;
const contains = (outer: string, inner: string): boolean => {
  const rel = path.relative(fold(outer), fold(inner));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};

/** Rejects a state folder inside, equal to, or containing the work root (compared by real path). */
export async function assertStateDirOutside(stateDir: string, rootPath: string): Promise<void> {
  const [state, root] = await Promise.all([realish(stateDir), realpath(rootPath)]);
  if (contains(root, state) || contains(state, root))
    throw new AfoError('STATE_DIR_CONFLICT', '상태 폴더와 작업 폴더가 겹칩니다. AFO_STATE_DIR를 작업 폴더 밖으로 지정하세요.');
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return; // Directories cannot be opened for fsync on Windows.
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(fsCode(error) ?? '')) throw error; }
  finally { await handle.close(); }
}

/** temp file in the same folder → fsync → rename → parent fsync. Readers never see a partial file. */
export async function writeJsonAtomic(file: string, value: unknown, schema?: z.ZodType): Promise<void> {
  const data = JSON.stringify(schema ? schema.parse(value) : value, null, 2);
  if (data === undefined) throw new TypeError('JSON으로 저장할 수 없는 값입니다.');
  const bytes = Buffer.from(`${data}\n`);
  if (bytes.length > MAX_STATE_JSON_BYTES) throw new AfoError('STATE_CORRUPT', '상태 파일이 크기 한도를 넘습니다.');
  const directory = path.dirname(path.resolve(file));
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temp, { force: true });
    throw failure('UNKNOWN', '상태 파일을 저장하지 못했습니다.', error);
  }
}

async function readRegular(file: string, limit: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new AfoError('STATE_CORRUPT', '상태 경로가 일반 파일이 아닙니다.');
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return null;
    throw failure('STATE_CORRUPT', '상태 파일을 열 수 없습니다.', error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new AfoError('STATE_CORRUPT', '상태 파일이 크기 한도를 넘거나 일반 파일이 아닙니다.');
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total <= limit) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw new AfoError('STATE_CORRUPT', '상태 파일이 읽는 중 커졌습니다.');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

/** Returns null only when the file does not exist; anything unreadable or invalid is STATE_CORRUPT. */
export async function readJson<S extends z.ZodType>(file: string, schema: S): Promise<z.output<S> | null> {
  const bytes = await readRegular(file, MAX_STATE_JSON_BYTES);
  if (bytes === null) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw new AfoError('STATE_CORRUPT', '상태 파일이 올바른 JSON이 아닙니다.', { cause: error }); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AfoError('STATE_CORRUPT', '상태 파일이 계약과 다릅니다.', { cause: parsed.error });
  return parsed.data;
}

/** One validated JSON line per entry, fsynced before returning. A torn previous line is fenced off first. */
export async function appendJournal(file: string, entry: JournalEntry): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(JournalEntrySchema.parse(entry))}\n`);
  try {
    const directory = path.dirname(path.resolve(file));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600);
    let created = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AfoError('JOURNAL_FAILED', '저널 경로가 일반 파일이 아닙니다.');
      created = stat.size === 0;
      let prefix = Buffer.alloc(0);
      if (stat.size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) prefix = Buffer.from('\n');
      }
      await handle.write(Buffer.concat([prefix, line]));
      await handle.sync();
    } finally { await handle.close(); }
    if (created) await syncDirectory(directory);
  } catch (error) {
    throw new AfoError(fsCode(error) === 'ENOSPC' ? 'DISK_FULL' : 'JOURNAL_FAILED', '저널을 기록하지 못했습니다.', { cause: error });
  }
}

export interface JournalRead { entries: JournalEntry[]; corrupt: { line: number; reason: string }[] }
/** Valid entries plus every damaged line (1-based). Callers must not guess the content of damaged lines. */
export async function readJournal(file: string): Promise<JournalRead | null> {
  const bytes = await readRegular(file, MAX_JOURNAL_BYTES);
  if (bytes === null) return null;
  const result: JournalRead = { entries: [], corrupt: [] };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new AfoError('STATE_CORRUPT', '저널이 UTF-8이 아닙니다.', { cause: error }); }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let previous: JournalEntry | undefined;
  lines.forEach((raw, index) => {
    const line = index + 1;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { result.corrupt.push({ line, reason: 'JSON 아님 또는 잘린 줄' }); return; }
    const parsed = JournalEntrySchema.safeParse(value);
    if (!parsed.success) { result.corrupt.push({ line, reason: '저널 계약과 다름' }); return; }
    if (previous && parsed.data.runId !== previous.runId) { result.corrupt.push({ line, reason: '다른 실행 ID' }); return; }
    if (previous && parsed.data.seq <= previous.seq) { result.corrupt.push({ line, reason: '순번이 증가하지 않음' }); return; }
    result.entries.push(parsed.data); previous = parsed.data;
  });
  return result;
}

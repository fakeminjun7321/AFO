import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { access, link, lstat, statfs, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

/** Subset of DESIGN.md ErrorCode used by the OS adapter. Merge into contracts later. */
export type PlatformErrorCode = 'LINK_REJECTED' | 'FILE_CHANGED' | 'SOURCE_MISSING' | 'DEST_EXISTS' | 'CROSS_VOLUME' |
  'NOT_SUPPORTED' | 'PERMISSION_DENIED' | 'FILE_BUSY' | 'TRASH_FAILED' | 'DISK_FULL' | 'UNKNOWN';
export class PlatformError extends Error {
  constructor(readonly code: PlatformErrorCode, message: string, readonly detail: string | null = null) {
    super(message); this.name = 'PlatformError';
  }
}
export interface FileIdentity { kind: 'file' | 'directory' | 'symlink' | 'other'; device: string; inode: string;
  size: number; modifiedNs: string; nlink: number }
export interface ExpectedIdentity { device: string; inode: string; size?: number; modifiedNs?: string }

const errno = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error
  ? String(error.code) : '';
const fromErrno = (error: unknown, fallback: PlatformErrorCode = 'UNKNOWN'): PlatformError => {
  const code = errno(error);
  const mapped: PlatformErrorCode = code === 'ENOENT' ? 'SOURCE_MISSING' : code === 'EEXIST' ? 'DEST_EXISTS'
    : code === 'EXDEV' ? 'CROSS_VOLUME' : code === 'EACCES' || code === 'EROFS' ? 'PERMISSION_DENIED'
    : code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS' || code === 'EMLINK' ? 'NOT_SUPPORTED'
    : code === 'EBUSY' || code === 'ETXTBSY' ? 'FILE_BUSY' : code === 'ENOSPC' || code === 'EDQUOT' ? 'DISK_FULL' : fallback;
  return new PlatformError(mapped, `파일 작업이 실패했습니다(${code || 'unknown'}).`, code || null);
};
const kindOf = (s: BigIntStats): FileIdentity['kind'] =>
  s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other';
const toIdentity = (s: BigIntStats): FileIdentity => ({ kind: kindOf(s), device: String(s.dev), inode: String(s.ino),
  size: Number(s.size), modifiedNs: String(s.mtimeNs), nlink: Number(s.nlink) });
const absolute = (p: string): string => {
  if (typeof p !== 'string' || p === '' || !path.isAbsolute(p)) throw new PlatformError('NOT_SUPPORTED', '절대 경로만 받습니다.');
  return path.normalize(p);
};
async function lstatOrMissing(p: string): Promise<BigIntStats | null> {
  try { return await lstat(p, { bigint: true }); } catch (error) {
    if (errno(error) === 'ENOENT') return null;
    throw fromErrno(error);
  }
}

/** lstat-based identity. Windows junctions are reported as symlinks by Node/libuv; other reparse points are not verified. */
export async function fileIdentity(abs: string): Promise<FileIdentity | null> {
  const stat = await lstatOrMissing(absolute(abs));
  return stat ? toIdentity(stat) : null;
}

/** Only a single-link regular file that still matches `expected` may be moved or deleted. */
async function regularFile(abs: string, expected?: ExpectedIdentity): Promise<BigIntStats> {
  const stat = await lstatOrMissing(abs);
  if (!stat) throw new PlatformError('SOURCE_MISSING', '원본 파일이 없습니다.');
  if (stat.isSymbolicLink()) throw new PlatformError('LINK_REJECTED', '링크·junction은 다루지 않습니다.');
  if (!stat.isFile()) throw new PlatformError('NOT_SUPPORTED', '일반 파일만 다룹니다(폴더 제외).');
  if (stat.nlink !== 1n) throw new PlatformError('LINK_REJECTED', '하드링크가 여러 개인 파일은 다루지 않습니다.');
  if (expected && (String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode ||
      (expected.size !== undefined && stat.size !== BigInt(expected.size)) ||
      (expected.modifiedNs !== undefined && String(stat.mtimeNs) !== expected.modifiedNs)))
    throw new PlatformError('FILE_CHANGED', '미리보기 이후 파일이 바뀌었습니다.');
  return stat;
}

export async function sameVolume(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([lstat(absolute(a), { bigint: true }), lstat(absolute(b), { bigint: true })]);
  return x.dev === y.dev;
}

/**
 * No-clobber move on one volume: link(src, dst) fails with EEXIST instead of overwriting,
 * then src is unlinked only after dst is confirmed to be the same dev/ino.
 * A crash between link and unlink leaves both names on one inode (nlink 2); see classifyMoveState.
 */
export async function linkMoveNoClobber(src: string, dst: string, expected?: ExpectedIdentity): Promise<FileIdentity> {
  const from = absolute(src); const to = absolute(dst);
  const before = await regularFile(from, expected);
  const parent = await lstatOrMissing(path.dirname(to));
  if (!parent) throw new PlatformError('FILE_CHANGED', '목적지 폴더가 없거나 바뀌었습니다.');
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new PlatformError('LINK_REJECTED', '목적지 폴더가 링크이거나 폴더가 아닙니다.');
  if (parent.dev !== before.dev) throw new PlatformError('CROSS_VOLUME', '다른 볼륨으로의 이동은 지원하지 않습니다.');
  try { await link(from, to); } catch (error) { throw fromErrno(error); }
  const linked = await lstatOrMissing(to);
  if (!linked || linked.dev !== before.dev || linked.ino !== before.ino) {
    // src changed between the check and link(); drop only the name we created, while src still holds the data.
    const current = await lstatOrMissing(from);
    if (linked && current && linked.dev === current.dev && linked.ino === current.ino) await unlink(to).catch(() => undefined);
    throw new PlatformError('FILE_CHANGED', '이동 중 원본이 바뀌어 중단했습니다.');
  }
  // Re-check right before unlink: if another program replaced src after link(), do not unlink the new file.
  // This narrows but cannot close the check-then-unlink window (ADR 0001 decision 3).
  const current = await lstatOrMissing(from);
  if (!current || current.dev !== before.dev || current.ino !== before.ino) {
    const dstNow = await lstatOrMissing(to);
    if (current && dstNow && dstNow.dev === before.dev && dstNow.ino === before.ino && dstNow.nlink === 1n) {
      // dst is now the only name of the original data and src holds a new file: keep both, report the conflict.
      throw new PlatformError('FILE_CHANGED', '이동 중 원래 경로에 다른 파일이 생겨 두 파일을 모두 남겼습니다.');
    }
    throw new PlatformError('UNKNOWN', '이동 중 원래 경로가 바뀌어 중간 상태로 남겼습니다.');
  }
  try { await unlink(from); } catch (error) {
    const failure = fromErrno(error);
    const kept = await lstatOrMissing(from).catch(() => null);
    const rollback = !!kept && kept.dev === before.dev && kept.ino === before.ino &&
      await unlink(to).then(() => true, () => false);
    throw new PlatformError(rollback ? failure.code : 'UNKNOWN',
      rollback ? `원본 정리에 실패해 이동을 취소했습니다(${failure.detail ?? 'unknown'}).` : '원본과 목적지가 함께 남은 중간 상태입니다.',
      failure.detail);
  }
  if (await lstatOrMissing(from)) throw new PlatformError('UNKNOWN', '이동 후에도 원래 경로에 파일이 있습니다.');
  const after = await lstatOrMissing(to);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) throw new PlatformError('UNKNOWN', '이동 후 목적지를 확인할 수 없습니다.');
  return toIdentity(after);
}

/** Recovery helper for an interrupted move. Never fixes anything by itself. */
export type MoveState = 'not-started' | 'linked-both' | 'moved' | 'missing' | 'conflict';
export async function classifyMoveState(src: string, dst: string, expected: ExpectedIdentity): Promise<MoveState> {
  const [s, d] = await Promise.all([lstatOrMissing(absolute(src)), lstatOrMissing(absolute(dst))]);
  const match = (x: BigIntStats | null): boolean => !!x && x.isFile() && !x.isSymbolicLink() &&
    String(x.dev) === expected.device && String(x.ino) === expected.inode;
  // Two names really exist only when the inode has 2 links; otherwise src and dst resolve to the same entry
  // (case/Unicode folding or a linked parent) and "linked-both" would invite deleting the only copy.
  if (match(s) && match(d)) return s!.nlink === 2n && d!.nlink === 2n ? 'linked-both' : 'conflict';
  if (match(s) && !d) return 'not-started';
  if (!s && match(d)) return 'moved';
  if (!s && !d) return 'missing';
  return 'conflict';
}

const windowsPowerShell = (): string =>
  path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const trashTool = (): string | null =>
  process.platform === 'darwin' ? '/usr/bin/trash' : process.platform === 'win32' ? windowsPowerShell() : null;

export async function isTrashSupported(): Promise<boolean> {
  const tool = trashTool();
  if (!tool) return false;
  return access(tool, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false);
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { shell: false, windowsHide: true, timeout: 60_000, maxBuffer: 1 << 20, ...(env ? { env } : {}) },
      (error, _stdout, stderr) => resolve({ ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr: String(stderr).trim().slice(0, 500) }));
  });

/**
 * Windows sends a file to the Recycle Bin only on a local fixed drive whose bin is enabled and large enough;
 * otherwise SHFileOperation silently deletes permanently. The script refuses those cases (exit 3) before deleting.
 * Bin size: per-volume MaxCapacity (MB) under HKCU BitBucket\Volume\{GUID}; when absent, assume 5% of the volume.
 */
export const WINDOWS_NO_RECYCLE_EXIT = 3;
const WINDOWS_TRASH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:AFO_TRASH_PATH',
  '$item = Get-Item -LiteralPath $p -Force',
  '$root = [System.IO.Path]::GetPathRoot($item.FullName)',
  "if (-not $root -or $root.StartsWith('\\\\')) { [Console]::Error.WriteLine('AFO_NO_RECYCLE: network or device path'); exit 3 }",
  '$drive = New-Object System.IO.DriveInfo($root)',
  "if ($drive.DriveType -ne 'Fixed') { [Console]::Error.WriteLine('AFO_NO_RECYCLE: drive type ' + $drive.DriveType); exit 3 }",
  '$limit = [int64]($drive.TotalSize * 0.05)',
  "$vol = Get-CimInstance Win32_Volume -Filter (\"DriveLetter='\" + $root.Substring(0, 2) + \"'\")",
  'if ($vol) {',
  "  $guid = [regex]::Match([string]$vol.DeviceID, '\\{[^}]+\\}').Value",
  "  $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\' + $guid",
  '  if ($guid -and (Test-Path -LiteralPath $key)) {',
  '    $cfg = Get-ItemProperty -LiteralPath $key',
  "    if ($cfg.NukeOnDelete -eq 1) { [Console]::Error.WriteLine('AFO_NO_RECYCLE: recycle bin disabled'); exit 3 }",
  '    if ($null -ne $cfg.MaxCapacity) { $limit = [int64]$cfg.MaxCapacity * 1MB }',
  '  }',
  '}',
  "if ($item.Length -ge $limit) { [Console]::Error.WriteLine('AFO_NO_RECYCLE: larger than recycle bin limit'); exit 3 }",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')",
].join('\n');

/** Sends one regular file to the OS trash. Never falls back to permanent deletion. Restore is done by the user in Finder/Explorer. */
export async function moveToTrash(abs: string, expected?: ExpectedIdentity): Promise<void> {
  const target = absolute(abs);
  await regularFile(target, expected);
  if (!(await isTrashSupported())) throw new PlatformError('NOT_SUPPORTED', '이 OS에서는 휴지통 이동을 지원하지 않습니다.');
  const result = process.platform === 'darwin'
    ? await run('/usr/bin/trash', [target])
    : await run(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      WINDOWS_TRASH_SCRIPT], { ...process.env, AFO_TRASH_PATH: target });
  const still = await lstatOrMissing(target);
  if (result.code === WINDOWS_NO_RECYCLE_EXIT && still)
    throw new PlatformError('NOT_SUPPORTED', '이 위치에서는 휴지통을 쓸 수 없어 영구 삭제될 수 있으므로 거부했습니다.', result.stderr || null);
  if (!result.ok || still) throw new PlatformError('TRASH_FAILED', '휴지통으로 보내지 못했습니다.', result.stderr || null);
}

/** Irreversible: unlinks one single-link regular file. Folders and links are rejected. */
export async function deleteFilePermanently(abs: string, expected?: ExpectedIdentity): Promise<void> {
  const target = absolute(abs);
  await regularFile(target, expected);
  try { await unlink(target); } catch (error) { throw fromErrno(error); }
  if (await lstatOrMissing(target)) throw new PlatformError('UNKNOWN', '삭제 후에도 파일이 남아 있습니다.');
}

/** Free bytes available to this user on dir's filesystem; null when not observable. Other processes affect it. */
export async function freeSpace(dir: string): Promise<number | null> {
  try { const s = await statfs(absolute(dir), { bigint: true }); return Number(s.bavail * s.bsize); }
  catch { return null; }
}

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AfoError, FileSchema, ProfileSchema, ReferenceScanSchema, RelativePathSchema, ScanSchema, incompleteSkipCodes }
  from '../../contracts/src/index.js';
import type { FileSnapshot, Preview, ProtectedEntry, ReferenceGrant, ReferenceScan, RootGrant, ScanProgress, ScanResult,
  SkipCode, SkippedEntry } from '../../contracts/src/index.js';
import { buildPreview, digest, extensionOf, pathKey, suggestProfile } from '../../engine/src/index.js';
import { bundlePattern, issueReferenceGrant, issueRootGrant, projectMarkers, verifyGrant, within } from './grants.js';

export { currentSessionId, issueReferenceGrant, issueRootGrant, revokeGrant, verifyGrant } from './grants.js';

export interface ScanOptions {
  signal?: AbortSignal; maxFiles?: number; maxDepth?: number;
  /** Called synchronously after each folder listing and about every MiB hashed. */
  onProgress?: (progress: ScanProgress) => void;
  /** 'throw' (default): AbortError. 'partial': return what was read so far with cancelled: true, complete: false. */
  onAbort?: 'throw' | 'partial';
  /** Files hashed at once (default 4, 1–16). Folder walking is sequential so results stay deterministic. */
  hashConcurrency?: number;
  /** When set, grants of any other session are refused (the shared service passes its session). */
  sessionId?: string;
}
const devNames = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', 'target', 'Pods', 'DerivedData']);
const systemNames = new Set(['$RECYCLE.BIN', 'System Volume Information', 'Thumbs.db', 'desktop.ini', '$Recycle.Bin']);
const session = (options: ScanOptions): { sessionId?: string } => options.sessionId === undefined ? {} : { sessionId: options.sessionId };
const PROGRESS_STEP = 1024 * 1024;
const CHUNK = 64 * 1024;

const fsCode = (error: unknown): string => {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z0-9_]{1,32}$/u.test(code) ? code : 'READ_FAILED';
};
const aborted = (): AfoError => { const error = new AfoError('CANCELLED', '분석을 취소했습니다.'); error.name = 'AbortError'; return error; };
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';
const checkAbort = (signal?: AbortSignal): void => { if (signal?.aborted) throw aborted(); };
class Skip extends Error { constructor(readonly code: SkipCode, message: string) { super(message); } }

function limits(options: ScanOptions): { maxFiles: number; maxDepth: number; hashConcurrency: number } {
  const maxFiles = options.maxFiles ?? 10_000; const maxDepth = options.maxDepth ?? 32;
  const hashConcurrency = options.hashConcurrency ?? 4;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 ||
      !Number.isSafeInteger(hashConcurrency) || hashConcurrency < 1 || hashConcurrency > 16)
    throw new Error('스캔 한도(파일 수·깊이·해시 동시성)가 유효하지 않습니다.');
  if (options.onAbort !== undefined && options.onAbort !== 'throw' && options.onAbort !== 'partial')
    throw new Error('취소 처리 방식이 유효하지 않습니다.');
  return { maxFiles, maxDepth, hashConcurrency };
}

/**
 * macOS only: a non-empty file with no allocated blocks has no local content (iCloud "dataless" file) or is sparse.
 * Node exposes neither st_flags (SF_DATALESS) nor Windows cloud reparse tags, so this is a conservative heuristic:
 * transparently compressed files may also match and are excluded too. Windows/Linux: not detected (small files can be
 * resident in the NTFS MFT or ext4 inode with 0 blocks), so allocation is reported as unknown there.
 */
const allocation = (stat: BigIntStats): number | null =>
  process.platform === 'win32' || typeof stat.blocks !== 'bigint' ? null : Number(stat.blocks * 512n);
const maybeCloudOnly = (stat: BigIntStats): boolean => process.platform === 'darwin' && stat.size > 0n && stat.blocks === 0n;

interface Counters { directories: number; files: number; skipped: number; hashedFiles: number; hashTargets: number;
  bytesHashed: number; bytesToHash: number }
const emit = (options: ScanOptions, phase: ScanProgress['phase'], c: Counters): void => options.onProgress?.({ phase, ...c });
const counters = (): Counters => ({ directories: 0, files: 0, skipped: 0, hashedFiles: 0, hashTargets: 0, bytesHashed: 0, bytesToHash: 0 });

interface Walk { directories: string[]; skipped: SkippedEntry[]; complete: boolean; cancelled: boolean }
/** Sequential, sorted, link-free walk inside a verified root. Never opens files. */
async function walk(root: string, mode: 'scan' | 'reference', options: ScanOptions,
  onFile: (rel: string, stat: BigIntStats) => void): Promise<Walk> {
  const { maxFiles, maxDepth } = limits(options);
  const rootStat = await lstat(root, { bigint: true });
  const result: Walk = { directories: [], skipped: [], complete: true, cancelled: false };
  const count = counters(); const visited = new Set<string>();
  let stopped = false;
  const skip = (relativePath: string, code: SkipCode, reason: string, detail?: string): void => {
    result.skipped.push({ relativePath, reason, code, ...(detail ? { detail } : {}) });
    if (incompleteSkipCodes.includes(code)) result.complete = false;
    count.skipped++;
  };
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    checkAbort(options.signal);
    const stat = await lstat(directory, { bigint: true });
    const actual = await realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, actual)) throw new Skip('OUTSIDE_ROOT', '폴더 경계 또는 종류가 변경되었습니다.');
    const identity = `${stat.dev}:${stat.ino}`;
    if (visited.has(identity)) throw new Skip('LINK', '반복된 폴더 식별자입니다.');
    visited.add(identity);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    count.directories++;
    emit(options, mode, count);
    if (relative !== '' && entries.some((e) => projectMarkers.has(e.name) || /\.xcodeproj$/iu.test(e.name))) {
      skip(relative, 'DEV_PROJECT', '개발 프로젝트 폴더'); return;
    }
    for (const entry of entries) {
      checkAbort(options.signal);
      if (stopped) return;
      if (count.files >= maxFiles) { stopped = true; skip(relative || '.', 'COUNT_LIMIT', '파일 개수 한도 도달'); return; }
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.name.startsWith('.')) { skip(rel, 'HIDDEN', '숨김 항목'); continue; }
      if (systemNames.has(entry.name)) { skip(rel, 'SYSTEM_PATH', '운영체제 관리 항목'); continue; }
      if (devNames.has(entry.name)) { skip(rel, 'DEV_PROJECT', '개발 도구·빌드 폴더'); continue; }
      if (bundlePattern.test(entry.name)) { skip(rel, 'APP_BUNDLE', '앱·라이브러리 묶음'); continue; }
      if (!RelativePathSchema.safeParse(rel).success) { skip(rel, 'UNSUPPORTED_NAME', '운영체제 간 지원하지 않는 이름'); continue; }
      try {
        const childStat = await lstat(child, { bigint: true });
        if (childStat.isSymbolicLink()) { skip(rel, 'LINK', '링크 또는 junction'); continue; }
        if (!within(root, await realpath(child))) throw new Skip('OUTSIDE_ROOT', '루트 밖의 실제 경로');
        if (childStat.isDirectory()) {
          if (childStat.dev !== rootStat.dev) { skip(rel, 'OTHER_VOLUME', '다른 볼륨의 폴더'); continue; }
          result.directories.push(rel);
          if (depth >= maxDepth) skip(rel, 'DEPTH_LIMIT', '탐색 깊이 한도 도달');
          else await visit(child, rel, depth + 1);
        } else if (childStat.isFile()) {
          if (childStat.nlink !== 1n) skip(rel, 'HARDLINK', '하드링크(같은 파일의 다른 이름)');
          else if (childStat.size > BigInt(Number.MAX_SAFE_INTEGER)) skip(rel, 'TOO_LARGE', '크기를 다룰 수 없는 파일');
          else if (mode === 'scan' && maybeCloudOnly(childStat)) skip(rel, 'CLOUD_PLACEHOLDER', '클라우드 전용 또는 희소 파일 가능성');
          else { onFile(rel, childStat); count.files++; }
        } else skip(rel, 'NOT_REGULAR', '일반 파일이 아닌 항목');
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof Skip) skip(rel, error.code, error.message);
        else { const code = fsCode(error); skip(rel, 'READ_FAILED', `읽기 실패: ${code}`, code); }
      }
    }
  }
  try { await visit(root, '', 0); }
  catch (error) {
    if (!isAbort(error) || options.onAbort !== 'partial') throw error;
    result.cancelled = true; result.complete = false;
  }
  return result;
}

/** Scans a work root granted by this process. Records metadata only; sha256 stays null until hashCandidates. */
export async function scanRoot(grantInput: RootGrant, options: ScanOptions = {}): Promise<ScanResult> {
  checkAbort(options.signal); limits(options);
  const grant = await verifyGrant(grantInput, 'work', session(options));
  const root = { id: digest(grant.canonicalPath), canonicalPath: grant.canonicalPath, readOnly: true as const };
  const files: FileSnapshot[] = [];
  const walked = await walk(grant.canonicalPath, 'scan', options, (rel, stat) => {
    files.push(FileSchema.parse({ id: digest(`${root.id}:${rel}:${stat.ino}`), relativePath: rel, size: Number(stat.size),
      modifiedNs: String(stat.mtimeNs), device: String(stat.dev), inode: String(stat.ino), sha256: null,
      allocatedBytes: allocation(stat) }));
  });
  await verifyGrant(grant, 'work', session(options)); // the root was not swapped while walking
  return ScanSchema.parse({ root, files, directories: walked.directories, skipped: walked.skipped, complete: walked.complete,
    ...(walked.cancelled ? { cancelled: true } : {}) });
}

/** Reference folder: structure, names and extensions only. No sizes, identities, file opens or hashes. */
export async function readReference(grantInput: ReferenceGrant, options: ScanOptions = {}): Promise<ReferenceScan> {
  checkAbort(options.signal); limits(options);
  const grant = await verifyGrant(grantInput, 'reference', session(options));
  const files: ReferenceScan['files'] = [];
  const walked = await walk(grant.canonicalPath, 'reference', options, (rel) => {
    const ext = extensionOf(rel);
    files.push({ relativePath: rel, extension: /^\.[^./]{1,32}$/u.test(ext) ? ext : null });
  });
  await verifyGrant(grant, 'reference', session(options));
  return ReferenceScanSchema.parse({ formatVersion: 1, mode: 'reference-metadata', grantId: grant.id,
    root: { id: digest(grant.canonicalPath), canonicalPath: grant.canonicalPath, readOnly: true }, files,
    directories: walked.directories, skipped: walked.skipped, complete: walked.complete,
    ...(walked.cancelled ? { cancelled: true } : {}) });
}

const sameFile = (stat: BigIntStats, file: FileSnapshot): boolean => stat.isFile() && !stat.isSymbolicLink() &&
  stat.nlink === 1n && String(stat.dev) === file.device && String(stat.ino) === file.inode &&
  stat.size === BigInt(file.size) && String(stat.mtimeNs) === file.modifiedNs;
const changed = (): AfoError => new AfoError('FILE_CHANGED', '분석 중 파일이 바뀌었습니다.');

/** Streams one file in 64 KiB chunks; identity is checked before, during (size) and after reading. */
async function hashSnapshot(root: string, file: FileSnapshot, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<string> {
  checkAbort(signal);
  const child = path.join(root, ...file.relativePath.split('/'));
  if (!within(root, await realpath(child))) throw new AfoError('PATH_OUTSIDE_ROOT', '루트 밖의 실제 경로');
  if (!sameFile(await lstat(child, { bigint: true }), file)) throw changed();
  const handle = await open(child, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(await handle.stat({ bigint: true }), file)) throw changed();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    let total = 0;
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead)); total += bytesRead;
      if (total > file.size) throw changed();
      onBytes(bytesRead);
    }
    if (total !== file.size || !sameFile(await handle.stat({ bigint: true }), file) ||
        !sameFile(await lstat(child, { bigint: true }), file) || !within(root, await realpath(child))) throw changed();
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/**
 * Hashes only files that share a size with another eligible file (empty and excluded files never).
 * Bounded concurrency; a changed or unreadable file is skipped alone and marks the result incomplete.
 * Returns a new ScanResult; the input is not modified. Every started read has finished when this settles.
 */
export async function hashCandidates(grantInput: RootGrant, input: ScanResult,
  options: ScanOptions & { exclude?: Iterable<string> } = {}): Promise<ScanResult> {
  const { hashConcurrency } = limits(options);
  const grant = await verifyGrant(grantInput, 'work', session(options));
  const scan = ScanSchema.parse(input);
  if (scan.root.canonicalPath !== grant.canonicalPath) throw new AfoError('ROOT_FORBIDDEN', '스캔 결과와 폴더 권한이 다릅니다.');
  const excluded = new Set([...(options.exclude ?? [])].map(pathKey));
  const eligible = scan.files.filter((f) => f.size > 0 && f.sha256 === null && !excluded.has(pathKey(f.relativePath)));
  const sizes = new Map<number, number>();
  for (const f of eligible) sizes.set(f.size, (sizes.get(f.size) ?? 0) + 1);
  const targets = eligible.filter((f) => (sizes.get(f.size) ?? 0) > 1)
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const count = counters();
  count.files = scan.files.length; count.directories = scan.directories.length; count.skipped = scan.skipped.length;
  count.hashTargets = targets.length; count.bytesToHash = targets.reduce((sum, f) => sum + f.size, 0);
  const hashes = new Map<string, string>(); const failures: SkippedEntry[] = [];
  let next = 0; let cancelled = false; let sinceEmit = 0;
  emit(options, 'hash', count);
  async function worker(): Promise<void> {
    while (!cancelled && next < targets.length) {
      const file = targets[next++]!;
      try {
        hashes.set(file.relativePath, await hashSnapshot(grant.canonicalPath, file, options.signal, (n) => {
          count.bytesHashed += n; sinceEmit += n;
          if (sinceEmit >= PROGRESS_STEP) { sinceEmit = 0; emit(options, 'hash', count); }
        }));
      } catch (error) {
        if (isAbort(error)) { cancelled = true; return; }
        const fileChanged = error instanceof AfoError && error.code === 'FILE_CHANGED';
        const code = fileChanged ? 'FILE_CHANGED' : error instanceof AfoError ? error.code : fsCode(error);
        failures.push({ relativePath: file.relativePath, reason: `해시 실패: ${code}`,
          code: fileChanged ? 'FILE_CHANGED' : 'HASH_FAILED', ...(fileChanged ? {} : { detail: code }) });
      }
      count.hashedFiles++; emit(options, 'hash', count);
    }
  }
  await Promise.all(Array.from({ length: Math.min(hashConcurrency, targets.length) }, () => worker()));
  if (cancelled && options.onAbort !== 'partial') throw aborted();
  await verifyGrant(grant, 'work', session(options));
  failures.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  return ScanSchema.parse({ ...scan, files: scan.files.map((f) => ({ ...f, sha256: hashes.get(f.relativePath) ?? f.sha256 })),
    skipped: [...scan.skipped, ...failures], complete: scan.complete && failures.length === 0 && !cancelled,
    ...(cancelled || scan.cancelled ? { cancelled: true } : {}) });
}

/**
 * Reference files that lie inside the work root (either root may contain the other). They are kept as-is,
 * never hashed, moved or deleted. Fails closed when a path cannot be expressed relative to the work root.
 */
export function protectedReferencePaths(workRoot: string, sources: { root: string; files: string[] }[]): ProtectedEntry[] {
  const found = new Map<string, string>();
  for (const source of sources) {
    if (!path.isAbsolute(source.root)) throw new Error('현재 OS의 절대 참고 경로가 필요합니다.');
    for (const rel of source.files) {
      const absolute = path.join(source.root, ...RelativePathSchema.parse(rel).split('/'));
      if (!within(workRoot, absolute)) continue;
      const local = path.relative(workRoot, absolute).split(path.sep).join('/');
      if (local === '') continue;
      if (!RelativePathSchema.safeParse(local).success) throw new Error('참고 파일 위치를 작업 폴더 기준으로 확인할 수 없습니다.');
      found.set(pathKey(local), local);
    }
  }
  return [...found.values()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    .map((relativePath) => ({ relativePath, code: 'REFERENCE_FILE' as const, reason: '참고한 기존 파일이라 이동·삭제하지 않습니다.' }));
}

export interface AnalyzeOptions extends ScanOptions { profile?: unknown; reference?: ReferenceGrant }
export interface Analysis { preview: Preview; suggestedProfile: ReturnType<typeof suggestProfile> | null;
  reference: ReferenceScan | null; protected: ProtectedEntry[] }

/** scan → reference metadata → hash size candidates (protected excluded) → preview. No filesystem writes. */
export async function analyzeRoot(grant: RootGrant, options: AnalyzeOptions = {}): Promise<Analysis> {
  const scan = await scanRoot(grant, options);
  const profile = options.profile === undefined ? undefined : ProfileSchema.parse(options.profile);
  const reference = options.reference ? await readReference(options.reference, options) : null;
  if (reference?.cancelled) throw aborted();
  if (reference && !reference.complete) throw new Error('참고 폴더 스캔이 완료되지 않았습니다.');
  const sources = [...(reference ? [{ root: reference.root.canonicalPath, files: reference.files.map((f) => f.relativePath) }] : []),
    ...(profile ? [{ root: profile.referenceRoot.canonicalPath, files: profile.referenceFiles }] : [])];
  const protectedEntries = protectedReferencePaths(scan.root.canonicalPath, sources);
  const protectedPaths = protectedEntries.map((p) => p.relativePath);
  const hashed = scan.cancelled ? scan : await hashCandidates(grant, scan, { ...options, exclude: protectedPaths });
  return { preview: buildPreview(hashed, profile ? { profile, protectedPaths } : { protectedPaths }),
    suggestedProfile: reference ? suggestProfile(reference) : null, reference, protected: protectedEntries };
}

/** Compatibility entry: issues a work grant for `input` in this process and scans it. */
export async function scanFolder(input: string, options: ScanOptions = {}): Promise<ScanResult> {
  checkAbort(options.signal); limits(options);
  return scanRoot(await issueRootGrant(input), options);
}

/** Compatibility entry used by the read-only CLI. Same result shape as before: { preview, suggestedProfile }. */
export async function analyzeFolder(input: string, options: ScanOptions & { profile?: unknown; reference?: string } = {}): Promise<{
  preview: Preview; suggestedProfile: ReturnType<typeof suggestProfile> | null;
}> {
  checkAbort(options.signal); limits(options);
  const { reference, ...rest } = options;
  const grant = await issueRootGrant(input);
  const referenceGrant = reference ? await issueReferenceGrant(reference) : undefined;
  const { preview, suggestedProfile } = await analyzeRoot(grant, { ...rest, ...(referenceGrant ? { reference: referenceGrant } : {}) });
  return { preview, suggestedProfile };
}

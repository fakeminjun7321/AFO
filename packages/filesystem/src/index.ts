import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileSchema, ProfileSchema, RelativePathSchema, ScanSchema } from '../../contracts/src/index.js';
import type { FileSnapshot, Preview, ScanResult } from '../../contracts/src/index.js';
import { buildPreview, digest, pathKey, suggestProfile } from '../../engine/src/index.js';

export interface ScanOptions { signal?: AbortSignal; maxFiles?: number; maxDepth?: number }
const projectMarkers = new Set(['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'Package.swift']);
const excludedNames = new Set(['node_modules', '__pycache__', 'venv', 'dist', 'build', '$RECYCLE.BIN', 'System Volume Information']);
const bundle = /\.(?:app|framework|bundle|xcodeproj|xcworkspace|photoslibrary|photolibrary)$/iu;
const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) { const error = new Error('분석을 취소했습니다.'); error.name = 'AbortError'; throw error; }
};
const sameFile = (stat: BigIntStats, file: FileSnapshot): boolean => stat.isFile() && !stat.isSymbolicLink() &&
  stat.nlink === 1n && String(stat.dev) === file.device && String(stat.ino) === file.inode &&
  stat.size === BigInt(file.size) && String(stat.mtimeNs) === file.modifiedNs;
const within = (root: string, child: string): boolean => {
  const rel = path.relative(root, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
const errorCode = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error
  ? String(error.code) : 'READ_FAILED';

export async function scanFolder(input: string, options: ScanOptions = {}): Promise<ScanResult> {
  checkAbort(options.signal);
  const maxFiles = options.maxFiles ?? 10_000;
  const maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128)
    throw new Error('스캔 한도가 유효하지 않습니다.');
  const initial = await lstat(path.resolve(input), { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('일반 폴더를 직접 선택해야 합니다.');
  const canonicalPath = await realpath(input);
  const forbidden = process.platform === 'win32'
    ? [process.env['WINDIR'] ?? 'C:\\Windows', process.env['ProgramFiles'] ?? 'C:\\Program Files']
    : ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc'];
  if (canonicalPath === path.parse(canonicalPath).root ||
      pathKey(canonicalPath) === pathKey(await realpath(homedir())) ||
      forbidden.some((dir) => within(path.resolve(dir), canonicalPath)))
    throw new Error('홈 전체, 디스크 루트와 시스템 폴더는 분석 대상이 아닙니다.');
  const result: ScanResult = { root: { id: digest(canonicalPath), canonicalPath, readOnly: true },
    files: [], directories: [], skipped: [], complete: true };
  const visited = new Set<string>();
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    checkAbort(options.signal);
    const stat = await lstat(directory, { bigint: true });
    const actual = await realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(canonicalPath, actual))
      throw new Error('폴더 경계 또는 종류가 변경되었습니다.');
    const identity = `${stat.dev}:${stat.ino}`;
    if (visited.has(identity)) throw new Error('반복된 폴더 식별자입니다.');
    visited.add(identity);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (entries.some((entry) => projectMarkers.has(entry.name) || /\.xcodeproj$/iu.test(entry.name))) {
      if (relative === '') throw new Error('개발 프로젝트 내부는 분석하지 않습니다.');
      result.skipped.push({ relativePath: relative, reason: '개발 프로젝트 폴더' });
      return;
    }
    for (const entry of entries) {
      checkAbort(options.signal);
      if (result.files.length >= maxFiles) {
        result.complete = false;
        result.skipped.push({ relativePath: relative || '.', reason: '파일 개수 한도 도달' });
        return;
      }
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.name.startsWith('.') || excludedNames.has(entry.name) || bundle.test(entry.name)) {
        result.skipped.push({ relativePath: rel, reason: '숨김·앱·제외 경로' }); continue;
      }
      if (!RelativePathSchema.safeParse(rel).success) {
        result.skipped.push({ relativePath: rel, reason: '운영체제 간 지원하지 않는 이름' }); continue;
      }
      try {
        const childStat = await lstat(child, { bigint: true });
        if (childStat.isSymbolicLink()) { result.skipped.push({ relativePath: rel, reason: '링크 또는 junction' }); continue; }
        if (!within(canonicalPath, await realpath(child))) throw new Error('루트 밖의 실제 경로');
        if (childStat.isDirectory()) {
          result.directories.push(rel);
          if (depth >= maxDepth) {
            result.complete = false;
            result.skipped.push({ relativePath: rel, reason: '탐색 깊이 한도 도달' });
          } else await visit(child, rel, depth + 1);
        } else if (childStat.isFile() && childStat.nlink === 1n && childStat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
          result.files.push(FileSchema.parse({ id: digest(`${result.root.id}:${rel}:${childStat.ino}`),
            relativePath: rel, size: Number(childStat.size), modifiedNs: String(childStat.mtimeNs),
            device: String(childStat.dev), inode: String(childStat.ino), sha256: null }));
        } else result.skipped.push({ relativePath: rel, reason: '하드링크 또는 일반 파일이 아닌 항목' });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        result.complete = false;
        result.skipped.push({ relativePath: rel, reason: `읽기 실패: ${errorCode(error)}` });
      }
    }
  }
  await visit(canonicalPath, '', 0);
  return ScanSchema.parse(result);
}

async function hashSnapshot(scan: ScanResult, file: FileSnapshot, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const child = path.join(scan.root.canonicalPath, ...file.relativePath.split('/'));
  if (!within(scan.root.canonicalPath, await realpath(child))) throw new Error('루트 밖의 실제 경로');
  if (!sameFile(await lstat(child, { bigint: true }), file)) throw new Error('FILE_CHANGED');
  const handle = await open(child, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(await handle.stat({ bigint: true }), file)) throw new Error('FILE_CHANGED');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead)); total += bytesRead;
      if (total > file.size) throw new Error('FILE_CHANGED');
    }
    if (total !== file.size || !sameFile(await handle.stat({ bigint: true }), file) ||
        !sameFile(await lstat(child, { bigint: true }), file) ||
        !within(scan.root.canonicalPath, await realpath(child))) throw new Error('FILE_CHANGED');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** Hash only equal-sized candidates. No source filesystem writes, including profile writes. */
export async function analyzeFolder(input: string, options: ScanOptions & { profile?: unknown; reference?: string } = {}): Promise<{
  preview: Preview; suggestedProfile: ReturnType<typeof suggestProfile> | null;
}> {
  const scan = await scanFolder(input, options);
  const profile = options.profile === undefined ? undefined : ProfileSchema.parse(options.profile);
  let reference = options.reference ? await scanFolder(options.reference, options) : undefined;
  if (reference && !reference.complete) throw new Error('참고 폴더 스캔이 완료되지 않았습니다.');
  const protectedPaths: string[] = [];
  const sources = [reference && { root: reference.root, files: reference.files.map((f) => f.relativePath) },
    profile && { root: profile.referenceRoot, files: profile.referenceFiles }];
  for (const source of sources) if (source) {
    if (!path.isAbsolute(source.root.canonicalPath)) throw new Error('현재 OS의 절대 참고 경로가 필요합니다.');
    for (const rel of source.files) {
      const absolute = path.join(source.root.canonicalPath, ...rel.split('/'));
      if (within(scan.root.canonicalPath, absolute)) {
        const local = path.relative(scan.root.canonicalPath, absolute).split(path.sep).join('/');
        if (local) protectedPaths.push(local);
      }
    }
  }
  const protectedKeys = new Set(protectedPaths.map(pathKey));
  const eligible = scan.files.filter((file) => !protectedKeys.has(pathKey(file.relativePath)));
  const sizes = new Map<number, number>();
  for (const file of eligible) sizes.set(file.size, (sizes.get(file.size) ?? 0) + 1);
  for (const file of eligible) if ((sizes.get(file.size) ?? 0) > 1) {
    try { file.sha256 = await hashSnapshot(scan, file, options.signal); }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      scan.complete = false;
      scan.skipped.push({ relativePath: file.relativePath, reason: `해시 실패: ${errorCode(error)}` });
    }
  }
  const previewOptions = profile ? { profile, protectedPaths } : { protectedPaths };
  return { preview: buildPreview(scan, previewOptions), suggestedProfile: reference ? suggestProfile(reference) : null };
}

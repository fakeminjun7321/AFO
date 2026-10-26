import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProfileSchema, PreviewSchema, RelativePathSchema, ScanSchema } from '../../contracts/src/index.js';
import type { Preview, PreviewItem, Rule, RuleProfile, ScanResult } from '../../contracts/src/index.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const pathKey = (value: string): string => value.normalize('NFC').toLowerCase();
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const extensionOf = (name: string): string => path.posix.extname(name).toLowerCase();
const categoryExtensions: Record<string, string[]> = {
  '문서': ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'txt', 'md', 'odt', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'],
  '이미지': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'tif', 'tiff'],
  '영상': ['mp4', 'mov', 'mkv', 'avi', 'webm'], '음악': ['mp3', 'wav', 'flac', 'm4a', 'ogg'],
  '압축': ['zip', '7z', 'rar', 'tar', 'gz'], '설치': ['dmg', 'pkg', 'exe', 'msi'],
};

/** Metadata-only proposals. Two examples are a conservative initial heuristic, not measured accuracy. */
export function suggestProfile(input: unknown): RuleProfile {
  const scan = ScanSchema.parse(input);
  if (!scan.complete) throw new Error('완료되지 않은 참고 스캔에서 규칙을 만들 수 없습니다.');
  const groups = new Map<string, string[]>();
  for (const file of scan.files) {
    const dir = path.posix.dirname(file.relativePath);
    const ext = extensionOf(file.relativePath);
    if (dir === '.' || !/^\.[a-z0-9]{1,16}$/u.test(ext)) continue;
    const key = JSON.stringify([ext, dir]);
    groups.set(key, [...(groups.get(key) ?? []), file.relativePath]);
  }
  const rules: Rule[] = [];
  for (const [key, evidence] of [...groups].sort(([a], [b]) => compare(a, b))) {
    if (evidence.length < 2) continue;
    const [extension, targetDirectory] = JSON.parse(key) as [string, string];
    const allDirectories = [...groups.keys()].map((k) => JSON.parse(k) as [string, string])
      .filter(([ext]) => ext === extension);
    let keyword: string | null = null;
    if (allDirectories.length > 1) {
      const leaf = path.posix.basename(targetDirectory).normalize('NFC');
      // Ambiguous extensions only yield a rule when filenames support the folder label.
      if (leaf.length < 2 || /^\d+$/u.test(leaf) ||
          !evidence.every((p) => pathKey(path.posix.basename(p)).includes(pathKey(leaf)))) continue;
      keyword = leaf;
    }
    const rule = { id: digest(key + String(keyword)).slice(0, 16), extension, keyword,
      targetDirectory, evidence: evidence.sort(compare) };
    rules.push(rule);
  }
  const referenceFiles = scan.files.map((f) => f.relativePath).sort(compare);
  return ProfileSchema.parse({ formatVersion: 1, id: digest(JSON.stringify([scan.root.id, rules])),
    revision: 1, status: 'draft', referenceRoot: scan.root, referenceFiles, rules });
}

/** Explicit caller choice, for preview rules only. This never authorizes filesystem execution. */
export function confirmProfile(input: unknown, selectedIds: string[]): RuleProfile {
  const profile = ProfileSchema.parse(input);
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length ||
      selectedIds.some((id) => !profile.rules.some((r) => r.id === id)))
    throw new Error('확인할 규칙 ID를 중복 없이 명시해야 합니다.');
  return ProfileSchema.parse({ ...profile, revision: profile.revision + 1, status: 'confirmed',
    rules: profile.rules.filter((r) => selectedIds.includes(r.id)) });
}

export function buildPreview(input: unknown, options: {
  profile?: unknown; protectedPaths?: string[]; overrides?: Record<string, string>;
} = {}): Preview {
  const scan = ScanSchema.parse(input);
  const profile = options.profile === undefined ? undefined : ProfileSchema.parse(options.profile);
  const protectedPaths = new Set((options.protectedPaths ?? []).map((p) => pathKey(RelativePathSchema.parse(p))));
  const inventory = new Map<string, 'file' | 'directory' | 'blocked'>();
  for (const f of scan.files) inventory.set(pathKey(f.relativePath), 'file');
  for (const dir of scan.directories) inventory.set(pathKey(dir), 'directory');
  for (const entry of scan.skipped) inventory.set(pathKey(entry.relativePath), 'blocked');
  const items: PreviewItem[] = scan.files.map((file) => {
    const base = { fileId: file.id, source: file.relativePath, destination: null, ruleId: null };
    if (protectedPaths.has(pathKey(file.relativePath)))
      return { ...base, action: 'keep', reason: '참고한 기존 파일을 보존합니다.' };
    if (scan.skipped.some((entry) => entry.relativePath === file.relativePath))
      return { ...base, action: 'review', reason: '읽기 또는 내용 검증에 실패한 파일입니다.' };
    const ext = extensionOf(file.relativePath);
    let targetDirectory: string | undefined;
    let ruleId: string | null = null;
    let reason = '확장자에 따른 기본 분류입니다.';
    if (options.overrides?.[file.id] !== undefined) {
      targetDirectory = RelativePathSchema.parse(options.overrides[file.id]);
      reason = '사용자가 명시적으로 지정한 이번 분류입니다.';
    } else if (profile?.status === 'confirmed') {
      const matches = profile.rules.filter((r) => r.extension === ext &&
        (r.keyword === null || pathKey(path.posix.basename(file.relativePath)).includes(pathKey(r.keyword))));
      const destinations = new Set(matches.map((r) => pathKey(r.targetDirectory)));
      if (destinations.size > 1) return { ...base, action: 'review', reason: '개인 규칙의 목적지가 충돌합니다.' };
      const rule = matches[0];
      if (rule) { targetDirectory = rule.targetDirectory; ruleId = rule.id; reason = '확인한 개인 규칙을 적용합니다.'; }
    }
    if (!targetDirectory) targetDirectory = Object.entries(categoryExtensions).find(([, exts]) => exts.includes(ext.slice(1)))?.[0];
    if (!targetDirectory) return { ...base, action: 'review', reason: '분류 기준이 불분명합니다.' };
    const destination = `${targetDirectory}/${path.posix.basename(file.relativePath)}`;
    RelativePathSchema.parse(destination);
    if (pathKey(destination) === pathKey(file.relativePath))
      return { ...base, action: 'keep', destination, ruleId, reason: '이미 지정한 위치에 있습니다.' };
    const parents = targetDirectory.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'));
    if (inventory.has(pathKey(destination)) || parents.some((p) => {
      const kind = inventory.get(pathKey(p)); return kind !== undefined && kind !== 'directory';
    })) return { ...base, action: 'review', reason: '목적지의 기존 파일 또는 제외 경로와 충돌합니다.' };
    return { ...base, action: 'move', destination, ruleId, reason };
  });
  const proposals = new Map<string, PreviewItem[]>();
  for (const item of items) if (item.action === 'move' && item.destination) {
    const key = pathKey(item.destination);
    proposals.set(key, [...(proposals.get(key) ?? []), item]);
  }
  for (const collisions of proposals.values()) if (collisions.length > 1) for (const item of collisions) {
    item.action = 'review'; item.destination = null; item.reason = '여러 파일의 목적지가 같습니다. 덮어쓰지 않습니다.';
  }
  for (const item of items) if (item.action === 'move' && item.destination) {
    const parts = item.destination.split('/');
    const parentTargets = parts.slice(0, -1).flatMap((_, i) =>
      proposals.get(pathKey(parts.slice(0, i + 1).join('/'))) ?? []);
    if (parentTargets.length) for (const conflict of [item, ...parentTargets]) {
      conflict.action = 'review'; conflict.destination = null;
      conflict.reason = '예정된 파일 위치와 폴더 위치가 충돌합니다.';
    }
  }
  const hashes = new Map<string, typeof scan.files>();
  for (const file of scan.files) if (file.sha256 !== null) {
    const key = `${file.size}:${file.sha256}`;
    hashes.set(key, [...(hashes.get(key) ?? []), file]);
  }
  const duplicates = [...hashes.values()].filter((files) => files.length > 1).map((files) => {
    files.sort((a, b) => Number(protectedPaths.has(pathKey(b.relativePath))) - Number(protectedPaths.has(pathKey(a.relativePath))) || compare(a.relativePath, b.relativePath));
    const keep = files[0]!;
    const candidates = files.slice(1).filter((f) => !protectedPaths.has(pathKey(f.relativePath)));
    return { sha256: keep.sha256!, suggestedKeep: keep.relativePath,
      candidates: candidates.map((f) => f.relativePath), logicalCandidateBytes: candidates.reduce((sum, f) => sum + f.size, 0) };
  }).filter((g) => g.candidates.length > 0);
  const id = digest(JSON.stringify({ scan, profile, protectedPaths: [...protectedPaths].sort(compare), overrides: options.overrides ?? {} }));
  return PreviewSchema.parse({ formatVersion: 1, mode: 'preview-only', id, root: scan.root,
    profileRevision: profile?.status === 'confirmed' ? profile.revision : null, items, duplicates,
    largeFiles: scan.files.filter((f) => f.size >= 100 * 1024 * 1024 && !protectedPaths.has(pathKey(f.relativePath))).map((f) => f.relativePath),
    skipped: scan.skipped, scanComplete: scan.complete, executionAvailable: false });
}

import path from 'node:path';
import { CLASSIFICATION_VERSION, ProfileSchema, PreviewSchema, ReferenceScanSchema, RelativePathSchema, ScanSchema }
  from '../../contracts/src/index.js';
import type { Preview, PreviewItem, Rule, RuleProfile } from '../../contracts/src/index.js';
import { classifyFile, extensionOf } from './classify.js';
import { findDuplicates, spaceEstimate } from './duplicates.js';
import { activeRules, parseProfile } from './rules.js';
import { compare, digest, pathKey } from './util.js';

export { digest, pathKey } from './util.js';
export { CLASSIFICATION_VERSION, categoryExtensions, classifyFile, extensionOf } from './classify.js';
export type { Classification } from './classify.js';
export { SPACE_NOTE, chooseKeeper, findDuplicates, spaceEstimate } from './duplicates.js';
export { activeRules, classifyPersonal, emptyProfile, makeCorrection, parseProfile, profileFromV1, withCorrection, withRuleEnabled,
  withStatus, withoutCorrection } from './rules.js';
export type { AnyProfile } from './rules.js';
export { approvalChoices, approvalCode, buildPlan, canonicalJson, diffPlans, planHash, selectOperations } from './plan.js';
export type { BuildPlanOptions, DeleteSelection, PlanDiff } from './plan.js';
/** Informational only: size or age is never a reason to delete. */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;

/** Accepts a work ScanResult or a metadata-only ReferenceScan; only paths are used. */
function referenceInput(input: unknown): { root: RuleProfile['referenceRoot']; files: { relativePath: string }[]; complete: boolean } {
  const reference = ReferenceScanSchema.safeParse(input);
  return reference.success ? reference.data : ScanSchema.parse(input);
}

/** Metadata-only proposals. Two examples are a conservative initial heuristic, not measured accuracy. */
export function suggestProfile(input: unknown): RuleProfile {
  const scan = referenceInput(input);
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
  const profile = options.profile === undefined ? undefined : parseProfile(options.profile);
  const active = profile ? activeRules(profile) : null;
  const protectedPaths = new Set((options.protectedPaths ?? []).map((p) => pathKey(RelativePathSchema.parse(p))));
  const inventory = new Map<string, 'file' | 'directory' | 'blocked'>();
  for (const f of scan.files) inventory.set(pathKey(f.relativePath), 'file');
  for (const dir of scan.directories) inventory.set(pathKey(dir), 'directory');
  for (const entry of scan.skipped) inventory.set(pathKey(entry.relativePath), 'blocked');
  const items: PreviewItem[] = scan.files.map((file) => {
    const base = { fileId: file.id, source: file.relativePath, destination: null, ruleId: null, category: null };
    if (protectedPaths.has(pathKey(file.relativePath)))
      return { ...base, action: 'keep', reason: '참고한 기존 파일을 보존합니다.', reasonCode: 'PROTECTED_REFERENCE' };
    if (scan.skipped.some((entry) => entry.relativePath === file.relativePath))
      return { ...base, action: 'review', reason: '읽기 또는 내용 검증에 실패한 파일입니다.', reasonCode: 'READ_FAILED' };
    const override = options.overrides?.[file.id];
    const c = classifyFile(file.relativePath, { ...(profile ? { profile } : {}), ...(override !== undefined ? { override } : {}) });
    const { targetDirectory, ruleId, reason, reasonCode, category } = c;
    if (targetDirectory === null) return { ...base, action: 'review', reason, reasonCode };
    const destination = `${targetDirectory}/${path.posix.basename(file.relativePath)}`;
    if (!RelativePathSchema.safeParse(destination).success)
      return { ...base, action: 'review', reason: '목적지 경로를 만들 수 없습니다(길이·이름 제한).', reasonCode: 'DEST_INVALID' };
    if (pathKey(destination) === pathKey(file.relativePath))
      return { ...base, action: 'keep', destination, ruleId, category, reasonCode: 'ALREADY_PLACED',
        reason: reasonCode === 'ALREADY_PLACED' ? reason : '이미 지정한 위치에 있습니다.' };
    const parents = targetDirectory.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'));
    if (inventory.has(pathKey(destination)) || parents.some((p) => {
      const kind = inventory.get(pathKey(p)); return kind !== undefined && kind !== 'directory';
    })) return { ...base, action: 'review', category, reason: '목적지의 기존 파일 또는 제외 경로와 충돌합니다.', reasonCode: 'DEST_CONFLICT' };
    return { ...base, action: 'move', destination, ruleId, category, reason, reasonCode };
  });
  const proposals = new Map<string, PreviewItem[]>();
  for (const item of items) if (item.action === 'move' && item.destination) {
    const key = pathKey(item.destination);
    proposals.set(key, [...(proposals.get(key) ?? []), item]);
  }
  for (const collisions of proposals.values()) if (collisions.length > 1) for (const item of collisions) {
    item.action = 'review'; item.destination = null; item.reason = '여러 파일의 목적지가 같습니다. 덮어쓰지 않습니다.';
    item.reasonCode = 'DEST_COLLISION';
  }
  for (const item of items) if (item.action === 'move' && item.destination) {
    const parts = item.destination.split('/');
    const parentTargets = parts.slice(0, -1).flatMap((_, i) =>
      proposals.get(pathKey(parts.slice(0, i + 1).join('/'))) ?? []);
    if (parentTargets.length) for (const conflict of [item, ...parentTargets]) {
      conflict.action = 'review'; conflict.destination = null;
      conflict.reason = '예정된 파일 위치와 폴더 위치가 충돌합니다.'; conflict.reasonCode = 'PARENT_CONFLICT';
    }
  }
  const { duplicates, notes } = findDuplicates(scan.files, protectedPaths, scan.skipped);
  const id = digest(JSON.stringify({ version: CLASSIFICATION_VERSION, scan, profile,
    protectedPaths: [...protectedPaths].sort(compare), overrides: options.overrides ?? {} }));
  return PreviewSchema.parse({ formatVersion: 1, mode: 'preview-only', id, root: scan.root,
    profileRevision: active?.revision ?? null, profileId: active?.id ?? null, items, duplicates,
    largeFiles: scan.files.filter((f) => f.size >= LARGE_FILE_BYTES && !protectedPaths.has(pathKey(f.relativePath))).map((f) => f.relativePath),
    skipped: scan.skipped, scanComplete: scan.complete, executionAvailable: false,
    classificationVersion: CLASSIFICATION_VERSION, duplicateNotes: notes, space: spaceEstimate(duplicates),
    ...(scan.cancelled ? { cancelled: true } : {}) });
}

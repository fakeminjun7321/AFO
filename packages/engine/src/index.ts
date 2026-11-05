import path from 'node:path';
import { CLASSIFICATION_VERSION, ProfileSchema, PreviewSchema, ReferenceScanSchema, RelativePathSchema, ScanSchema }
  from '../../contracts/src/index.js';
import type { Preview, PreviewItem, Rule, RuleProfile, SmartReport } from '../../contracts/src/index.js';
import { classifyFile, extensionOf } from './classify.js';
import { findDuplicates, spaceEstimate } from './duplicates.js';
import { activeRules, parseProfile } from './rules.js';
import { compare, digest, pathKey } from './util.js';

export { digest, pathKey } from './util.js';
export { CLASSIFICATION_VERSION, categoryExtensions, classifyFile, extensionOf } from './classify.js';
export type { Classification } from './classify.js';
export { SPACE_NOTE, chooseKeeper, findDuplicates, hasCopyMark, spaceEstimate } from './duplicates.js';
export { activeRules, classifyPersonal, emptyProfile, makeCorrection, parseProfile, profileFromV1, withCorrection, withRuleEnabled,
  withStatus, withoutCorrection } from './rules.js';
export type { AnyProfile } from './rules.js';
export { complexMatches, conditionMatches, contentSuggestion, contentTopics, hamming, similarPhotos } from './smart.js';
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
  profile?: unknown; protectedPaths?: string[]; overrides?: Record<string, string>; renames?: Record<string, string>;
  conflicts?: 'review' | 'keep-both'; smart?: SmartReport; skips?: string[];
} = {}): Preview {
  const scan = ScanSchema.parse(input);
  const profile = options.profile === undefined ? undefined : parseProfile(options.profile);
  const active = profile ? activeRules(profile) : null;
  const protectedPaths = new Set((options.protectedPaths ?? []).map((p) => pathKey(RelativePathSchema.parse(p))));
  const skippedIds = new Set(options.skips ?? []);
  const inventory = new Map<string, 'file' | 'directory' | 'blocked'>();
  for (const f of scan.files) inventory.set(pathKey(f.relativePath), 'file');
  for (const dir of scan.directories) inventory.set(pathKey(dir), 'directory');
  for (const entry of scan.skipped) inventory.set(pathKey(entry.relativePath), 'blocked');
  const reserved = new Set(inventory.keys());
  const texts = new Map(options.smart?.documents.map((d) => [d.fileId, d]) ?? []);
  const photos = new Map(options.smart?.photos.map((p) => [p.fileId, p]) ?? []);
  const items: PreviewItem[] = scan.files.map((file) => {
    const base = { fileId: file.id, source: file.relativePath, destination: null, ruleId: null, category: null };
    if (protectedPaths.has(pathKey(file.relativePath)))
      return { ...base, action: 'keep', reason: '참고한 기존 파일을 보존합니다.', reasonCode: 'PROTECTED_REFERENCE' };
    if (skippedIds.has(file.id)) return { ...base, action: 'keep', reason: '사용자가 이번 분석에서 건너뛰기로 선택했습니다.', reasonCode: 'USER_SKIP' };
    if (scan.skipped.some((entry) => entry.relativePath === file.relativePath))
      return { ...base, action: 'review', reason: '읽기 또는 내용 검증에 실패한 파일입니다.', reasonCode: 'READ_FAILED' };
    const override = options.overrides?.[file.id];
    const c = classifyFile(file.relativePath, { file, ...(profile ? { profile } : {}), ...(override !== undefined ? { override } : {}) });
    const text = texts.get(file.id); const photo = photos.get(file.id);
    if (c.source === 'default' && c.category === '이미지' && photo?.capturedDate && options.smart?.options.photoDates) {
      const date = options.smart.options.photoDates === 'year' ? photo.capturedDate.slice(0, 4) : photo.capturedDate.slice(0, 7);
      c.targetDirectory = `이미지/${date}`; c.reasonCode = 'PHOTO_DATE'; c.reason = `사진에 저장된 촬영일 ${photo.capturedDate} 기준입니다(파일 수정일로 대체하지 않음).`;
    } else if (c.source === 'default' && ['문서', '전자책', '이미지'].includes(c.category ?? '') && text && ['read', 'limited'].includes(text.status) && text.suggestedDirectory) {
      c.targetDirectory = text.suggestedDirectory; c.reasonCode = text.model ? 'AI_CONTENT' : 'CONTENT_RULE'; c.reason = text.reason;
    }
    const { targetDirectory, ruleId, reason, reasonCode, category } = c;
    if (targetDirectory === null) {
      if (options.renames?.[file.id] !== undefined) throw new Error('분류를 정하지 못한 파일의 이름을 바꾸려면 목적지도 직접 지정하세요.');
      return { ...base, action: 'review', reason, reasonCode };
    }
    const renamed = options.renames?.[file.id];
    if (renamed !== undefined && (!RelativePathSchema.safeParse(renamed).success || renamed.includes('/') || renamed.includes('\\') || renamed.startsWith('.')))
      throw new Error('새 파일 이름은 숨김·경로 구분자 없는 파일 이름 하나여야 합니다.');
    const basename = renamed ?? path.posix.basename(file.relativePath);
    let destination = `${targetDirectory}/${basename}`;
    if (!RelativePathSchema.safeParse(destination).success)
      return { ...base, action: 'review', reason: '목적지 경로를 만들 수 없습니다(길이·이름 제한).', reasonCode: 'DEST_INVALID' };
    if (pathKey(destination) === pathKey(file.relativePath))
      return { ...base, action: 'keep', destination, ruleId, category, reasonCode: 'ALREADY_PLACED',
        reason: reasonCode === 'ALREADY_PLACED' ? reason : '이미 지정한 위치에 있습니다.' };
    let conflictRenamed = false;
    if (options.conflicts === 'keep-both' && reserved.has(pathKey(destination))) {
      const ext = path.posix.extname(basename); const stem = basename.slice(0, basename.length - ext.length);
      for (let i = 1; i <= 999; i++) {
        const candidate = `${targetDirectory}/${stem} (${i})${ext}`;
        if (RelativePathSchema.safeParse(candidate).success && !reserved.has(pathKey(candidate))) { destination = candidate; conflictRenamed = true; break; }
      }
      if (!conflictRenamed) return { ...base, action: 'review', category, reason: '안전한 새 이름을 만들 수 없습니다. 직접 짧은 이름을 지정하세요.', reasonCode: 'DEST_CONFLICT' };
    }
    const parents = targetDirectory.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'));
    if ((options.conflicts !== 'keep-both' && inventory.has(pathKey(destination))) || parents.some((p) => {
      const kind = inventory.get(pathKey(p)); return kind !== undefined && kind !== 'directory';
    })) return { ...base, action: 'review', category, reason: '목적지의 기존 파일 또는 제외 경로와 충돌합니다.', reasonCode: 'DEST_CONFLICT' };
    reserved.add(pathKey(destination));
    return { ...base, action: 'move', destination, ruleId, category,
      reason: conflictRenamed ? `이름 충돌: 두 파일을 보관하도록 ${path.posix.basename(destination)}로 제안합니다.` : renamed ? '사용자가 새 파일 이름을 지정했습니다.' : reason,
      reasonCode: conflictRenamed ? 'RENAMED_CONFLICT' : renamed ? 'USER_RENAME' : reasonCode };
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
  const skippedPaths = new Set(scan.files.filter((file) => skippedIds.has(file.id)).map((file) => pathKey(file.relativePath)));
  const { duplicates, notes } = findDuplicates(scan.files, new Set([...protectedPaths, ...skippedPaths]), scan.skipped);
  for (const group of duplicates) if (skippedPaths.has(pathKey(group.suggestedKeep))) group.keepReason = '사용자가 건너뛰기로 선택한 파일을 보존합니다.';
  const id = digest(JSON.stringify({ version: CLASSIFICATION_VERSION, scan, profile,
    protectedPaths: [...protectedPaths].sort(compare), overrides: options.overrides ?? {},
    ...(options.renames ? { renames: options.renames } : {}), ...(options.conflicts ? { conflicts: options.conflicts } : {}), ...(options.smart ? { smart: options.smart } : {}),
    ...(options.skips ? { skips: [...skippedIds].sort(compare) } : {}) }));
  return PreviewSchema.parse({ formatVersion: 1, mode: 'preview-only', id, root: scan.root,
    profileRevision: active?.revision ?? null, profileId: active?.id ?? null, items, duplicates,
    largeFiles: scan.files.filter((f) => f.size >= LARGE_FILE_BYTES && !protectedPaths.has(pathKey(f.relativePath))).map((f) => f.relativePath),
    skipped: scan.skipped, scanComplete: scan.complete, executionAvailable: false,
    classificationVersion: CLASSIFICATION_VERSION, duplicateNotes: notes, space: spaceEstimate(duplicates),
    ...(options.smart ? { smart: options.smart } : {}),
    ...(scan.cancelled ? { cancelled: true } : {}) });
}

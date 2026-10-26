import { AfoError, ApprovalModeSchema, OperationPlanSchema, PLAN_TTL_MS, PreviewSchema, RelativePathSchema, RootGrantSchema, ScanSchema,
  approvalModeKind } from '../../contracts/src/index.js';
import type { ApprovalMode, FileSnapshot, OperationKind, OperationPlan, PlanOperation, PreviewItem, ReviewItem, RootGrant }
  from '../../contracts/src/index.js';
import { compare, digest, pathKey } from './util.js';

/**
 * Execution plans (#8): pure and deterministic. The same preview, scan, grant, selections and `now` give the same plan.
 * A plan proposes work only; nothing here authorizes or performs a filesystem change.
 */

/** JSON with object keys sorted at every level; undefined members are dropped as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort(compare)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('JSON으로 표현할 수 없는 값입니다.');
  return text;
}
/** sha256 of the canonical plan without `id`. A valid plan has id === planHash(plan). */
export function planHash(plan: Omit<OperationPlan, 'id'> & { id?: string }): string {
  const { id: _id, ...rest } = plan;
  return digest(canonicalJson(rest));
}

export interface DeleteSelection { sha256: string; candidates: string[] }
export interface BuildPlanOptions {
  /** The scan the preview was built from: it supplies size, mtime, dev/inode and hash for each operation. */
  scan: unknown; grant: RootGrant; sessionId: string; deleteMode: 'trash' | 'permanent';
  /** Duplicate groups to delete, keeping each group's suggestedKeep (change it first with chooseKeeper). */
  deleteSelections?: DeleteSelection[] | 'all-duplicates';
  /** Files the user picked one by one for deletion (no keeper). */
  explicitDeletes?: string[]; now: Date;
}

const fail = (code: ConstructorParameters<typeof AfoError>[0], message: string): AfoError => new AfoError(code, message);
const KEEPER_MOVE = '중복 파일 중 남길 파일이라 이번 계획에서는 옮기지 않습니다.';
const DEST_TAKEN = '목적지가 같은 계획의 다른 파일 위치와 겹칩니다. 덮어쓰지 않습니다.';
const prefixes = (relativePath: string): string[] => {
  const parts = relativePath.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

export function buildPlan(previewInput: unknown, options: BuildPlanOptions): OperationPlan {
  const preview = PreviewSchema.parse(previewInput);
  const scan = ScanSchema.parse(options.scan);
  const grant = RootGrantSchema.parse(options.grant);
  const now = options.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('계획 시각(now)이 필요합니다.');
  if (preview.cancelled || scan.cancelled) throw fail('CANCELLED', '취소된 분석으로는 정리 계획을 만들 수 없습니다.');
  if (grant.sessionId !== options.sessionId) throw fail('ROOT_FORBIDDEN', '다른 세션의 폴더 권한입니다.');
  if (preview.root.id !== scan.root.id || preview.root.canonicalPath !== grant.canonicalPath || scan.root.canonicalPath !== grant.canonicalPath)
    throw fail('ROOT_FORBIDDEN', '선택한 작업 폴더의 분석 결과가 아닙니다.');
  const profileId = preview.profileId ?? null;
  if ((profileId === null) !== (preview.profileRevision === null))
    throw fail('PROFILE_CHANGED', '프로필 ID가 없는 이전 미리보기입니다. 다시 분석하세요.');
  if (options.deleteMode !== 'trash' && options.deleteMode !== 'permanent') throw fail('MODE_MISMATCH', '삭제 방식이 올바르지 않습니다.');
  const deleteKind: OperationKind = options.deleteMode === 'trash' ? 'trash' : 'delete';

  const files = new Map(scan.files.map((f) => [f.id, f]));
  const bySource = new Map<string, { item: PreviewItem; file: FileSnapshot }>();
  for (const item of preview.items) {
    const file = files.get(item.fileId);
    if (!file || file.relativePath !== item.source) throw fail('PLAN_CHANGED', '미리보기와 스캔 결과가 다릅니다. 다시 분석하세요.');
    bySource.set(item.source, { item, file });
  }
  if (bySource.size !== scan.files.length) throw fail('PLAN_CHANGED', '미리보기와 스캔 결과의 파일 목록이 다릅니다.');
  const unreadable = new Set(scan.skipped.map((s) => s.relativePath));
  const isProtected = (item: PreviewItem): boolean => item.reasonCode === 'PROTECTED_REFERENCE';

  // Deletions: duplicate candidates (keeper required) and explicitly chosen files (no keeper).
  const deletes = new Map<string, { keeper: string | null; reason: string }>();
  const keepers = new Set<string>();
  const selections = options.deleteSelections === 'all-duplicates'
    ? preview.duplicates.map((g) => ({ sha256: g.sha256, candidates: g.candidates })) : options.deleteSelections ?? [];
  const seenGroups = new Set<string>();
  for (const selection of selections) {
    const group = preview.duplicates.find((g) => g.sha256 === selection.sha256);
    if (!group || seenGroups.has(group.sha256)) throw fail('KEEPER_INVALID', '없는 중복 그룹이거나 같은 그룹을 두 번 골랐습니다.');
    seenGroups.add(group.sha256);
    const keeper = bySource.get(group.suggestedKeep);
    if (!keeper || keeper.file.sha256 !== group.sha256 || unreadable.has(keeper.file.relativePath))
      throw fail('KEEPER_INVALID', '남길 파일의 내용을 확인할 수 없습니다. 다시 분석하세요.');
    if (!selection.candidates.length || new Set(selection.candidates).size !== selection.candidates.length)
      throw fail('KEEPER_INVALID', '삭제할 중복 후보를 중복 없이 하나 이상 골라야 합니다.');
    for (const candidate of selection.candidates) {
      const entry = bySource.get(candidate);
      if (!group.candidates.includes(candidate) || !entry || pathKey(candidate) === pathKey(group.suggestedKeep))
        throw fail('KEEPER_INVALID', '그 중복 그룹의 삭제 후보가 아닙니다.');
      if (isProtected(entry.item)) throw fail('KEEPER_INVALID', '참고한 기존 파일(보호 파일)은 삭제 후보가 될 수 없습니다.');
      if (entry.file.sha256 !== group.sha256 || entry.file.size === 0 || unreadable.has(candidate))
        throw fail('KEEPER_INVALID', '내용이 같은지 확인되지 않은 파일은 중복으로 삭제할 수 없습니다.');
      if (deletes.has(candidate)) throw fail('KEEPER_INVALID', '같은 파일을 두 번 골랐습니다.');
      deletes.set(candidate, { keeper: group.suggestedKeep, reason: `내용이 같은 파일 "${group.suggestedKeep}"을(를) 남기고 지웁니다.` });
    }
    keepers.add(group.suggestedKeep);
  }
  for (const raw of options.explicitDeletes ?? []) {
    const source = RelativePathSchema.parse(raw);
    const entry = bySource.get(source);
    if (!entry) throw fail('SOURCE_MISSING', '분석 결과에 없는 파일은 삭제할 수 없습니다.');
    if (isProtected(entry.item)) throw fail('ROOT_FORBIDDEN', '참고한 기존 파일(보호 파일)은 삭제할 수 없습니다.');
    if (unreadable.has(source) || entry.item.reasonCode === 'READ_FAILED') throw fail('FILE_CHANGED', '읽지 못한 파일입니다. 다시 분석하세요.');
    if (deletes.has(source)) throw fail('KEEPER_INVALID', '같은 파일을 두 번 골랐습니다.');
    deletes.set(source, { keeper: null, reason: '사용자가 직접 고른 삭제 파일입니다.' });
  }
  for (const keeper of keepers) if (deletes.has(keeper)) throw fail('KEEPER_INVALID', '남길 파일을 삭제 대상으로 고를 수 없습니다.');

  const sources = [...bySource.keys()].sort(compare);
  const moves: Array<{ source: string; item: PreviewItem }> = [];
  const review: ReviewItem[] = [];
  const ops: Array<Omit<PlanOperation, 'id'>> = [];
  const expected = (f: FileSnapshot): PlanOperation['expected'] =>
    ({ size: f.size, modifiedNs: f.modifiedNs, device: f.device, inode: f.inode, sha256: f.sha256 });
  for (const source of sources) {
    const { item, file } = bySource.get(source)!;
    const del = deletes.get(source);
    if (del) ops.push({ kind: deleteKind, fileId: file.id, source, destination: null, reason: del.reason, ruleId: null,
      keeper: del.keeper, expected: expected(file) });
    else if (item.action === 'move' && keepers.has(source)) review.push({ fileId: file.id, source, status: 'keep', reason: KEEPER_MOVE });
    else if (item.action === 'move' && item.destination !== null) moves.push({ source, item });
    else review.push({ fileId: file.id, source, status: item.action === 'move' ? 'review' : item.action, reason: item.reason });
  }
  // A move may not land on, or below, any file of this plan, nor collide with another move (file vs folder included).
  const existing = new Set(sources.map(pathKey));
  const destCount = new Map<string, number>();
  for (const m of moves) destCount.set(pathKey(m.item.destination!), (destCount.get(pathKey(m.item.destination!)) ?? 0) + 1);
  const blocked = new Set<string>();
  for (const m of moves) {
    const dest = m.item.destination!;
    const parentDests = prefixes(dest).filter((p) => destCount.has(pathKey(p)));
    if (existing.has(pathKey(dest)) || destCount.get(pathKey(dest))! > 1 || prefixes(dest).some((p) => existing.has(pathKey(p)))) blocked.add(m.source);
    if (parentDests.length) {
      blocked.add(m.source);
      for (const other of moves) if (parentDests.some((p) => pathKey(other.item.destination!) === pathKey(p))) blocked.add(other.source);
    }
  }
  for (const { source, item } of moves) {
    const file = bySource.get(source)!.file;
    if (blocked.has(source)) review.push({ fileId: file.id, source, status: 'review', reason: DEST_TAKEN });
    else ops.push({ kind: 'move', fileId: file.id, source, destination: item.destination, reason: item.reason, ruleId: item.ruleId,
      keeper: null, expected: expected(file) });
  }
  const operations = ops.map((op) => ({ id: digest(canonicalJson(op)).slice(0, 16), ...op }))
    .sort((a, b) => compare(a.source, b.source) || compare(a.id, b.id));
  review.sort((a, b) => compare(a.source, b.source));
  const count = (kind: OperationKind): number => operations.filter((op) => op.kind === kind).length;
  const body = { formatVersion: 1 as const, rootGrantId: grant.id, rootPath: grant.canonicalPath, sessionId: options.sessionId,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), profileId,
    profileRevision: preview.profileRevision, deleteMode: options.deleteMode, operations, reviewItems: review,
    summary: { move: count('move'), trash: count('trash'), delete: count('delete'),
      logicalBytes: operations.reduce((sum, op) => sum + op.expected.size, 0) } };
  return OperationPlanSchema.parse({ id: planHash(body), ...body });
}

/** First 8 hex of sha256 over plan, sorted operation IDs and mode. The user types it to confirm exactly this batch. */
export function approvalCode(planId: string, operationIds: readonly string[], mode: ApprovalMode): string {
  return digest(JSON.stringify([planId, [...operationIds].sort(compare), ApprovalModeSchema.parse(mode)])).slice(0, 8);
}

/**
 * Operations of `plan` named by `operationIds` (returned sorted by ID). Unknown, repeated or empty selections are APPROVAL_INVALID;
 * a selection with any operation of another kind than the mode allows is MODE_MISMATCH.
 */
export function selectOperations(plan: OperationPlan, operationIds: readonly string[], mode: ApprovalMode): PlanOperation[] {
  const kind = approvalModeKind[ApprovalModeSchema.parse(mode)];
  if (!operationIds.length || new Set(operationIds).size !== operationIds.length)
    throw fail('APPROVAL_INVALID', '승인할 작업 ID를 중복 없이 하나 이상 골라야 합니다.');
  const byId = new Map(plan.operations.map((op) => [op.id, op]));
  const chosen = [...operationIds].sort(compare).map((id) => byId.get(id));
  if (chosen.some((op) => op === undefined)) throw fail('APPROVAL_INVALID', '계획에 없는 작업 ID입니다.');
  if (chosen.some((op) => op!.kind !== kind)) throw fail('MODE_MISMATCH', '선택한 작업의 종류가 승인 방식과 다릅니다. 방식별로 따로 승인하세요.');
  return chosen as PlanOperation[];
}

/** Per mode with work: every operation ID of that kind and the code that approves all of them at once. */
export function approvalChoices(plan: OperationPlan): Array<{ mode: ApprovalMode; operationIds: string[]; code: string }> {
  return ApprovalModeSchema.options.flatMap((mode) => {
    const operationIds = plan.operations.filter((op) => op.kind === approvalModeKind[mode]).map((op) => op.id).sort(compare);
    return operationIds.length ? [{ mode, operationIds, code: approvalCode(plan.id, operationIds, mode) }] : [];
  });
}

export interface PlanDiff {
  /** Operation IDs are content hashes, so an unchanged ID means the same file, identity, target and keeper. */
  unchanged: string[]; added: string[]; removed: string[];
  rootChanged: boolean; profileChanged: boolean; deleteModeChanged: boolean;
}
/**
 * What the user must re-check in `next` compared with `previous`: only `added` operations are new or changed.
 * Informational: approvals bind one plan ID, so `next` always needs its own approval and never inherits one.
 */
export function diffPlans(previous: OperationPlan, next: OperationPlan): PlanDiff {
  const before = new Set(OperationPlanSchema.parse(previous).operations.map((op) => op.id));
  const after = new Set(OperationPlanSchema.parse(next).operations.map((op) => op.id));
  return { unchanged: [...after].filter((id) => before.has(id)).sort(compare), added: [...after].filter((id) => !before.has(id)).sort(compare),
    removed: [...before].filter((id) => !after.has(id)).sort(compare),
    rootChanged: previous.rootPath !== next.rootPath || previous.rootGrantId !== next.rootGrantId,
    profileChanged: previous.profileId !== next.profileId || previous.profileRevision !== next.profileRevision,
    deleteModeChanged: previous.deleteMode !== next.deleteMode };
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { AfoError, OperationPlanSchema, RelativePathSchema } from '../../contracts/src/index.js';
import type { OperationKind, OperationPlan, PlanOperation, ReviewItem, RootGrant } from '../../contracts/src/index.js';

/**
 * Plan building for #8. Pure: no filesystem access. The caller passes what the scan observed.
 * The plan ID is a hash of the whole plan content, so any edit (an operation, a destination, the profile
 * revision, the root, the session or the validity window) produces a different ID and voids earlier approvals.
 */
export const PLAN_TTL_MS = 60 * 60 * 1000;
const MAX_SUFFIX = 99;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Name comparison used for collisions: case-insensitive and Unicode-normalization-insensitive (APFS/NTFS-safe). */
export const collisionKey = (value: string): string => value.normalize('NFC').toLowerCase();
const byString = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** JSON with object keys sorted recursively; arrays keep their order. Same value → same text on every OS. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('유한하지 않은 숫자는 계획에 넣을 수 없습니다.');
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
      throw new TypeError('JSON으로 표현할 수 없는 값입니다.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => byString(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Hash of every plan field except `id`. Operations and review items are hashed in their canonical order. */
export function planContentHash(plan: Omit<OperationPlan, 'id'> & { id?: string }): string {
  const { id: _ignored, ...content } = plan;
  return sha256(canonicalJson({
    ...content,
    operations: [...content.operations].sort((a, b) => byString(a.id, b.id)),
    reviewItems: [...content.reviewItems].sort((a, b) => byString(a.fileId, b.fileId)),
  }));
}
/** True when the plan's ID still matches its content. */
export const planHashMatches = (plan: OperationPlan): boolean => planContentHash(plan) === plan.id;

export interface PlanProposal {
  fileId: string; source: string; kind: OperationKind; destination: string | null; reason: string; ruleId: string | null;
  keeper: string | null; expected: PlanOperation['expected'];
}
export interface PlanInput {
  grant: Pick<RootGrant, 'id' | 'canonicalPath' | 'sessionId'>;
  profile: { id: string; revision: number } | null;
  deleteMode: 'trash' | 'permanent';
  proposals: PlanProposal[];
  /** Files the classifier left alone or could not decide; they are shown but never executed. */
  reviewItems?: ReviewItem[];
  /** Every relative path that exists under the root (files and folders), from the scan. */
  occupied: { files: string[]; directories: string[] };
  now?: Date; ttlMs?: number;
}

/** Content-addressed operation ID: a change to the file identity, source, destination or keeper gives a new ID. */
export const operationId = (p: Pick<PlanProposal, 'fileId' | 'kind' | 'source' | 'destination' | 'keeper' | 'expected'>): string =>
  sha256(canonicalJson({ fileId: p.fileId, kind: p.kind, source: p.source, destination: p.destination, keeper: p.keeper,
    expected: p.expected })).slice(0, 16);

function withSuffix(destination: string, n: number): string {
  const dir = path.posix.dirname(destination); const base = path.posix.basename(destination);
  const ext = path.posix.extname(base);
  // A leading dot is a hidden name, not an extension ('.env' → '.env (2)').
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
  const name = `${stem} (${n})${ext && ext !== base ? ext : ''}`;
  return dir === '.' ? name : `${dir}/${name}`;
}
const ancestors = (relative: string): string[] => {
  const parts = relative.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/**
 * Builds a deterministic plan. Destination rules, in order:
 * 1. invalid names (reserved, `..`, trailing dot/space) → review item, never renamed silently;
 * 2. destination equal to the source (case/Unicode-folded) → review item "이미 정리됨";
 * 3. a file where a destination folder must be → review item;
 * 4. a name taken by an existing path or an earlier destination → first free "이름 (n).확장자", n = 2..99, else review.
 * Proposals are processed in source order, so the same input always yields the same names.
 */
export function buildPlan(input: PlanInput): OperationPlan {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? PLAN_TTL_MS;
  if (!(ttl > 0)) throw new AfoError('PLAN_CHANGED', '계획 유효 기간이 올바르지 않습니다.');
  const fileKeys = new Set(input.occupied.files.map(collisionKey));
  const taken = new Set([...input.occupied.files, ...input.occupied.directories].map(collisionKey));
  const seen = new Set<string>();
  const operations: PlanOperation[] = [];
  const reviewItems: ReviewItem[] = [...(input.reviewItems ?? [])];
  const review = (p: PlanProposal, reason: string): void => {
    reviewItems.push({ fileId: p.fileId, source: p.source, status: 'review', reason });
  };
  const proposals = [...input.proposals].sort((a, b) => byString(collisionKey(a.source), collisionKey(b.source)) ||
    byString(a.source, b.source));
  for (const p of proposals) {
    if (seen.has(p.fileId)) throw new AfoError('PLAN_CHANGED', '한 파일에 계획 항목이 둘 이상입니다.');
    seen.add(p.fileId);
    if ((p.kind === 'trash' || p.kind === 'delete') && p.kind !== (input.deleteMode === 'trash' ? 'trash' : 'delete'))
      throw new AfoError('MODE_MISMATCH', '삭제 방식과 작업 종류가 다릅니다.');
    let destination = p.destination;
    if (p.kind === 'move') {
      if (destination === null) { review(p, '목적지가 없는 이동 제안입니다.'); continue; }
      if (!RelativePathSchema.safeParse(destination).success) {
        review(p, `목적지 이름을 이 OS에서 안전하게 쓸 수 없어 검토 대상으로 남겼습니다: ${destination}`); continue;
      }
      if (collisionKey(destination) === collisionKey(p.source)) { review(p, '이미 제안 위치에 있습니다(이미 정리됨).'); continue; }
      if (ancestors(destination).some((dir) => fileKeys.has(collisionKey(dir)))) {
        review(p, '목적지 폴더 자리에 같은 이름의 파일이 있어 검토 대상으로 남겼습니다.'); continue;
      }
      let candidate = destination; let n = 1;
      while (taken.has(collisionKey(candidate)) && n < MAX_SUFFIX) candidate = withSuffix(destination, ++n);
      if (taken.has(collisionKey(candidate)) || !RelativePathSchema.safeParse(candidate).success) {
        review(p, '목적지 이름이 모두 사용 중이라 검토 대상으로 남겼습니다.'); continue;
      }
      destination = candidate;
      taken.add(collisionKey(destination));
      for (const dir of ancestors(destination)) taken.add(collisionKey(dir));
    } else if (destination !== null) throw new AfoError('PLAN_CHANGED', '삭제 작업에는 목적지가 없습니다.');
    const reason = destination !== null && destination !== p.destination
      ? `${p.reason} (같은 이름이 있어 "${path.posix.basename(destination)}"로 저장)` : p.reason;
    operations.push({ id: operationId({ ...p, destination }), kind: p.kind, fileId: p.fileId, source: p.source,
      destination, reason, ruleId: p.ruleId, keeper: p.keeper, expected: p.expected });
  }
  operations.sort((a, b) => byString(a.id, b.id));
  reviewItems.sort((a, b) => byString(a.fileId, b.fileId));
  const count = (kind: OperationKind): number => operations.filter((op) => op.kind === kind).length;
  const content = {
    formatVersion: 1 as const, rootGrantId: input.grant.id, rootPath: input.grant.canonicalPath,
    sessionId: input.grant.sessionId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(),
    profileId: input.profile?.id ?? null, profileRevision: input.profile?.revision ?? null, deleteMode: input.deleteMode,
    operations, reviewItems,
    summary: { move: count('move'), trash: count('trash'), delete: count('delete'),
      logicalBytes: operations.reduce((sum, op) => sum + op.expected.size, 0) },
  };
  return OperationPlanSchema.parse({ id: planContentHash(content), ...content });
}

/**
 * After a re-scan, which earlier approved operations are byte-for-byte the same in the new plan.
 * Only those may be pre-selected again; everything else needs a fresh confirmation. Never adds IDs
 * that were not approved before. A new approval for the new plan is still required.
 */
export function carryOverSelection(approvedIds: readonly string[], next: OperationPlan): { unchanged: string[]; needsConfirmation: string[] } {
  const approved = new Set(approvedIds);
  const ids = next.operations.map((op) => op.id);
  return { unchanged: ids.filter((id) => approved.has(id)).sort(byString),
    needsConfirmation: ids.filter((id) => !approved.has(id)).sort(byString) };
}

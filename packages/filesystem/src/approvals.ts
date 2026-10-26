import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AfoError, APPROVAL_TTL_MS, ApprovalSchema, approvalModeKind, OpaqueIdSchema, OperationPlanSchema,
  isAfoError } from '../../contracts/src/index.js';
import type { Approval, ApprovalMode, OperationPlan, PlanOperation } from '../../contracts/src/index.js';
import { planHashMatches } from '../../engine/src/planning.js';
import { readJson, statePaths, writeJsonAtomic } from './state.js';

/**
 * One-time approvals held by the shared service (#8). CLI/GUI adapters pass only an approval ID they got from
 * `issueApproval`; a boolean, a path list or an approval object from the caller is never accepted as authority.
 * Threat model: protects against stale/changed plans, mode mix-ups, replay and wrong session/root. A local user
 * who can edit the app state folder directly is out of scope (same trust as the user's own files).
 */
const approvalFile = (stateDir: string, id: string): string => path.join(statePaths(stateDir).approvals, `${id}.json`);
const usedMarker = (stateDir: string, id: string): string => path.join(statePaths(stateDir).approvals, `${id}.used`);
const sortedUnique = (ids: readonly string[]): boolean => ids.every((id, i) => i === 0 || ids[i - 1]! < id);

export interface IssueRequest {
  plan: OperationPlan; sessionId: string; operationIds: readonly string[]; mode: ApprovalMode; now?: Date;
}

function checkPlan(plan: unknown, now: Date): OperationPlan {
  const parsed = OperationPlanSchema.safeParse(plan);
  if (!parsed.success) throw new AfoError('PLAN_CHANGED', '계획이 계약과 다릅니다.');
  if (!planHashMatches(parsed.data)) throw new AfoError('PLAN_CHANGED', '계획 내용이 계획 ID와 다릅니다(수정된 계획).');
  if (now.getTime() >= Date.parse(parsed.data.expiresAt)) throw new AfoError('PLAN_CHANGED', '계획이 만료되었습니다. 다시 분석하세요.');
  return parsed.data;
}
function selectOperations(plan: OperationPlan, ids: readonly string[], mode: ApprovalMode): PlanOperation[] {
  if (ids.length === 0 || !sortedUnique(ids)) throw new AfoError('APPROVAL_INVALID', '승인할 작업을 중복 없이 정렬해 고르세요.');
  const byId = new Map(plan.operations.map((op) => [op.id, op]));
  const ops = ids.map((id) => byId.get(id));
  if (ops.some((op) => op === undefined)) throw new AfoError('APPROVAL_INVALID', '계획에 없는 작업이 포함되었습니다.');
  const selected = ops as PlanOperation[];
  if (selected.some((op) => op.kind !== approvalModeKind[mode]))
    throw new AfoError('MODE_MISMATCH', '한 번의 승인에는 같은 종류의 작업만 담을 수 있습니다.');
  // Duplicate groups: the keeper must stay. The plan schema already forbids a keeper that is itself a target.
  const sources = new Set(plan.operations.map((op) => op.source.normalize('NFC').toLowerCase()));
  if (selected.some((op) => op.keeper !== null && sources.has(op.keeper.normalize('NFC').toLowerCase())))
    throw new AfoError('KEEPER_INVALID', '남길 파일까지 삭제 대상으로 고를 수 없습니다.');
  return selected;
}

export async function issueApproval(stateDir: string, request: IssueRequest): Promise<Approval> {
  const now = request.now ?? new Date();
  const plan = checkPlan(request.plan, now);
  if (request.sessionId !== plan.sessionId) throw new AfoError('APPROVAL_INVALID', '다른 세션의 계획은 승인할 수 없습니다.');
  selectOperations(plan, request.operationIds, request.mode);
  const expires = Math.min(now.getTime() + APPROVAL_TTL_MS, Date.parse(plan.expiresAt));
  const approval = ApprovalSchema.parse({
    formatVersion: 1, id: randomBytes(16).toString('hex'), planId: plan.id, sessionId: plan.sessionId,
    rootGrantId: plan.rootGrantId, operationIds: [...request.operationIds], mode: request.mode,
    profileId: plan.profileId, profileRevision: plan.profileRevision,
    issuedAt: now.toISOString(), expiresAt: new Date(expires).toISOString(), usedAt: null,
  });
  await writeJsonAtomic(approvalFile(stateDir, approval.id), approval, ApprovalSchema);
  return approval;
}

export interface ConsumeContext {
  plan: OperationPlan; sessionId: string; rootGrantId: string;
  /** The profile that is active now; null when none, disabled or reset. Must equal what the plan was built with. */
  profile: { id: string; revision: number } | null;
  now?: Date;
}

/**
 * Validates and spends an approval exactly once (also across processes: the `.used` marker is created with O_EXCL).
 * Returns the approved operations only. File identity is re-checked by the executor right before each operation.
 */
export async function consumeApproval(stateDir: string, approvalId: string, context: ConsumeContext):
  Promise<{ approval: Approval; operations: PlanOperation[] }> {
  if (!OpaqueIdSchema.safeParse(approvalId).success) throw new AfoError('APPROVAL_INVALID', '승인 ID 형식이 아닙니다.');
  const now = context.now ?? new Date();
  let approval: Approval | null;
  try { approval = await readJson(approvalFile(stateDir, approvalId), ApprovalSchema); }
  catch (error) {
    if (isAfoError(error, 'STATE_CORRUPT')) throw new AfoError('APPROVAL_INVALID', '승인 기록이 손상되었습니다.', { cause: error });
    throw error;
  }
  if (approval === null) throw new AfoError('APPROVAL_MISSING', '발급된 승인이 없습니다.');
  if (approval.usedAt !== null) throw new AfoError('APPROVAL_USED', '이미 사용한 승인입니다.');
  const plan = checkPlan(context.plan, now);
  if (approval.planId !== plan.id) throw new AfoError('PLAN_CHANGED', '승인 이후 계획이 바뀌었습니다. 다시 확인하세요.');
  if (approval.sessionId !== context.sessionId || plan.sessionId !== context.sessionId)
    throw new AfoError('APPROVAL_INVALID', '다른 세션에서 받은 승인입니다.');
  if (approval.rootGrantId !== context.rootGrantId || plan.rootGrantId !== context.rootGrantId)
    throw new AfoError('APPROVAL_INVALID', '작업 폴더가 바뀌어 기존 승인을 쓸 수 없습니다.');
  const current = context.profile;
  if ((current?.id ?? null) !== approval.profileId || (current?.revision ?? null) !== approval.profileRevision)
    throw new AfoError('PROFILE_CHANGED', '개인 규칙이 바뀌어(수정·비활성화·초기화) 기존 승인을 쓸 수 없습니다.');
  if (now.getTime() >= Date.parse(approval.expiresAt)) throw new AfoError('APPROVAL_EXPIRED', '승인 유효 시간이 지났습니다.');
  const operations = selectOperations(plan, approval.operationIds, approval.mode);

  await mkdir(statePaths(stateDir).approvals, { recursive: true, mode: 0o700 });
  try {
    const marker = await open(usedMarker(stateDir, approvalId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await marker.writeFile(`${now.toISOString()}\n`); await marker.sync(); } finally { await marker.close(); }
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      throw new AfoError('APPROVAL_USED', '이미 사용한 승인입니다.');
    throw new AfoError('APPROVAL_INVALID', '승인 사용 기록을 남기지 못해 실행하지 않습니다.', { cause: error });
  }
  const spent = ApprovalSchema.parse({ ...approval, usedAt: now.toISOString() });
  // The marker is the authority; this rewrite only makes the record readable. A failure here still leaves it spent.
  await writeJsonAtomic(approvalFile(stateDir, approvalId), spent, ApprovalSchema).catch(() => undefined);
  return { approval: spent, operations };
}

/** Whether an approval was already spent (marker present), without spending it. */
export async function isApprovalUsed(stateDir: string, approvalId: string): Promise<boolean> {
  if (!OpaqueIdSchema.safeParse(approvalId).success) return false;
  try { const h = await open(usedMarker(stateDir, approvalId), constants.O_RDONLY); await h.close(); return true; }
  catch { return false; }
}

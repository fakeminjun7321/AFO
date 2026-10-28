import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { APPROVAL_TTL_MS, AfoError, ApprovalRequestSchema, ApprovalSchema, OpaqueIdSchema, OperationPlanSchema, PERMANENT_DELETE_PHRASE,
  SavedApprovalSchema, SavedPlanSchema, isAfoError } from '../../contracts/src/index.js';
import type { Approval, ApprovalRequest, GrantIdentity, OperationPlan, PlanOperation, RootGrant, SavedApproval, SavedPlan }
  from '../../contracts/src/index.js';
import { approvalCode, canonicalJson, planHash, selectOperations } from '../../engine/src/plan.js';
import { issueRootGrant, revokeGrant, verifyGrant } from './grants.js';
import { loadProfile } from './profiles.js';
import { assertStateDirOutside, readJson, statePaths, writeJsonAtomic } from './state.js';

/**
 * Shared execution service, part 1 (#8): saved plans and one-time batch approvals.
 * Only this module creates approval records. An approval binds plan ID (= plan hash), session, root grant and root identity,
 * the sorted operation IDs, one mode and the profile revision; it lasts 10 minutes and is consumed exactly once.
 * Approval files carry an HMAC under a per-state-folder secret, so a record written by anything else (CLI JSON, a GUI, a hand-made file)
 * is refused even when it names a valid saved plan. The secret only protects against writers that cannot read the state folder.
 */
export interface ApprovedBatch {
  plan: OperationPlan; approval: Approval;          // verified and consumed (usedAt recorded) approval
  operations: PlanOperation[];                       // in approval.operationIds order, a subset of plan.operations
  grant: RootGrant;                                  // re-issued in this process and matched to plan.rootPath and the saved dev/inode
  stateDir: string;                                  // absolute state folder, checked to be outside the root
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SHA = /^[a-f0-9]{64}$/u;
const fsCode = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const fail = (code: ConstructorParameters<typeof AfoError>[0], message: string, cause?: unknown): AfoError =>
  new AfoError(code, message, cause === undefined ? undefined : { cause });
const planFile = (stateDir: string, planId: string): string => path.join(statePaths(stateDir).plans, `${planId}.json`);
const approvalFile = (stateDir: string, id: string): string => path.join(statePaths(stateDir).approvals, `${id}.json`);
/** Created with O_EXCL at consumption and never removed: the atomic "used" bit, even if the JSON record is rolled back. */
const usedMarker = (stateDir: string, id: string): string => path.join(statePaths(stateDir).approvals, `${id}.used`);
const identity = (g: GrantIdentity): GrantIdentity =>
  ({ canonicalPath: g.canonicalPath, device: g.device, inode: g.inode, sessionId: g.sessionId });

/** 32 random bytes (hex) in <state>/secret, 0600. Created once via link() so concurrent creators agree on one value. */
async function stateSecret(stateDir: string, create: boolean): Promise<Buffer | null> {
  const file = path.join(stateDir, 'secret');
  const read = async (): Promise<Buffer> => {
    const stat = await lstat(file);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
      throw fail('STATE_CORRUPT', '승인 비밀 파일이 일반 파일이 아니거나 다른 사용자가 읽을 수 있습니다.');
    const text = (await readFile(file, 'utf8')).trim();
    if (!SHA.test(text)) throw fail('STATE_CORRUPT', '승인 비밀 파일이 손상됐습니다.');
    return Buffer.from(text, 'hex');
  };
  try { return await read(); }
  catch (error) { if (fsCode(error) !== 'ENOENT') throw error instanceof AfoError ? error : fail('STATE_CORRUPT', '승인 비밀 파일을 읽을 수 없습니다.', error); }
  if (!create) return null;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString('hex')}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, file); } catch (error) { if (fsCode(error) !== 'EEXIST') throw error; }
  } catch (error) { throw fail('UNKNOWN', '승인 비밀 파일을 만들지 못했습니다.', error); }
  finally { await unlink(temp).catch(() => undefined); }
  return read();
}
/** usedAt is excluded: consumption rewrites it, and reuse is blocked by the O_EXCL marker, not by this field. */
const macOf = (secret: Buffer, approval: Approval, grant: GrantIdentity): string =>
  createHmac('sha256', secret).update(canonicalJson({ approval: { ...approval, usedAt: null }, grant: identity(grant) })).digest('hex');
const sameMac = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Plans that used a profile need that exact saved profile (confirmed, same ID and revision). Edit, disable or reset → PROFILE_CHANGED. */
async function checkProfile(stateDir: string, plan: OperationPlan): Promise<void> {
  if (plan.profileId === null) return;
  const profile = await loadProfile({ stateDir });
  if (profile === null || profile.status !== 'confirmed' || profile.id !== plan.profileId || profile.revision !== plan.profileRevision)
    throw fail('PROFILE_CHANGED', '계획을 만든 뒤 개인 규칙이 바뀌었거나 꺼졌습니다. 다시 계획하세요.');
}

/** Re-issues a work grant for the saved root in this process; the folder must still be the same directory (dev/inode). */
async function regrant(stateDir: string, saved: GrantIdentity): Promise<RootGrant> {
  await assertStateDirOutside(stateDir, saved.canonicalPath);
  const grant = await issueRootGrant(saved.canonicalPath, { sessionId: saved.sessionId });
  if (grant.canonicalPath !== saved.canonicalPath || grant.device !== saved.device || grant.inode !== saved.inode) {
    revokeGrant(grant);
    throw fail('FILE_CHANGED', '작업 폴더가 바뀌었습니다(다른 폴더·링크로 교체). 다시 선택하고 계획하세요.');
  }
  return grant;
}

/** Stores plan + root identity in <state>/plans/<planId>.json. The grant must be the live grant the plan was built with. */
export async function savePlan(stateDir: string, planInput: unknown, grantInput: unknown): Promise<SavedPlan> {
  const plan = OperationPlanSchema.parse(planInput);
  if (planHash(plan) !== plan.id) throw fail('PLAN_CHANGED', '계획 내용이 계획 ID와 다릅니다.');
  const grant = await verifyGrant(grantInput, 'work', { sessionId: plan.sessionId });
  if (grant.id !== plan.rootGrantId || grant.canonicalPath !== plan.rootPath) throw fail('ROOT_FORBIDDEN', '계획과 다른 작업 폴더 권한입니다.');
  const dir = path.resolve(stateDir);
  await assertStateDirOutside(dir, grant.canonicalPath);
  await checkProfile(dir, plan);
  const saved: SavedPlan = { plan, grant: identity(grant) };
  await writeJsonAtomic(planFile(dir, plan.id), saved, SavedPlanSchema);
  return saved;
}

/** null when absent (or not a plan ID); STATE_CORRUPT when unreadable or off-contract; PLAN_CHANGED when content no longer hashes to its ID. */
export async function loadSavedPlan(stateDir: string, planId: string): Promise<SavedPlan | null> {
  if (typeof planId !== 'string' || !SHA.test(planId)) return null;
  const saved = await readJson(planFile(path.resolve(stateDir), planId), SavedPlanSchema);
  if (saved === null) return null;
  if (saved.plan.id !== planId || planHash(saved.plan) !== planId) throw fail('PLAN_CHANGED', '저장된 계획이 바뀌었습니다(변조 의심). 다시 계획하세요.');
  return { plan: saved.plan, grant: saved.grant };
}

async function planFor(stateDir: string, planId: string): Promise<SavedPlan> {
  let saved: SavedPlan | null;
  try { saved = await loadSavedPlan(stateDir, planId); }
  catch (error) { throw isAfoError(error, 'STATE_CORRUPT') ? fail('PLAN_CHANGED', '저장된 계획이 손상됐습니다. 다시 계획하세요.', error) : error; }
  if (saved === null) throw fail('PLAN_CHANGED', '저장된 계획을 찾을 수 없습니다. 다시 계획하세요.');
  return saved;
}

/**
 * Issues a one-time approval for exactly `operationIds` of one mode. `confirmation` must be the code the user typed
 * (approvalCode of this plan, these IDs and mode); permanent-delete also needs confirmPhrase '영구 삭제'.
 * Extra request fields (e.g. `approved: true`) are refused.
 */
export async function issueApproval(stateDir: string, input: ApprovalRequest & { now?: Date }): Promise<Approval> {
  const { now: nowInput, ...rest } = (input ?? {}) as ApprovalRequest & { now?: Date };
  const parsed = ApprovalRequestSchema.safeParse(rest);
  if (!parsed.success) throw fail('APPROVAL_INVALID', '승인 요청 형식이 올바르지 않습니다.', parsed.error);
  const request = parsed.data;
  const now = nowInput ?? new Date();
  const dir = path.resolve(stateDir);
  const { plan, grant } = await planFor(dir, request.planId);
  if (now.getTime() >= Date.parse(plan.expiresAt)) throw fail('APPROVAL_EXPIRED', '계획의 유효 시간이 지났습니다. 다시 계획하세요.');
  const operations = selectOperations(plan, request.operationIds, request.mode);
  const operationIds = operations.map((op) => op.id);
  if (request.confirmation !== approvalCode(plan.id, operationIds, request.mode)) throw fail('APPROVAL_INVALID', '승인 코드가 이 작업 묶음과 맞지 않습니다.');
  if (request.mode === 'permanent-delete' && request.confirmPhrase?.normalize('NFC') !== PERMANENT_DELETE_PHRASE)
    throw fail('APPROVAL_INVALID', `영구 삭제는 되돌릴 수 없습니다. 확인 문구 "${PERMANENT_DELETE_PHRASE}"를 정확히 입력해야 합니다.`);
  await checkProfile(dir, plan);
  revokeGrant(await regrant(dir, grant)); // root identity only; the consuming process issues its own grant
  const approval = ApprovalSchema.parse({ formatVersion: 1, id: randomUUID(), planId: plan.id, sessionId: plan.sessionId,
    rootGrantId: plan.rootGrantId, operationIds, mode: request.mode, profileId: plan.profileId, profileRevision: plan.profileRevision,
    issuedAt: now.toISOString(), expiresAt: new Date(Math.min(now.getTime() + APPROVAL_TTL_MS, Date.parse(plan.expiresAt))).toISOString(),
    usedAt: null });
  const secret = (await stateSecret(dir, true))!;
  const record: SavedApproval = { formatVersion: 1, approval, grant: identity(grant), mac: macOf(secret, approval, grant) };
  await writeJsonAtomic(approvalFile(dir, approval.id), record, SavedApprovalSchema);
  return approval;
}

/**
 * Verifies and consumes an approval, then returns the batch to execute. Order: record and MAC → expiry → used → plan hash and
 * binding → selection and mode → profile → root identity → atomic "used" marker (O_EXCL) and usedAt. Only one caller ever succeeds.
 */
export async function consumeApproval(stateDir: string, approvalId: string, now: Date = new Date()): Promise<ApprovedBatch> {
  const dir = path.resolve(stateDir);
  const id = OpaqueIdSchema.safeParse(approvalId);
  if (!id.success) throw fail('APPROVAL_MISSING', '승인 ID가 없거나 형식이 다릅니다.');
  let record: SavedApproval | null;
  try { record = await readJson(approvalFile(dir, id.data), SavedApprovalSchema); }
  catch (error) { throw isAfoError(error, 'STATE_CORRUPT') ? fail('APPROVAL_INVALID', '승인 기록이 손상됐거나 계약과 다릅니다.', error) : error; }
  if (record === null) throw fail('APPROVAL_MISSING', '승인 기록이 없습니다. 먼저 승인하세요.');
  const secret = await stateSecret(dir, false);
  const approval = record.approval;
  if (secret === null || !sameMac(record.mac, macOf(secret, approval, record.grant)) || approval.id !== id.data)
    throw fail('APPROVAL_INVALID', '이 서비스가 발급하지 않았거나 변조된 승인입니다.');
  if (now.getTime() >= Date.parse(approval.expiresAt)) throw fail('APPROVAL_EXPIRED', '승인 유효 시간(10분)이 지났습니다. 다시 승인하세요.');
  if (now.getTime() < Date.parse(approval.issuedAt)) throw fail('APPROVAL_INVALID', '승인 발급 시각보다 이른 시각입니다(시계 확인).');
  const marker = usedMarker(dir, approval.id);
  if (approval.usedAt !== null || await lstat(marker).then(() => true, (e: unknown) => fsCode(e) !== 'ENOENT'))
    throw fail('APPROVAL_USED', '이미 사용한 승인입니다. 다시 승인하세요.');
  const { plan, grant: savedGrant } = await planFor(dir, approval.planId);
  if (plan.sessionId !== approval.sessionId || plan.rootGrantId !== approval.rootGrantId || plan.profileId !== approval.profileId ||
      plan.profileRevision !== approval.profileRevision || canonicalJson(identity(savedGrant)) !== canonicalJson(identity(record.grant)))
    throw fail('PLAN_CHANGED', '승인과 저장된 계획이 맞지 않습니다.');
  const operations = selectOperations(plan, approval.operationIds, approval.mode);
  await checkProfile(dir, plan);
  const grant = await regrant(dir, savedGrant);
  try {
    const handle = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ usedAt: now.toISOString(), pid: process.pid })}\n`); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    revokeGrant(grant);
    if (fsCode(error) === 'EEXIST') throw fail('APPROVAL_USED', '이미 사용한 승인입니다. 다시 승인하세요.');
    throw fail('UNKNOWN', '승인 사용 표시를 기록하지 못해 실행하지 않습니다.', error);
  }
  // From here the approval is spent even if this write fails; the caller must not execute without a returned batch.
  const used = ApprovalSchema.parse({ ...approval, usedAt: now.toISOString() });
  await writeJsonAtomic(approvalFile(dir, approval.id), { ...record, approval: used }, SavedApprovalSchema);
  return { plan, approval: used, operations, grant, stateDir: dir };
}

import type { TestContext } from 'node:test';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalSchema, OperationPlanSchema, PlanOperationSchema } from '../packages/contracts/src/index.js';
import type { Approval, ApprovalMode, JournalEntry, OperationKind, OperationPlan, PlanOperation, RootGrant }
  from '../packages/contracts/src/index.js';
import { issueRootGrant } from '../packages/filesystem/src/grants.js';
import type { ApprovedBatch } from '../packages/filesystem/src/executor.js';
import { journalFile, readJournal } from '../packages/filesystem/src/state.js';
import { createFixture } from './fixtures/index.js';
import type { FixtureSpec } from './fixtures/index.js';

/**
 * Test-only ApprovedBatch builder. The real CLI path gets its batch from consumeApproval (#8); here plan, approval
 * and operations are built from real lstat/sha256 of a synthetic mkdtemp(os.tmpdir()) root, and a temp AFO state folder.
 */
export const F = 'afo-test-';
export interface Env { root: string; stateDir: string; grant: RootGrant }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const sha = async (file: string): Promise<string> => digest(await readFile(file));
export const abs = (env: Env, rel: string): string => path.join(env.root, ...rel.split('/'));

export async function setup(t: TestContext, spec: FixtureSpec = {}): Promise<Env> {
  const { root } = await createFixture(spec, t);
  const stateDir = await realpath(await mkdtemp(path.join(tmpdir(), `${F}state-`)));
  t.after(async () => {
    await chmod(path.join(stateDir, 'journal'), 0o700).catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true });
  });
  return { root, stateDir, grant: await issueRootGrant(root) };
}

let counter = 0;
/** Ids increase with creation order, so sorted approval ids run in the order the test created the operations. */
const nextId = (): string => (++counter).toString(16).padStart(8, '0');

export async function operation(env: Env, kind: OperationKind, source: string,
  more: { destination?: string; keeper?: string; hash?: boolean } = {}): Promise<PlanOperation> {
  const file = abs(env, source);
  const stat = await lstat(file, { bigint: true });
  const keeper = more.keeper ?? null;
  return PlanOperationSchema.parse({ id: nextId(), kind, fileId: digest(source), source, destination: more.destination ?? null,
    reason: '테스트 작업', ruleId: null, keeper,
    expected: { size: Number(stat.size), modifiedNs: String(stat.mtimeNs), device: String(stat.dev), inode: String(stat.ino),
      sha256: more.hash || keeper !== null ? await sha(file) : null } });
}

export function makePlan(env: Env, operations: PlanOperation[], deleteMode: 'trash' | 'permanent' = 'trash'): OperationPlan {
  const now = Date.now();
  const count = (kind: OperationKind): number => operations.filter((op) => op.kind === kind).length;
  const body = { formatVersion: 1, rootGrantId: env.grant.id, rootPath: env.grant.canonicalPath, sessionId: env.grant.sessionId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), profileId: null, profileRevision: null,
    deleteMode, operations, reviewItems: [],
    summary: { move: count('move'), trash: count('trash'), delete: count('delete'),
      logicalBytes: operations.reduce((sum, op) => sum + op.expected.size, 0) } };
  return OperationPlanSchema.parse({ ...body, id: digest(JSON.stringify(body)) });
}

export function makeApproval(plan: OperationPlan, operationIds: string[], mode: ApprovalMode, overrides: Partial<Approval> = {}): Approval {
  const now = Date.now();
  return ApprovalSchema.parse({ formatVersion: 1, id: randomUUID(), planId: plan.id, sessionId: plan.sessionId,
    rootGrantId: plan.rootGrantId, operationIds: [...operationIds].sort(), mode, profileId: null, profileRevision: null,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 9 * 60_000).toISOString(),
    usedAt: new Date(now).toISOString(), ...overrides });
}

export function makeBatch(env: Env, plan: OperationPlan, approval: Approval, operations?: PlanOperation[]): ApprovedBatch {
  const byId = new Map(plan.operations.map((op) => [op.id, op]));
  return { plan, approval, grant: env.grant, stateDir: env.stateDir,
    operations: operations ?? approval.operationIds.map((id) => byId.get(id)!) };
}

/** Plan containing exactly `ops`, approved as a whole in `mode`. */
export function approve(env: Env, ops: PlanOperation[], mode: ApprovalMode): ApprovedBatch {
  const plan = makePlan(env, ops, mode === 'permanent-delete' ? 'permanent' : 'trash');
  return makeBatch(env, plan, makeApproval(plan, ops.map((op) => op.id), mode));
}

export async function journal(env: Env, runId: string): Promise<JournalEntry[]> {
  const read = await readJournal(journalFile(env.stateDir, runId));
  if (!read || read.corrupt.length > 0) throw new Error('journal missing or corrupt');
  return read.entries;
}
export const phases = (entries: JournalEntry[]): string[] => entries.map((e) => `${e.opId}:${e.phase}${e.errorCode ? `:${e.errorCode}` : ''}`);
/** State folder content (top-level names), to prove a refused batch wrote nothing. */
export const stateNames = async (env: Env): Promise<string[]> => (await readdir(env.stateDir)).sort();
export const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

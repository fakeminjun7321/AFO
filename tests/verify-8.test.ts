/**
 * #8 verifier tests (independent of the builder's tests/approvals.test.ts and tests/plan.test.ts).
 * Synthetic temp data only: every work root and state folder is a fresh mkdtemp folder under os.tmpdir(); AFO_STATE_DIR is
 * pointed at that temp state folder for child processes. Expected plans, op IDs, hashes and approval codes are written or
 * recomputed here by hand (own canonical JSON + sha256); the product's canonicalJson/planHash/approvalCode are not used as oracles.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isAfoError } from '../packages/contracts/src/index.js';
import type { Approval, ApprovalMode, OperationPlan, PlanOperation, Preview, RootGrant, RuleProfileV2, ScanResult }
  from '../packages/contracts/src/index.js';
import { approvalChoices, buildPlan, buildPreview, chooseKeeper, diffPlans, selectOperations } from '../packages/engine/src/index.js';
import { hashCandidates, issueRootGrant, revokeGrant, scanRoot } from '../packages/filesystem/src/index.js';
import { consumeApproval, issueApproval, loadSavedPlan, savePlan } from '../packages/filesystem/src/approvals.js';
import { addCorrection, disableProfile, enableProfile, profileFile, removeCorrection, resetProfile, saveConfirmedProfile,
  setRuleEnabled } from '../packages/filesystem/src/profiles.js';
import { createFixture, createManifest } from './fixtures/index.js';

const run = promisify(execFile);
const posix = process.platform !== 'win32';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values: readonly string[]): string[] => [...values].sort(order);
const errorCode = (error: unknown): string => isAfoError(error) ? error.code : `non-AfoError:${(error as Error)?.name}`;
/** assert.rejects predicate: the AfoError code must be one of `codes`; any other error is reported with its code. */
const code = (...codes: string[]) => (error: unknown): boolean => {
  if (codes.includes(errorCode(error))) return true;
  throw new assert.AssertionError({ message: `expected ${codes.join('|')}, got ${errorCode(error)}: ${(error as Error)?.message}` });
};
/** Own canonical JSON (keys sorted at every level), written independently of the product's canonicalJson. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canon(v)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort(order).map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const myPlanId = (plan: OperationPlan): string => { const { id: _id, ...rest } = plan; return sha(canon(rest)); };
const myOpId = (op: PlanOperation): string => { const { id: _id, ...rest } = op; return sha(canon(rest)).slice(0, 16); };
const myCode = (planId: string, ids: readonly string[], mode: ApprovalMode): string => sha(JSON.stringify([planId, sorted(ids), mode])).slice(0, 8);

/* ---------- fixture ---------- */
const NFD = 'café.txt';
const WORK: Record<string, string> = {
  'a.pdf': 'dup-one', 'b.pdf': 'dup-one',                         // group 1 (7 B): keeper a.pdf (path order)
  'x.jpg': 'dup-two!', 'y.jpg': 'dup-two!', 'z.jpg': 'dup-two!',   // group 2 (8 B): keeper x.jpg
  'song.mp3': 'music', 'movie.mp4': 'movie-bytes', '한글 파일.hwp': 'hangul', memo: 'no ext',
  'same.txt': 'one', 'sub/same.txt': 'two',                       // same destination 문서/same.txt → both review
  '문서/existing.pdf': 'already',                                  // already placed; 7 B like group 1 but other content
  'Note.md': 'note', '문서/note.md': 'old note',                    // case-only clash with an existing file → review
  [NFD]: 'c1', '문서/café.txt': 'c2',                               // NFD vs NFC clash with an existing file → review
};
/** Hand-written expectation for 'all-duplicates' (kinds per delete mode added by the test). */
const EXPECTED_DELETES: Record<string, string> = { 'b.pdf': 'a.pdf', 'y.jpg': 'x.jpg', 'z.jpg': 'x.jpg' };
const EXPECTED_MOVES: Record<string, string> = { 'movie.mp4': '영상/movie.mp4', 'song.mp3': '음악/song.mp3', '한글 파일.hwp': '문서/한글 파일.hwp' };
const EXPECTED_REVIEW: Record<string, 'keep' | 'review'> = { 'a.pdf': 'keep', 'x.jpg': 'keep', memo: 'review', 'same.txt': 'review',
  'sub/same.txt': 'review', '문서/existing.pdf': 'keep', 'Note.md': 'review', '문서/note.md': 'keep', [NFD]: 'review', '문서/café.txt': 'keep' };
const EXPECTED_BYTES = 7 + 8 + 8 + 11 + 5 + 6;

const PROFILE: RuleProfileV2 = { formatVersion: 2, id: 'verify-8-profile', revision: 1, status: 'confirmed', referenceRootId: null,
  referenceRootLabel: null, rules: [{ id: 'rule-mp3', extension: '.mp3', keyword: null, targetDirectory: '내 음악',
    evidence: ['m/1.mp3', 'm/2.mp3'], evidenceCount: 2, enabled: true }], corrections: [], updatedAt: '2026-10-26T00:00:00.000Z' };

interface Env { base: string; work: string; state: string; grant: RootGrant; scan: ScanResult; preview: Preview; plan: OperationPlan; now: Date }
async function analyze(grant: RootGrant, state: string, withProfile: boolean): Promise<{ scan: ScanResult; preview: Preview }> {
  const scan = await hashCandidates(grant, await scanRoot(grant));
  const raw = withProfile ? JSON.parse(await readFile(profileFile(state), 'utf8')) as { profile: RuleProfileV2 } : null;
  return { scan, preview: buildPreview(scan, raw ? { profile: raw.profile } : {}) };
}
async function setup(t: TestContext, o: { deleteMode?: 'trash' | 'permanent'; profile?: boolean; now?: Date; save?: boolean } = {}): Promise<Env> {
  const spec: Record<string, string> = { 'state/': '' };
  for (const [k, v] of Object.entries(WORK)) spec[`work/${k}`] = v;
  const { root: base } = await createFixture(spec, t);
  const work = path.join(base, 'work'); const state = path.join(base, 'state');
  if (o.profile) await saveConfirmedProfile(PROFILE, { stateDir: state });
  const grant = await issueRootGrant(work);
  const { scan, preview } = await analyze(grant, state, o.profile ?? false);
  const now = o.now ?? new Date();
  const plan = buildPlan(preview, { scan, grant, sessionId: grant.sessionId, deleteMode: o.deleteMode ?? 'trash',
    deleteSelections: 'all-duplicates', now });
  if (o.save ?? true) await savePlan(state, plan, grant);
  return { base, work, state, grant, scan, preview, plan, now };
}
const idsOf = (plan: OperationPlan, kind: PlanOperation['kind']): string[] => sorted(plan.operations.filter((op) => op.kind === kind).map((op) => op.id));
const opOf = (plan: OperationPlan, source: string): PlanOperation => {
  const op = plan.operations.find((o) => o.source === source);
  assert.ok(op, `operation for ${source}`);
  return op;
};
function approve(state: string, plan: OperationPlan, mode: ApprovalMode, ids: string[], extra: Record<string, unknown> = {}): Promise<Approval> {
  return issueApproval(state, { planId: plan.id, operationIds: ids, mode, confirmation: myCode(plan.id, ids, mode),
    ...(mode === 'permanent-delete' ? { confirmPhrase: '영구 삭제' } : {}), ...extra } as Parameters<typeof issueApproval>[1]);
}
const recordPath = (state: string, id: string): string => path.join(state, 'approvals', `${id}.json`);
const planPath = (state: string, id: string): string => path.join(state, 'plans', `${id}.json`);
const readJsonFile = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
type Rec = { formatVersion: 1; approval: Approval; grant: Record<string, string>; mac: string };

/* ---------- plan content and determinism ---------- */

test('V8-P1 plan from real temp files matches the hand-written plan; IDs recompute independently', async (t) => {
  for (const [deleteMode, kind] of [['trash', 'trash'], ['permanent', 'delete']] as const) {
    const { plan, grant } = await setup(t, { deleteMode, save: false });
    const ops = Object.fromEntries(plan.operations.map((op) => [op.source, op]));
    assert.deepEqual(sorted(Object.keys(ops)), sorted([...Object.keys(EXPECTED_DELETES), ...Object.keys(EXPECTED_MOVES)]));
    for (const [source, keeper] of Object.entries(EXPECTED_DELETES))
      assert.deepEqual([ops[source]!.kind, ops[source]!.keeper, ops[source]!.destination], [kind, keeper, null], source);
    for (const [source, destination] of Object.entries(EXPECTED_MOVES))
      assert.deepEqual([ops[source]!.kind, ops[source]!.destination, ops[source]!.keeper], ['move', destination, null], source);
    assert.deepEqual(Object.fromEntries(plan.reviewItems.map((r) => [r.source, r.status])), EXPECTED_REVIEW);
    assert.deepEqual(plan.summary, { move: 3, trash: kind === 'trash' ? 3 : 0, delete: kind === 'delete' ? 3 : 0, logicalBytes: EXPECTED_BYTES });
    // expected identity is the real file's lstat (size, mtime ns, dev, ino) and, for duplicates, the real sha256.
    for (const op of plan.operations) {
      const st = await stat(path.join(grant.canonicalPath, op.source), { bigint: true });
      assert.deepEqual([op.expected.size, op.expected.modifiedNs, op.expected.device, op.expected.inode],
        [Number(st.size), String(st.mtimeNs), String(st.dev), String(st.ino)], op.source);
      if (op.kind !== 'move') assert.equal(op.expected.sha256, sha(WORK[op.source]!));
      assert.equal(op.id, myOpId(op), `op id = sha256(canonical op without id)[0..16] for ${op.source}`);
      assert.ok(op.reason.length > 0);
    }
    assert.equal(plan.id, myPlanId(plan), 'plan id = sha256(canonical plan without id)');
    assert.equal(plan.deleteMode, deleteMode);
    assert.deepEqual([plan.rootGrantId, plan.rootPath, plan.sessionId, plan.profileId, plan.profileRevision],
      [grant.id, grant.canonicalPath, grant.sessionId, null, null]);
    assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 60 * 60 * 1000);
    // Mode ↔ kind is 1:1 and the offered codes are the hand-computed ones.
    const choices = Object.fromEntries(approvalChoices(plan).map((c) => [c.mode, c]));
    const delMode = kind === 'trash' ? 'trash' : 'permanent-delete';
    assert.deepEqual(sorted(Object.keys(choices)), sorted(['organize', delMode]));
    assert.deepEqual(choices['organize']!.operationIds, idsOf(plan, 'move'));
    assert.deepEqual(choices[delMode]!.operationIds, idsOf(plan, kind));
    for (const c of Object.values(choices)) assert.equal(c.code, myCode(plan.id, c.operationIds, c.mode));
  }
});

test('V8-P2 determinism: same files + same grant + same now → same plan ID (rescan included); time, mode and grant change it', async (t) => {
  const env = await setup(t, { save: false });
  const again = await analyze(env.grant, env.state, false);
  const rebuilt = buildPlan(JSON.parse(JSON.stringify(again.preview)), { scan: JSON.parse(JSON.stringify(again.scan)), grant: env.grant,
    sessionId: env.grant.sessionId, deleteMode: 'trash', deleteSelections: 'all-duplicates', now: new Date(env.now.getTime()) });
  assert.deepEqual(rebuilt, env.plan);
  const variant = (over: Partial<Parameters<typeof buildPlan>[1]>): string => buildPlan(env.preview, { scan: env.scan, grant: env.grant,
    sessionId: env.grant.sessionId, deleteMode: 'trash', deleteSelections: 'all-duplicates', now: env.now, ...over }).id;
  assert.notEqual(variant({ now: new Date(env.now.getTime() + 1) }), env.plan.id);
  assert.notEqual(variant({ deleteMode: 'permanent' }), env.plan.id);
  assert.notEqual(variant({ deleteSelections: [] }), env.plan.id);
  const regrant = await issueRootGrant(env.work);
  assert.notEqual(buildPlan(env.preview, { scan: env.scan, grant: regrant, sessionId: regrant.sessionId, deleteMode: 'trash',
    deleteSelections: 'all-duplicates', now: env.now }).id, env.plan.id, 're-selected folder → new grant ID → new plan');
  // Cancelled analysis and a scan/preview from another root are refused.
  await assert.rejects(async () => buildPlan({ ...env.preview, cancelled: true }, { scan: { ...env.scan, cancelled: true, complete: false },
    grant: env.grant, sessionId: env.grant.sessionId, deleteMode: 'trash', now: env.now }), code('CANCELLED'), 'cancelled scan');
  await assert.rejects(async () => buildPlan({ ...env.preview, cancelled: true }, { scan: env.scan, grant: env.grant,
    sessionId: env.grant.sessionId, deleteMode: 'trash', now: env.now }), code('CANCELLED'), 'cancelled preview');
  await assert.rejects(async () => buildPlan(env.preview, { scan: env.scan, grant: env.grant, sessionId: 'other-session-1', deleteMode: 'trash',
    now: env.now }), code('ROOT_FORBIDDEN'));
});

test('V8-P3 file change → only that operation gets a new ID (diffPlans); the old approval never applies to the new plan', async (t) => {
  const env = await setup(t);
  const oldMoves = idsOf(env.plan, 'move');
  const old = await approve(env.state, env.plan, 'organize', oldMoves);
  await writeFile(path.join(env.work, 'movie.mp4'), 'movie-bytes-edited');
  const { scan, preview } = await analyze(env.grant, env.state, false);
  const next = buildPlan(preview, { scan, grant: env.grant, sessionId: env.grant.sessionId, deleteMode: 'trash',
    deleteSelections: 'all-duplicates', now: env.now });
  await savePlan(env.state, next, env.grant);
  assert.notEqual(next.id, env.plan.id);
  const diff = diffPlans(env.plan, next);
  assert.deepEqual(diff.added, [opOf(next, 'movie.mp4').id]);
  assert.deepEqual(diff.removed, [opOf(env.plan, 'movie.mp4').id]);
  assert.deepEqual(diff.unchanged, sorted(env.plan.operations.filter((o) => o.source !== 'movie.mp4').map((o) => o.id)));
  assert.deepEqual([diff.rootChanged, diff.profileChanged, diff.deleteModeChanged], [false, false, false]);
  // New plan: old IDs / old code are refused; the new batch needs its own code.
  await assert.rejects(issueApproval(env.state, { planId: next.id, operationIds: oldMoves, mode: 'organize',
    confirmation: myCode(next.id, oldMoves, 'organize') }), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(env.state, { planId: next.id, operationIds: idsOf(next, 'move'), mode: 'organize',
    confirmation: myCode(env.plan.id, oldMoves, 'organize') }), code('APPROVAL_INVALID'));
  // The old approval stays bound to the old plan only. consumeApproval does not re-stat files: the batch still carries the
  // old expected size/mtime, which the executor (#10) must compare with the real file before acting.
  const batch = await consumeApproval(env.state, old.id);
  assert.equal(batch.plan.id, env.plan.id);
  const movie = batch.operations.find((o) => o.source === 'movie.mp4')!;
  assert.equal(movie.expected.size, 11);
  assert.equal((await stat(path.join(env.work, 'movie.mp4'))).size, 18, 'real file differs from the approved expectation');
  assert.ok(!batch.operations.some((o) => next.operations.some((n) => n.id === o.id && n.source === 'movie.mp4')));
});

/* ---------- missing / forged / expired / reused ---------- */

test('V8-A1 missing approval and malformed IDs → APPROVAL_MISSING; nothing is created', async (t) => {
  const { state } = await setup(t);
  for (const id of [randomUUID(), '', '../plans/x', 'A'.repeat(36), 'a'.repeat(200), 'secret', 'x/../y'])
    await assert.rejects(consumeApproval(state, id), code('APPROVAL_MISSING'), JSON.stringify(id));
  await assert.rejects(consumeApproval(state, 42 as unknown as string), code('APPROVAL_MISSING'));
  await assert.rejects(readdir(path.join(state, 'approvals')), { code: 'ENOENT' }, 'no approvals folder before any issue');
});

test('V8-A2 forged records: hand-written JSON, edited fields, foreign or missing secret are all APPROVAL_INVALID', async (t) => {
  const env = await setup(t);
  const { state, plan } = env;
  const trash = idsOf(plan, 'trash');
  const real = await approve(state, plan, 'trash', [trash[0]!]);
  const rec = await readJsonFile<Rec>(recordPath(state, real.id));
  // 1. Entirely hand-written, schema-valid record for the valid saved plan (no MAC computation attempted).
  const handId = randomUUID();
  const now = new Date();
  await writeFile(recordPath(state, handId), JSON.stringify({ formatVersion: 1, mac: '0'.repeat(64), grant: rec.grant,
    approval: { formatVersion: 1, id: handId, planId: plan.id, sessionId: plan.sessionId, rootGrantId: plan.rootGrantId, operationIds: trash,
      mode: 'trash', profileId: null, profileRevision: null, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      usedAt: null } }));
  await assert.rejects(consumeApproval(state, handId), code('APPROVAL_INVALID'), 'hand-written');
  // 2. Copy of a real record under a new ID, keeping its real MAC.
  const copyId = randomUUID();
  await writeFile(recordPath(state, copyId), JSON.stringify({ ...rec, approval: { ...rec.approval, id: copyId } }));
  await assert.rejects(consumeApproval(state, copyId), code('APPROVAL_INVALID'), 'copied MAC');
  // 3. Field edits on the real record, MAC left as is.
  const edits: Array<[string, Partial<Approval>]> = [
    ['widen ops', { operationIds: trash }], ['mode', { mode: 'organize', operationIds: idsOf(plan, 'move') }],
    ['extend expiry', { issuedAt: new Date(Date.parse(rec.approval.issuedAt) + 300_000).toISOString(),
      expiresAt: new Date(Date.parse(rec.approval.expiresAt) + 300_000).toISOString() }],
    ['session', { sessionId: 'forged-session-1' }], ['profile', { profileId: 'p', profileRevision: 1 }]];
  for (const [label, change] of edits) {
    await writeFile(recordPath(state, real.id), JSON.stringify({ ...rec, approval: { ...rec.approval, ...change } }));
    await assert.rejects(consumeApproval(state, real.id), code('APPROVAL_INVALID'), label);
  }
  await writeFile(recordPath(state, real.id), JSON.stringify({ ...rec, grant: { ...rec.grant, inode: '1' } }));
  await assert.rejects(consumeApproval(state, real.id), code('APPROVAL_INVALID'), 'grant identity');
  await writeFile(recordPath(state, real.id), JSON.stringify({ ...rec, approval: { ...rec.approval, approved: true } }));
  await assert.rejects(consumeApproval(state, real.id), code('APPROVAL_INVALID'), 'extra key in record');
  await writeFile(recordPath(state, real.id), JSON.stringify(rec));
  // 4. Secret from another state folder: approval issued there for the same plan, then copied here (and vice versa).
  const other = path.join(env.base, 'state-other');
  await savePlan(other, plan, env.grant);
  const foreign = await approve(other, plan, 'trash', [trash[1]!]);
  await writeFile(recordPath(state, foreign.id), await readFile(recordPath(other, foreign.id)));
  await assert.rejects(consumeApproval(state, foreign.id), code('APPROVAL_INVALID'), 'record signed by another state folder');
  const mine = await readFile(path.join(state, 'secret'));
  await writeFile(path.join(state, 'secret'), await readFile(path.join(other, 'secret')));
  await assert.rejects(consumeApproval(state, real.id), code('APPROVAL_INVALID'), 'secret replaced by another folder secret');
  await writeFile(path.join(state, 'secret'), mine);
  // 5. Secret deleted → refused; a later issue creates a new secret and the old approval stays invalid.
  await rm(path.join(state, 'secret'));
  await assert.rejects(consumeApproval(state, real.id), code('APPROVAL_INVALID'), 'secret deleted');
  const fresh = await approve(state, plan, 'trash', [trash[2]!]);
  await assert.rejects(consumeApproval(state, real.id), code('APPROVAL_INVALID'), 'old approval under a new secret');
  assert.deepEqual((await consumeApproval(state, fresh.id)).operations.map((o) => o.id), [trash[2]]);
  // 6. Secret readable by others or replaced by a link → refused (not consumed).
  if (posix) {
    const another = await approve(state, plan, 'organize', idsOf(plan, 'move'));
    await chmod(path.join(state, 'secret'), 0o644);
    await assert.rejects(consumeApproval(state, another.id), code('STATE_CORRUPT', 'APPROVAL_INVALID'), 'secret 0644');
    await chmod(path.join(state, 'secret'), 0o600);
    const saved = await readFile(path.join(state, 'secret'));
    await rm(path.join(state, 'secret'));
    await writeFile(path.join(env.base, 'secret-elsewhere'), saved, { mode: 0o600 });
    await symlink(path.join(env.base, 'secret-elsewhere'), path.join(state, 'secret'));
    await assert.rejects(consumeApproval(state, another.id), code('STATE_CORRUPT', 'APPROVAL_INVALID'), 'secret is a link');
    await rm(path.join(state, 'secret')); await writeFile(path.join(state, 'secret'), saved, { mode: 0o600 });
    assert.equal((await consumeApproval(state, another.id)).approval.id, another.id, 'restored secret → still unused and valid');
  }
});

test('V8-A3 expiry with injected clock: +10 min is the limit, never past the plan; expired plans cannot be approved', async (t) => {
  const { state, plan, now } = await setup(t);
  const moves = idsOf(plan, 'move');
  const t0 = new Date(now.getTime() + 1000);
  const a = await approve(state, plan, 'organize', moves, { now: t0 });
  assert.deepEqual([a.issuedAt, a.expiresAt, a.usedAt], [t0.toISOString(), new Date(t0.getTime() + 600_000).toISOString(), null]);
  await assert.rejects(consumeApproval(state, a.id, new Date(t0.getTime() + 600_000)), code('APPROVAL_EXPIRED'), 'exactly +10 min');
  await assert.rejects(consumeApproval(state, a.id, new Date(t0.getTime() - 1)), code('APPROVAL_INVALID'), 'clock before issue');
  assert.equal((await consumeApproval(state, a.id, new Date(t0.getTime() + 599_999))).approval.usedAt,
    new Date(t0.getTime() + 599_999).toISOString(), 'last valid millisecond');
  // Near the end of the plan the approval ends with the plan.
  const late = new Date(Date.parse(plan.expiresAt) - 120_000);
  const b = await approve(state, plan, 'organize', moves, { now: late });
  assert.equal(b.expiresAt, plan.expiresAt);
  await assert.rejects(consumeApproval(state, b.id, new Date(plan.expiresAt)), code('APPROVAL_EXPIRED'));
  await assert.rejects(approve(state, plan, 'organize', moves, { now: new Date(plan.expiresAt) }), code('APPROVAL_EXPIRED'));
  // A plan created two hours ago cannot be approved now.
  const stale = await setup(t, { now: new Date(Date.now() - 2 * 60 * 60 * 1000) });
  await assert.rejects(approve(stale.state, stale.plan, 'organize', idsOf(stale.plan, 'move')), code('APPROVAL_EXPIRED'));
});

test('V8-A4 reuse: second consume, JSON rolled back to unused, marker kept → APPROVAL_USED', async (t) => {
  const { state, plan } = await setup(t);
  const a = await approve(state, plan, 'trash', idsOf(plan, 'trash'));
  const unused = await readFile(recordPath(state, a.id));
  await consumeApproval(state, a.id);
  await assert.rejects(consumeApproval(state, a.id), code('APPROVAL_USED'));
  const used = await readJsonFile<Rec>(recordPath(state, a.id));
  assert.notEqual(used.approval.usedAt, null);
  assert.ok((await readdir(path.join(state, 'approvals'))).includes(`${a.id}.used`), 'O_EXCL marker written');
  await writeFile(recordPath(state, a.id), unused);
  await assert.rejects(consumeApproval(state, a.id), code('APPROVAL_USED'), 'JSON rolled back to usedAt null');
  // Threat-model limit (recorded, not asserted): a writer that removes the marker AND rolls back the JSON can consume again.
  await rm(path.join(state, 'approvals', `${a.id}.used`));
  const outcome = await consumeApproval(state, a.id).then(() => 'consumed again', (e: unknown) => errorCode(e));
  t.diagnostic(`marker removed + JSON rolled back → ${outcome}`);
});

test('V8-A5 concurrent consumption: 8 in-process calls and 2 child processes each succeed exactly once', async (t) => {
  const { state, plan } = await setup(t);
  const a = await approve(state, plan, 'trash', idsOf(plan, 'trash'));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeApproval(state, a.id)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => errorCode((r as PromiseRejectedResult).reason)),
    Array(7).fill('APPROVAL_USED'));
  const moduleUrl = new URL('../packages/filesystem/src/approvals.js', import.meta.url).href;
  // Both children wait for the same wall-clock instant, then consume.
  const script = `const { consumeApproval } = await import(process.argv[1]);
const start = Number(process.argv[3]); while (Date.now() < start) await new Promise((r) => setTimeout(r, 1));
try { const b = await consumeApproval(process.env.AFO_STATE_DIR, process.argv[2]); console.log('ok ' + b.operations.length); }
catch (e) { console.log('err ' + e.code); }`;
  for (let round = 0; round < 3; round += 1) {
    const b = await approve(state, plan, 'trash', idsOf(plan, 'trash'));
    const start = String(Date.now() + 700);
    const child = (): Promise<string> => run(process.execPath, ['--input-type=module', '-e', script, moduleUrl, b.id, start],
      { env: { ...process.env, AFO_STATE_DIR: state } }).then((r) => r.stdout.trim());
    assert.deepEqual((await Promise.all([child(), child()])).sort(), ['err APPROVAL_USED', 'ok 3'], `round ${round}`);
  }
});

test('V8-A6 concurrent first issue in a fresh state folder: every approval verifies (one shared secret)', async (t) => {
  const { state, plan } = await setup(t);
  const trash = idsOf(plan, 'trash');
  const issued = await Promise.all(trash.map((id) => approve(state, plan, 'trash', [id])));
  for (const a of issued) assert.equal((await consumeApproval(state, a.id)).operations.length, 1);
});

/* ---------- plan file tampering and root / state folder ---------- */

test('V8-T1 saved plan tampering → PLAN_CHANGED; restoring the original makes the approval usable', async (t) => {
  const env = await setup(t);
  const { state, plan } = env;
  const file = planPath(state, plan.id);
  const original = await readFile(file, 'utf8');
  const a = await approve(state, plan, 'trash', idsOf(plan, 'trash'));
  type Saved = { plan: OperationPlan; grant: Record<string, string> };
  const tamper = async (label: string, change: (s: Saved) => void, codes = ['PLAN_CHANGED']): Promise<void> => {
    const s = JSON.parse(original) as Saved;
    change(s);
    await writeFile(file, JSON.stringify(s));
    await assert.rejects(consumeApproval(state, a.id), code(...codes), label);
  };
  const extra = (s: Saved): void => {
    const z = s.plan.operations.find((o) => o.source === 'z.jpg')!;
    const clone = { ...z, source: 'memo', fileId: s.plan.reviewItems.find((r) => r.source === 'memo')!.fileId, keeper: 'x.jpg' };
    s.plan.reviewItems = s.plan.reviewItems.filter((r) => r.source !== 'memo');
    clone.id = myOpId(clone); s.plan.operations.push(clone);
    s.plan.summary.trash += 1; s.plan.summary.logicalBytes += clone.expected.size;
  };
  await tamper('operation added', extra);
  await tamper('destination changed', (s) => { s.plan.operations.find((o) => o.kind === 'move')!.destination = '다른곳/x.bin'; });
  await tamper('keeper changed', (s) => { s.plan.operations.find((o) => o.source === 'y.jpg')!.keeper = 'z.jpg'; },
    ['PLAN_CHANGED']); // also a schema violation (keeper is another op's source) → STATE_CORRUPT mapped to PLAN_CHANGED
  await tamper('keeper changed to a non-op file', (s) => { s.plan.operations.find((o) => o.source === 'y.jpg')!.keeper = 'memo'; });
  await tamper('op added + id recomputed, saved under the original name', (s) => { extra(s); s.plan.id = myPlanId(s.plan); });
  await tamper('expected size changed + id recomputed', (s) => { s.plan.operations[0]!.expected.size += 1; s.plan.summary.logicalBytes += 1;
    s.plan.id = myPlanId(s.plan); });
  await tamper('grant inode changed', (s) => { s.grant['inode'] = '1'; });
  await tamper('grant device changed', (s) => { s.grant['device'] = '999'; });
  await tamper('grant path changed', (s) => { s.grant['canonicalPath'] = env.base; s.plan.rootPath = env.base; s.plan.id = myPlanId(s.plan); });
  await writeFile(file, '{"plan":');
  await assert.rejects(consumeApproval(state, a.id), code('PLAN_CHANGED'), 'truncated');
  // Tampered plan saved under its new (consistent) ID: the approval still names the old ID, which is missing.
  const moved = JSON.parse(original) as Saved; extra(moved); moved.plan.id = myPlanId(moved.plan);
  await rm(file); await writeFile(planPath(state, moved.plan.id), JSON.stringify(moved));
  await assert.rejects(consumeApproval(state, a.id), code('PLAN_CHANGED'), 'plan missing');
  // Recorded, not asserted: plan files carry no MAC, so a schema-valid, hash-consistent plan written by hand into plans/ can be approved
  // (the approval code is public: sha256 of plan ID, IDs and mode). Same threat class as V8-A4 (a writer of the state folder).
  const handPlan = await approve(state, moved.plan, 'trash', idsOf(moved.plan, 'trash')).then(() => 'approval issued', (e: unknown) => errorCode(e));
  t.diagnostic(`hand-written plan file in plans/ → ${handPlan}`);
  await writeFile(file, original);
  const batch = await consumeApproval(state, a.id);
  assert.deepEqual(batch.operations.map((o) => o.source).sort(order), ['b.pdf', 'y.jpg', 'z.jpg']);
});

test('V8-T2 work root replaced (rename+mkdir, link, removal) → refused; same folder back in place → accepted', async (t) => {
  const env = await setup(t);
  const { state, plan, work } = env;
  const a = await approve(state, plan, 'organize', idsOf(plan, 'move'));
  await rename(work, `${work}-old`);
  await mkdir(work);
  await assert.rejects(consumeApproval(state, a.id), code('FILE_CHANGED'), 'rename + mkdir');
  await assert.rejects(approve(state, plan, 'organize', idsOf(plan, 'move')), code('FILE_CHANGED'), 'issue after rename + mkdir');
  await rm(work, { recursive: true });
  await assert.rejects(consumeApproval(state, a.id), code('FILE_CHANGED', 'ROOT_FORBIDDEN'), 'root missing');
  if (posix) {
    await symlink(`${work}-old`, work);
    await assert.rejects(consumeApproval(state, a.id), code('FILE_CHANGED', 'ROOT_FORBIDDEN'), 'root replaced by a link to the old folder');
    await rm(work);
  }
  await rename(`${work}-old`, work);
  assert.equal((await consumeApproval(state, a.id)).approval.id, a.id, 'original folder back → refusals were not consumption');
});

test('V8-T3 state folder inside / around the work root is refused at save, issue and consume; nothing written into the root', async (t) => {
  const env = await setup(t);
  const { state, plan, grant, work, base } = env;
  const before = await createManifest(work);
  await assert.rejects(savePlan(path.join(work, '.afo-state'), plan, grant), code('STATE_DIR_CONFLICT'), 'inside');
  await assert.rejects(savePlan(work, plan, grant), code('STATE_DIR_CONFLICT'), 'equal');
  await assert.rejects(savePlan(base, plan, grant), code('STATE_DIR_CONFLICT'), 'containing');
  assert.deepEqual(await createManifest(work), before, 'refused saves wrote nothing into the root');
  // A state folder copied into the root (and one reached through a link from outside) cannot consume.
  const a = await approve(state, plan, 'organize', idsOf(plan, 'move'));
  const inside = path.join(work, 'copied-state');
  await cp(state, inside, { recursive: true });
  await assert.rejects(consumeApproval(inside, a.id), code('STATE_DIR_CONFLICT'), 'copy inside root');
  await assert.rejects(approve(inside, plan, 'organize', idsOf(plan, 'move')), code('STATE_DIR_CONFLICT'), 'issue inside root');
  if (posix) {
    await symlink(inside, path.join(base, 'state-link'));
    await assert.rejects(consumeApproval(path.join(base, 'state-link'), a.id), code('STATE_DIR_CONFLICT'), 'link to inside');
  }
  assert.deepEqual((await readdir(path.join(inside, 'approvals'))).filter((n) => n.endsWith('.used')), [], 'no marker inside the root');
  await rm(inside, { recursive: true });
  assert.deepEqual(await createManifest(work), before);
  assert.equal((await consumeApproval(state, a.id)).approval.id, a.id);
  // Foreign / forged grants at save.
  await assert.rejects(savePlan(state, plan, { ...grant, inode: '1' }), code('ROOT_FORBIDDEN'));
  await assert.rejects(savePlan(state, plan, await issueRootGrant(work)), code('ROOT_FORBIDDEN'), 'another grant for the same folder');
  await assert.rejects(savePlan(state, { ...plan, expiresAt: new Date(Date.parse(plan.expiresAt) - 1).toISOString() }, grant),
    code('PLAN_CHANGED'), 'content differs from ID');
  // Schema-invalid plan input is refused, but as a raw ZodError rather than an AfoError code (recorded).
  const invalid = await savePlan(state, { ...plan, deleteMode: 'permanent' }, grant).then(() => 'saved', (e: unknown) => errorCode(e));
  t.diagnostic(`schema-invalid plan at savePlan → ${invalid}`);
  assert.notEqual(invalid, 'saved');
});

/* ---------- mode, codes, interface input ---------- */

test('V8-M1 mode binding: mixed or wrong-kind selections are MODE_MISMATCH; each mode yields only its kind', async (t) => {
  const tr = await setup(t);
  const pd = await setup(t, { deleteMode: 'permanent' });
  const cases: Array<[Env, ApprovalMode, string[]]> = [
    [tr, 'organize', [...idsOf(tr.plan, 'move'), ...idsOf(tr.plan, 'trash')]], [tr, 'trash', [...idsOf(tr.plan, 'trash'), idsOf(tr.plan, 'move')[0]!]],
    [tr, 'trash', idsOf(tr.plan, 'move')], [tr, 'permanent-delete', idsOf(tr.plan, 'trash')], [tr, 'organize', idsOf(tr.plan, 'trash')],
    [pd, 'trash', idsOf(pd.plan, 'delete')], [pd, 'organize', idsOf(pd.plan, 'delete')], [pd, 'permanent-delete', idsOf(pd.plan, 'move')]];
  for (const [env, mode, ids] of cases)
    await assert.rejects(approve(env.state, env.plan, mode, ids), code('MODE_MISMATCH'), `${env.plan.deleteMode}/${mode}`);
  for (const [env, mode, kind] of [[tr, 'organize', 'move'], [tr, 'trash', 'trash'], [pd, 'organize', 'move'], [pd, 'permanent-delete', 'delete']] as const) {
    const batch = await consumeApproval(env.state, (await approve(env.state, env.plan, mode, idsOf(env.plan, kind))).id);
    assert.deepEqual([...new Set(batch.operations.map((o) => o.kind))], [kind]);
    assert.equal(batch.approval.mode, mode);
    assert.deepEqual(batch.operations.map((o) => o.id), idsOf(env.plan, kind));
  }
});

test('V8-M2 permanent deletion needs the exact phrase; wrong codes (1 hex off, other mode/plan, upper case) are refused', async (t) => {
  const pd = await setup(t, { deleteMode: 'permanent' });
  const del = idsOf(pd.plan, 'delete');
  const good = myCode(pd.plan.id, del, 'permanent-delete');
  const req = (over: Record<string, unknown>) => issueApproval(pd.state, { planId: pd.plan.id, operationIds: del, mode: 'permanent-delete',
    confirmation: good, ...over } as Parameters<typeof issueApproval>[1]);
  for (const phrase of [undefined, '', '영구삭제', '영구 삭제 ', ' 영구 삭제', '영구  삭제', '영구 삭제함', 'permanent-delete', '삭제'])
    await assert.rejects(req(phrase === undefined ? {} : { confirmPhrase: phrase }), code('APPROVAL_INVALID'), JSON.stringify(phrase));
  const flipped = good.slice(0, 7) + (good[7] === '0' ? '1' : '0');
  for (const confirmation of [flipped, good.toUpperCase(), myCode(pd.plan.id, del, 'trash'), myCode('f'.repeat(64), del, 'permanent-delete'),
    myCode(pd.plan.id, del.slice(1), 'permanent-delete'), good.slice(0, 7), `${good}0`])
    await assert.rejects(req({ confirmPhrase: '영구 삭제', confirmation }), code('APPROVAL_INVALID'), confirmation);
  // The code is order-insensitive (computed over sorted IDs) and the stored IDs are sorted.
  const ok = await req({ confirmPhrase: '영구 삭제', operationIds: [...del].reverse() });
  assert.deepEqual(ok.operationIds, del);
  // Decomposed Hangul (NFD) of the phrase is NFC-normalised and accepted: recorded behaviour.
  const nfd = await req({ confirmPhrase: '영구 삭제'.normalize('NFD') }).then(() => 'accepted', (e: unknown) => errorCode(e));
  t.diagnostic(`NFD phrase → ${nfd}`);
  // Trash and organize need no phrase but still need the code.
  const tr = await setup(t);
  await assert.rejects(issueApproval(tr.state, { planId: tr.plan.id, operationIds: idsOf(tr.plan, 'trash'), mode: 'trash',
    confirmation: myCode(tr.plan.id, idsOf(tr.plan, 'move'), 'trash') }), code('APPROVAL_INVALID'));
});

test('V8-M3 interface input is strict: approved:true, paths, usedAt etc. never create an approval', async (t) => {
  const { state, plan } = await setup(t);
  const ids = idsOf(plan, 'trash');
  const base = { planId: plan.id, operationIds: ids, mode: 'trash', confirmation: myCode(plan.id, ids, 'trash') };
  for (const extra of [{ approved: true }, { yes: true }, { usedAt: null }, { expiresAt: '2099-01-01T00:00:00.000Z' },
    { rootPath: '/' }, { sessionId: plan.sessionId }, { operations: plan.operations }, { grant: {} }, { id: randomUUID() }])
    await assert.rejects(issueApproval(state, { ...base, ...extra } as Parameters<typeof issueApproval>[1]), code('APPROVAL_INVALID'),
      Object.keys(extra)[0]);
  const { confirmation: _c, ...noCode } = base;
  for (const bad of [noCode, { ...base, confirmation: true }, { ...base, mode: 'delete' }, { ...base, mode: 'TRASH' }, { approved: true },
    { ...base, planId: plan.id.toUpperCase() }, null, 'approve', []])
    await assert.rejects(issueApproval(state, bad as Parameters<typeof issueApproval>[1]), code('APPROVAL_INVALID'), JSON.stringify(bad));
  const nowString = await issueApproval(state, { ...base, now: '2026-10-26T00:00:00Z' } as unknown as Parameters<typeof issueApproval>[1])
    .then(() => 'accepted', (e: unknown) => errorCode(e));
  t.diagnostic(`non-Date now from an interface → ${nowString}`);
  assert.notEqual(nowString, 'accepted');
  await assert.rejects(readdir(path.join(state, 'approvals')), { code: 'ENOENT' }, 'no approval record written by refused requests');
});

/* ---------- selection ---------- */

test('V8-S1 partial approval: the batch is exactly the chosen subset; empty, repeated and foreign IDs are refused', async (t) => {
  const env = await setup(t);
  const { state, plan } = env;
  const trash = idsOf(plan, 'trash');
  for (const subset of [[trash[1]!], [trash[0]!, trash[2]!]]) {
    const a = await approve(state, plan, 'trash', subset);
    assert.deepEqual(a.operationIds, sorted(subset));
    const batch = await consumeApproval(state, a.id);
    assert.deepEqual(batch.operations, plan.operations.filter((o) => subset.includes(o.id)).sort((x, y) => order(x.id, y.id)));
    assert.deepEqual(batch.approval.operationIds, sorted(subset));
    assert.ok(batch.operations.every((o) => subset.includes(o.id)), 'nothing outside the subset');
    assert.deepEqual(batch.plan, plan, 'the full plan is returned for reference only');
  }
  const permanent = await setup(t, { deleteMode: 'permanent' });
  const foreign = idsOf(permanent.plan, 'delete')[0]!;
  for (const ids of [[], [trash[0]!, trash[0]!], [foreign], [trash[0]!, foreign], ['ffffffffffffffff'], [trash[0]!.toUpperCase()], ['../x']])
    await assert.rejects(issueApproval(state, { planId: plan.id, operationIds: ids, mode: 'trash', confirmation: myCode(plan.id, ids, 'trash') }),
      code('APPROVAL_INVALID'), JSON.stringify(ids));
  // selectOperations (engine) agrees.
  assert.throws(() => selectOperations(plan, [], 'trash'), code('APPROVAL_INVALID'));
  assert.throws(() => selectOperations(plan, [foreign], 'trash'), code('APPROVAL_INVALID'));
});

/* ---------- duplicates and keepers ---------- */

test('V8-K1 "delete all duplicates" keeps ≥1 keeper per group; keepers are never operation targets; keeper choice makes a new plan', async (t) => {
  const env = await setup(t, { deleteMode: 'permanent' });
  const { plan, preview, scan, grant, state } = env;
  const targets = new Set(plan.operations.map((o) => o.source));
  assert.equal(preview.duplicates.length, 2);
  for (const group of preview.duplicates) {
    const survivors = group.members!.map((m) => m.relativePath).filter((p) => !targets.has(p));
    assert.ok(survivors.length >= 1, `group ${group.sha256.slice(0, 8)} keeps a file`);
    assert.ok(!targets.has(group.suggestedKeep));
    for (const c of group.candidates) assert.equal(opOf(plan, c).keeper, group.suggestedKeep);
  }
  assert.deepEqual(sorted(plan.operations.filter((o) => o.keeper !== null).map((o) => o.keeper!)), ['a.pdf', 'x.jpg', 'x.jpg']);
  const opts = { scan, grant, sessionId: grant.sessionId, deleteMode: 'permanent' as const, now: env.now };
  // Deleting a keeper together with "all duplicates", or naming it as a candidate, is refused.
  assert.throws(() => buildPlan(preview, { ...opts, deleteSelections: 'all-duplicates', explicitDeletes: ['a.pdf'] }), code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(preview, { ...opts, deleteSelections: 'all-duplicates', explicitDeletes: Object.keys(WORK) }), code('KEEPER_INVALID'));
  const g2 = preview.duplicates.find((g) => g.suggestedKeep === 'x.jpg')!;
  assert.throws(() => buildPlan(preview, { ...opts, deleteSelections: [{ sha256: g2.sha256, candidates: ['x.jpg', 'y.jpg', 'z.jpg'] }] }),
    code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(preview, { ...opts, deleteSelections: [{ sha256: g2.sha256, candidates: ['memo'] }] }), code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(preview, { ...opts, deleteSelections: [{ sha256: g2.sha256, candidates: [] }] }), code('KEEPER_INVALID'));
  // Change the keeper of group 2 to z.jpg → new preview, new plan, changed op IDs; the old approval and code do not carry over.
  const old = await approve(state, plan, 'permanent-delete', idsOf(plan, 'delete'));
  const changed = chooseKeeper(preview, g2.sha256, 'z.jpg');
  const next = buildPlan(changed, { ...opts, deleteSelections: 'all-duplicates' });
  assert.notEqual(next.id, plan.id);
  assert.deepEqual(Object.fromEntries(next.operations.filter((o) => o.kind === 'delete').map((o) => [o.source, o.keeper])),
    { 'b.pdf': 'a.pdf', 'x.jpg': 'z.jpg', 'y.jpg': 'z.jpg' });
  assert.equal(next.reviewItems.find((r) => r.source === 'z.jpg')?.status, 'keep');
  const diff = diffPlans(plan, next);
  assert.deepEqual(diff.unchanged, idsOf(plan, 'move').concat(opOf(plan, 'b.pdf').id).sort(order));
  assert.deepEqual(diff.added, sorted([opOf(next, 'x.jpg').id, opOf(next, 'y.jpg').id]));
  assert.deepEqual(diff.removed, sorted([opOf(plan, 'y.jpg').id, opOf(plan, 'z.jpg').id]));
  await savePlan(state, next, grant);
  await assert.rejects(issueApproval(state, { planId: next.id, operationIds: idsOf(next, 'delete'), mode: 'permanent-delete',
    confirmation: myCode(plan.id, idsOf(plan, 'delete'), 'permanent-delete'), confirmPhrase: '영구 삭제' }), code('APPROVAL_INVALID'));
  const oldBatch = await consumeApproval(state, old.id);
  assert.equal(oldBatch.plan.id, plan.id, 'old approval only ever yields the old plan');
  assert.ok(!oldBatch.operations.some((o) => o.source === 'x.jpg'), 'x.jpg (keeper in the approved plan) is not in the old batch');
});

test('V8-K2 explicit picks: a file the user names one by one gets keeper null — even when that removes every copy (recorded)', async (t) => {
  const env = await setup(t, { deleteMode: 'permanent', save: false });
  const input = { scan: env.scan, grant: env.grant, sessionId: env.grant.sessionId, deleteMode: 'permanent' as const,
    explicitDeletes: ['a.pdf', 'b.pdf'], now: env.now };
  // O-4 follow-up (feat/8-followups): removing every copy is refused unless allowLastCopy is explicitly true.
  assert.throws(() => buildPlan(env.preview, input), code('KEEPER_INVALID'));
  const plan = buildPlan(env.preview, { ...input, allowLastCopy: true });
  assert.deepEqual(plan.operations.filter((o) => o.kind === 'delete').map((o) => [o.source, o.keeper]), [['a.pdf', null], ['b.pdf', null]]);
  t.diagnostic('explicitDeletes of both members of a duplicate group: refused by default, allowed only with allowLastCopy: true (keeper null)');
});

/* ---------- profile binding ---------- */

test('V8-R1 profile binding: rule off, saved correction, disable, reset, ABA changes and corruption all refuse issue and consume', async (t) => {
  const changes: Array<[string, (stateDir: string) => Promise<unknown>]> = [
    ['rule disabled', (s) => setRuleEnabled('rule-mp3', false, { stateDir: s })],
    ['correction saved', (s) => addCorrection({ type: 'file-name', name: 'memo' }, '메모', { stateDir: s })],
    ['profile disabled', (s) => disableProfile({ stateDir: s })],
    ['profile reset', (s) => resetProfile({ stateDir: s })],
    ['disable → enable', async (s) => { await disableProfile({ stateDir: s }); await enableProfile({ stateDir: s }); }],
    ['reset → same profile saved again', async (s) => { await resetProfile({ stateDir: s }); await saveConfirmedProfile(PROFILE, { stateDir: s }); }],
    ['correction added → removed', async (s) => {
      const p = await addCorrection({ type: 'file-name', name: 'memo' }, '메모', { stateDir: s });
      await removeCorrection(p.corrections[0]!.id, { stateDir: s }); }],
    ['profile file corrupted', (s) => writeFile(profileFile(s), '{')],
  ];
  for (const [label, change] of changes) {
    const env = await setup(t, { profile: true });
    assert.deepEqual([env.plan.profileId, env.plan.profileRevision], ['verify-8-profile', 1], label);
    assert.deepEqual([opOf(env.plan, 'song.mp3').destination, opOf(env.plan, 'song.mp3').ruleId], ['내 음악/song.mp3', 'rule-mp3']);
    const moves = idsOf(env.plan, 'move');
    const a = await approve(env.state, env.plan, 'organize', moves);
    assert.deepEqual([a.profileId, a.profileRevision], ['verify-8-profile', 1]);
    const trash = await approve(env.state, env.plan, 'trash', idsOf(env.plan, 'trash'));
    await change(env.state);
    await assert.rejects(consumeApproval(env.state, a.id), code('PROFILE_CHANGED'), `consume organize: ${label}`);
    await assert.rejects(consumeApproval(env.state, trash.id), code('PROFILE_CHANGED'), `consume trash: ${label}`);
    await assert.rejects(approve(env.state, env.plan, 'organize', moves), code('PROFILE_CHANGED'), `issue: ${label}`);
    await assert.rejects(savePlan(env.state, env.plan, env.grant), code('PROFILE_CHANGED'), `save: ${label}`);
    assert.ok(!(await readdir(path.join(env.state, 'approvals'))).some((n) => n.endsWith('.used')), `not consumed: ${label}`);
  }
});

test('V8-R2 profile no-op keeps the approval; a plan made without a profile ignores profiles saved later (recorded)', async (t) => {
  const env = await setup(t, { profile: true });
  const a = await approve(env.state, env.plan, 'organize', idsOf(env.plan, 'move'));
  await setRuleEnabled('rule-mp3', true, { stateDir: env.state }); // already enabled: no write, no new revision
  assert.equal((await consumeApproval(env.state, a.id)).approval.id, a.id);
  const plain = await setup(t);
  const b = await approve(plain.state, plain.plan, 'organize', idsOf(plain.plan, 'move'));
  await saveConfirmedProfile(PROFILE, { stateDir: plain.state });
  const outcome = await consumeApproval(plain.state, b.id).then(() => 'consumed', (e: unknown) => errorCode(e));
  t.diagnostic(`profile-less plan, profile saved after approval → ${outcome}`);
  assert.equal(outcome, 'consumed', 'by design: the batch is the plan the user saw (no personal rule was applied)');
});

/* ---------- read-only service ---------- */

test('V8-W1 savePlan, issueApproval and consumeApproval (and their refusals) never write into the work root', async (t) => {
  const env = await setup(t, { save: false });
  const { state, plan, grant, work } = env;
  const before = await createManifest(work);
  await savePlan(state, plan, grant);
  assert.deepEqual(await loadSavedPlan(state, plan.id), { plan, grant: { canonicalPath: grant.canonicalPath, device: grant.device,
    inode: grant.inode, sessionId: grant.sessionId } });
  const a = await approve(state, plan, 'trash', idsOf(plan, 'trash'));
  await assert.rejects(approve(state, plan, 'organize', idsOf(plan, 'trash')), code('MODE_MISMATCH'));
  await assert.rejects(consumeApproval(state, randomUUID()), code('APPROVAL_MISSING'));
  await consumeApproval(state, a.id);
  await assert.rejects(consumeApproval(state, a.id), code('APPROVAL_USED'));
  assert.deepEqual(await createManifest(work), before, 'work root identical (paths, sizes, mtimes, sha256)');
  assert.deepEqual(sorted(await readdir(state)), ['approvals', 'plans', 'secret']);
  assert.deepEqual(sorted(await readdir(path.join(state, 'approvals'))), sorted([`${a.id}.json`, `${a.id}.used`]));
  assert.deepEqual(await readdir(path.join(state, 'plans')), [`${plan.id}.json`]);
  if (posix) assert.equal((await stat(path.join(state, 'secret'))).mode & 0o777, 0o600);
});

test('V8-G1 re-selecting the same folder (new grant, old one revoked) after approval: recorded behaviour', async (t) => {
  const env = await setup(t);
  const a = await approve(env.state, env.plan, 'organize', idsOf(env.plan, 'move'));
  revokeGrant(env.grant);
  await issueRootGrant(env.work);
  const outcome = await consumeApproval(env.state, a.id).then((b) => `consumed (batch grant ${b.grant.id === env.grant.id ? 'old' : 'new'} id)`,
    (e: unknown) => errorCode(e));
  t.diagnostic(`same folder re-selected after approval → ${outcome}`);
});

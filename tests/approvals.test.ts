import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { AfoError, SavedApprovalSchema, SavedPlanSchema } from '../packages/contracts/src/index.js';
import type { Approval, ApprovalMode, ErrorCode, OperationPlan, RootGrant, SavedApproval } from '../packages/contracts/src/index.js';
import { approvalChoices, approvalCode, buildPlan, buildPreview, diffPlans, planHash } from '../packages/engine/src/index.js';
import { analyzeRoot, hashCandidates, issueRootGrant, scanRoot } from '../packages/filesystem/src/index.js';
import { consumeApproval, issueApproval, loadSavedPlan, savePlan } from '../packages/filesystem/src/approvals.js';
import { addCorrection, disableProfile, loadProfile, resetProfile } from '../packages/filesystem/src/profiles.js';
import { createFixture, manifest } from './helpers.js';

/* #8 saved plans and one-time approvals. Synthetic temp folders only; state lives in a sibling temp folder, never app data. */
const run = promisify(execFile);
const code = (expected: ErrorCode) => (error: unknown): boolean => {
  if (error instanceof AfoError && error.code === expected) return true;
  throw error;
};
const WORK = { 'report.pdf': 'same bytes', 'report copy.pdf': 'same bytes', 'a.jpg': 'pic', 'b.jpg': 'pic', 'c.jpg': 'pic',
  'clip.mp4': 'video', notes: 'no extension' };

interface Setup { base: string; work: string; state: string; grant: RootGrant; plan: OperationPlan }
async function setup(t: TestContext, options: { deleteMode?: 'trash' | 'permanent'; profile?: boolean } = {}): Promise<Setup> {
  const spec: Record<string, string> = { 'state/': '' };
  for (const [k, v] of Object.entries(WORK)) spec[`work/${k}`] = v;
  const { root: base } = await createFixture(spec, t);
  const work = path.join(base, 'work'); const state = path.join(base, 'state');
  if (options.profile) await addCorrection({ type: 'file-name', name: 'notes' }, '메모', { stateDir: state });
  const grant = await issueRootGrant(work);
  const plan = await planFor(grant, state, options.deleteMode ?? 'trash', options.profile ?? false);
  await savePlan(state, plan, grant);
  return { base, work, state, grant, plan };
}
async function planFor(grant: RootGrant, state: string, deleteMode: 'trash' | 'permanent', withProfile: boolean): Promise<OperationPlan> {
  const scan = await hashCandidates(grant, await scanRoot(grant));
  const profile = withProfile ? await loadProfile({ stateDir: state }) : null;
  const preview = buildPreview(scan, profile ? { profile } : {});
  return buildPlan(preview, { scan, grant, sessionId: grant.sessionId, deleteMode, deleteSelections: 'all-duplicates', now: new Date() });
}
const idsOf = (plan: OperationPlan, mode: ApprovalMode): string[] => approvalChoices(plan).find((c) => c.mode === mode)?.operationIds ?? [];
const approve = (state: string, plan: OperationPlan, mode: ApprovalMode, ids = idsOf(plan, mode), extra: Record<string, unknown> = {}):
  Promise<Approval> => issueApproval(state, { planId: plan.id, operationIds: ids, mode, confirmation: approvalCode(plan.id, ids, mode),
  ...(mode === 'permanent-delete' ? { confirmPhrase: '영구 삭제' } : {}), ...extra });
const approvalPath = (state: string, id: string): string => path.join(state, 'approvals', `${id}.json`);
const planPath = (state: string, id: string): string => path.join(state, 'plans', `${id}.json`);
const readRecord = async (state: string, id: string): Promise<SavedApproval> =>
  SavedApprovalSchema.parse(JSON.parse(await readFile(approvalPath(state, id), 'utf8')));

test('a saved plan, one approval and one consumption give exactly the approved batch; work files are untouched', async (t) => {
  const { work, state, grant, plan } = await setup(t);
  const before = await manifest(work);
  const saved = SavedPlanSchema.parse(JSON.parse(await readFile(planPath(state, plan.id), 'utf8')));
  assert.deepEqual(Object.keys(saved).sort(), ['grant', 'plan']);
  assert.deepEqual(await loadSavedPlan(state, plan.id), { plan, grant: { canonicalPath: grant.canonicalPath, device: grant.device,
    inode: grant.inode, sessionId: grant.sessionId } });
  assert.equal(await loadSavedPlan(state, 'f'.repeat(64)), null);
  assert.equal(await loadSavedPlan(state, '../plans'), null);
  assert.deepEqual(plan.summary, { move: 1, trash: 3, delete: 0, logicalBytes: plan.summary.logicalBytes });
  const approval = await approve(state, plan, 'trash');
  assert.equal(approval.usedAt, null);
  assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.issuedAt), 10 * 60 * 1000);
  const batch = await consumeApproval(state, approval.id);
  assert.deepEqual(batch.operations, plan.operations.filter((op) => op.kind === 'trash').sort((x, y) => x.id < y.id ? -1 : 1), 'approval.operationIds order');
  assert.ok(batch.operations.every((op) => op.keeper !== null), 'duplicate deletions keep a keeper');
  assert.deepEqual(batch.plan, plan); assert.equal(batch.stateDir, state);
  assert.deepEqual([batch.grant.canonicalPath, batch.grant.device, batch.grant.inode, batch.grant.sessionId],
    [grant.canonicalPath, grant.device, grant.inode, plan.sessionId]);
  assert.notEqual(batch.approval.usedAt, null);
  assert.notEqual((await readRecord(state, approval.id)).approval.usedAt, null);
  await assert.rejects(consumeApproval(state, approval.id), code('APPROVAL_USED'));
  assert.deepEqual(await manifest(work), before);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(state, 'secret'))).mode & 0o777, 0o600);
});

test('approving part of a batch yields exactly that subset', async (t) => {
  const { state, plan } = await setup(t);
  const trash = idsOf(plan, 'trash');
  assert.equal(trash.length, 3);
  const one = [trash[1]!];
  const batch = await consumeApproval(state, (await approve(state, plan, 'trash', one)).id);
  assert.deepEqual(batch.operations.map((op) => op.id), one);
  assert.deepEqual(batch.approval.operationIds, one);
  // The code for the whole batch does not approve a part of it (and vice versa).
  await assert.rejects(issueApproval(state, { planId: plan.id, operationIds: one, mode: 'trash',
    confirmation: approvalCode(plan.id, trash, 'trash') }), code('APPROVAL_INVALID'));
});

test('missing, malformed and forged approvals are refused', async (t) => {
  const { state, plan } = await setup(t);
  await assert.rejects(consumeApproval(state, randomUUID()), code('APPROVAL_MISSING'));
  await assert.rejects(consumeApproval(state, '../plans/x'), code('APPROVAL_MISSING'));
  const ids = idsOf(plan, 'trash');
  // Interface input is strict: a boolean, a path or an unknown field never creates an approval.
  await assert.rejects(approve(state, plan, 'trash', ids, { approved: true }), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(state, { planId: plan.id, operationIds: ids, mode: 'trash', confirmation: '00000000' }),
    code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(state, JSON.parse(JSON.stringify({ approved: true, planId: plan.id }))), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(state, { planId: 'f'.repeat(64), operationIds: ids, mode: 'trash',
    confirmation: approvalCode('f'.repeat(64), ids, 'trash') }), code('PLAN_CHANGED'));
  // Hand-written record for a valid saved plan: well-formed, bound to the plan, but not issued by the service.
  const real = await readRecord(state, (await approve(state, plan, 'trash')).id);
  const forgedId = randomUUID();
  await writeFile(approvalPath(state, forgedId), JSON.stringify({ ...real, approval: { ...real.approval, id: forgedId } }));
  await assert.rejects(consumeApproval(state, forgedId), code('APPROVAL_INVALID'));
  // Widening a real approval (more operations, another mode) breaks its MAC.
  const narrow = await approve(state, plan, 'trash', [ids[0]!]);
  const record = await readRecord(state, narrow.id);
  await writeFile(approvalPath(state, narrow.id), JSON.stringify({ ...record, approval: { ...record.approval, operationIds: ids } }));
  await assert.rejects(consumeApproval(state, narrow.id), code('APPROVAL_INVALID'));
  const organize = await approve(state, plan, 'organize');
  const r2 = await readRecord(state, organize.id);
  await writeFile(approvalPath(state, organize.id), JSON.stringify({ ...r2, approval: { ...r2.approval, mode: 'trash' } }));
  await assert.rejects(consumeApproval(state, organize.id), code('APPROVAL_INVALID'));
  await writeFile(approvalPath(state, organize.id), '{"formatVersion":1');
  await assert.rejects(consumeApproval(state, organize.id), code('APPROVAL_INVALID'));
  // Without the service secret nothing verifies.
  const valid = await approve(state, plan, 'organize');
  await rm(path.join(state, 'secret'));
  await assert.rejects(consumeApproval(state, valid.id), code('APPROVAL_INVALID'));
});

test('mode is bound: mixed kinds and wrong modes are MODE_MISMATCH; permanent deletion needs the exact phrase', async (t) => {
  const { state, plan } = await setup(t);
  const both = [...idsOf(plan, 'organize'), ...idsOf(plan, 'trash')];
  await assert.rejects(approve(state, plan, 'organize', both), code('MODE_MISMATCH'));
  await assert.rejects(approve(state, plan, 'permanent-delete', idsOf(plan, 'trash')), code('MODE_MISMATCH'));
  const p = await setup(t, { deleteMode: 'permanent' });
  const del = idsOf(p.plan, 'permanent-delete');
  await assert.rejects(approve(p.state, p.plan, 'permanent-delete', del, { confirmPhrase: undefined }), code('APPROVAL_INVALID'));
  await assert.rejects(approve(p.state, p.plan, 'permanent-delete', del, { confirmPhrase: '영구삭제' }), code('APPROVAL_INVALID'));
  await assert.rejects(approve(p.state, p.plan, 'trash', del), code('MODE_MISMATCH'));
  const batch = await consumeApproval(p.state, (await approve(p.state, p.plan, 'permanent-delete', del)).id);
  assert.deepEqual(batch.operations.map((op) => op.kind), ['delete', 'delete', 'delete']);
  assert.equal(batch.approval.mode, 'permanent-delete');
});

test('expiry is checked before use; plans and approvals expire', async (t) => {
  const { state, plan } = await setup(t);
  const issued = new Date();
  const approval = await approve(state, plan, 'organize', undefined, { now: issued });
  const late = new Date(issued.getTime() + 10 * 60 * 1000 + 1);
  await assert.rejects(consumeApproval(state, approval.id, late), code('APPROVAL_EXPIRED'));
  const used = await approve(state, plan, 'trash', undefined, { now: issued });
  await consumeApproval(state, used.id, issued);
  await assert.rejects(consumeApproval(state, used.id, late), code('APPROVAL_EXPIRED'), 'expired before used');
  await assert.rejects(approve(state, plan, 'organize', undefined, { now: new Date(Date.parse(plan.expiresAt)) }), code('APPROVAL_EXPIRED'));
  // An approval never outlives its plan.
  const nearEnd = new Date(Date.parse(plan.expiresAt) - 60_000);
  assert.equal((await approve(state, plan, 'organize', undefined, { now: nearEnd })).expiresAt, plan.expiresAt);
});

test('reuse is refused even if the record is rolled back to unused', async (t) => {
  const { state, plan } = await setup(t);
  const approval = await approve(state, plan, 'organize');
  const fresh = await readRecord(state, approval.id);
  await consumeApproval(state, approval.id);
  await writeFile(approvalPath(state, approval.id), JSON.stringify(fresh));
  await assert.rejects(consumeApproval(state, approval.id), code('APPROVAL_USED'));
});

test('two concurrent consumptions (same process and two processes) succeed exactly once', async (t) => {
  const { state, plan } = await setup(t);
  const a = await approve(state, plan, 'trash');
  const results = await Promise.allSettled([consumeApproval(state, a.id), consumeApproval(state, a.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.ok(rejected && rejected.reason instanceof AfoError && rejected.reason.code === 'APPROVAL_USED');
  const b = await approve(state, plan, 'trash');
  const moduleUrl = new URL('../packages/filesystem/src/approvals.js', import.meta.url).href;
  const script = `const { consumeApproval } = await import(process.argv[1]);
try { const r = await consumeApproval(process.argv[2], process.argv[3]); console.log('ok ' + r.operations.length); }
catch (e) { console.log('err ' + e.code); }`;
  const child = () => run(process.execPath, ['--input-type=module', '-e', script, moduleUrl, state, b.id]).then((r) => r.stdout.trim());
  const outputs = (await Promise.all([child(), child()])).sort();
  assert.deepEqual(outputs, ['err APPROVAL_USED', 'ok 3']);
});

test('plan tampering, file changes and new plans never reuse an old approval', async (t) => {
  const { work, state, grant, plan } = await setup(t);
  const file = planPath(state, plan.id);
  const original = await readFile(file, 'utf8');
  const approval = await approve(state, plan, 'organize');
  const moved = JSON.parse(original) as { plan: OperationPlan };
  const op = moved.plan.operations.find((o) => o.kind === 'move')!;
  op.destination = '다른곳/clip.mp4';
  await writeFile(file, JSON.stringify(moved));
  await assert.rejects(consumeApproval(state, approval.id), code('PLAN_CHANGED'));
  await assert.rejects(approve(state, plan, 'organize'), code('PLAN_CHANGED'));
  moved.plan.id = planHash(moved.plan); // consistent new content under the old name
  await writeFile(file, JSON.stringify(moved));
  await assert.rejects(consumeApproval(state, approval.id), code('PLAN_CHANGED'));
  // Root identity in the saved plan is outside the hash: changing it must not pass either.
  const swapped = JSON.parse(original) as { grant: { inode: string } };
  swapped.grant.inode = '1';
  await writeFile(file, JSON.stringify(swapped));
  await assert.rejects(consumeApproval(state, approval.id), code('PLAN_CHANGED'));
  await writeFile(file, '{');
  await assert.rejects(loadSavedPlan(state, plan.id), code('STATE_CORRUPT'));
  await writeFile(file, original);
  // A changed file gives a new plan whose changed operation has a new ID; the old code and approval do not carry over.
  await writeFile(path.join(work, 'clip.mp4'), 'edited video');
  const next = await planFor(grant, state, 'trash', false);
  await savePlan(state, next, grant);
  const diff = diffPlans(plan, next);
  assert.deepEqual(diff.added.map((id) => next.operations.find((o) => o.id === id)!.source), ['clip.mp4']);
  assert.equal(diff.removed.length, 1);
  await assert.rejects(issueApproval(state, { planId: next.id, operationIds: idsOf(plan, 'organize'), mode: 'organize',
    confirmation: approvalCode(plan.id, idsOf(plan, 'organize'), 'organize') }), code('APPROVAL_INVALID'));
  const batch = await consumeApproval(state, approval.id);
  assert.equal(batch.plan.id, plan.id, 'the old approval only ever yields the old plan (the executor re-checks files)');
  assert.ok(batch.operations.every((o) => !next.operations.some((n) => n.id === o.id && n.source === 'clip.mp4')));
});

test('profile edit, disable and reset after planning refuse issuing and consuming', async (t) => {
  const changes: Array<[string, (stateDir: string) => Promise<unknown>]> = [
    ['edit', (s) => addCorrection({ type: 'file-name', name: 'clip.mp4' }, '동영상', { stateDir: s })],
    ['disable', (s) => disableProfile({ stateDir: s })], ['reset', (s) => resetProfile({ stateDir: s })]];
  for (const [label, change] of changes) {
    const { state, plan } = await setup(t, { profile: true });
    assert.notEqual(plan.profileId, null, 'the plan is bound to the saved profile');
    assert.ok(plan.operations.some((op) => op.source === 'notes' && op.destination === '메모/notes'));
    const approval = await approve(state, plan, 'organize');
    await change(state);
    await assert.rejects(consumeApproval(state, approval.id), code('PROFILE_CHANGED'), label);
    await assert.rejects(approve(state, plan, 'organize'), code('PROFILE_CHANGED'), label);
  }
});

test('replacing the work root (same path, other dev/inode) is refused', async (t) => {
  const { work, state, plan } = await setup(t);
  const approval = await approve(state, plan, 'organize');
  await rename(work, `${work}-old`);
  await mkdir(work);
  await assert.rejects(consumeApproval(state, approval.id), code('FILE_CHANGED'));
  await assert.rejects(approve(state, plan, 'organize'), code('FILE_CHANGED'));
});

test('state folder inside the root, foreign grants and inconsistent plans are refused at save', async (t) => {
  const { work, state, grant, plan } = await setup(t);
  await assert.rejects(savePlan(path.join(work, 'state'), plan, grant), code('STATE_DIR_CONFLICT'));
  await assert.rejects(readdir(path.join(work, 'state')), { code: 'ENOENT' }, 'nothing written inside the root');
  await assert.rejects(savePlan(state, plan, { ...grant, inode: '1' }), code('ROOT_FORBIDDEN'));
  await assert.rejects(savePlan(state, { ...plan, expiresAt: new Date(Date.parse(plan.expiresAt) + 1).toISOString() }, grant),
    code('PLAN_CHANGED'));
  const other = await issueRootGrant(work);
  await assert.rejects(savePlan(state, plan, other), code('ROOT_FORBIDDEN'));
});

test('O-7: schema-invalid plans, malformed requests and invalid clocks are AfoError codes, never raw ZodError/TypeError', async (t) => {
  const { state, grant, plan } = await setup(t);
  for (const bad of [{ ...plan, deleteMode: 'shred' }, { ...plan, operations: 'x' }, null, 'plan', []] as unknown[])
    await assert.rejects(savePlan(state, bad, grant), code('PLAN_CHANGED'));
  const ids = idsOf(plan, 'trash');
  for (const now of [new Date(Number.NaN), '2026-10-28T00:00:00.000Z', 0, {}] as unknown[])
    await assert.rejects(approve(state, plan, 'trash', ids, { now }), code('APPROVAL_INVALID'), String(now));
  for (const input of [null, undefined, 'trash', 42, [plan.id]] as unknown[])
    await assert.rejects(issueApproval(state, input as never), code('APPROVAL_INVALID'), String(input));
  const approval = await approve(state, plan, 'trash');
  for (const now of [new Date(Number.NaN), 'now', 1] as unknown[])
    await assert.rejects(consumeApproval(state, approval.id, now as Date), code('APPROVAL_INVALID'), String(now));
  assert.equal((await readRecord(state, approval.id)).approval.usedAt, null, 'an invalid clock does not consume the approval');
  assert.equal((await consumeApproval(state, approval.id)).approval.id, approval.id);
});

test('the permanent-delete phrase is compared after NFC normalization (an NFD-typed phrase is accepted)', async (t) => {
  const p = await setup(t, { deleteMode: 'permanent' });
  const nfd = '영구 삭제'.normalize('NFD');
  assert.notEqual(nfd, '영구 삭제');
  const approval = await approve(p.state, p.plan, 'permanent-delete', idsOf(p.plan, 'permanent-delete'), { confirmPhrase: nfd });
  assert.equal(approval.mode, 'permanent-delete');
});

test('analyzeRoot returns the hashed scan its preview was built from; a plan from it reads no file again', async (t) => {
  const { root: base } = await createFixture({ 'work/report.pdf': 'same bytes', 'work/report copy.pdf': 'same bytes',
    'work/clip.mp4': 'video', 'state/': '' }, t);
  const work = path.join(base, 'work'); const state = path.join(base, 'state');
  const grant = await issueRootGrant(work);
  const analysis = await analyzeRoot(grant, { stateDir: state });
  assert.deepEqual(analysis.scan.files.map((f) => `${f.id} ${f.relativePath}`).sort(),
    analysis.preview.items.map((i) => `${i.fileId} ${i.source}`).sort(), 'same files as the preview');
  const group = analysis.preview.duplicates[0]!;
  assert.equal(analysis.scan.files.filter((f) => f.sha256 === group.sha256).length, 2, 'duplicates are hashed in the returned scan');
  // Files changed after analysis do not reach the plan: buildPlan uses only this snapshot (the executor re-verifies before acting).
  const snapshot = new Map(analysis.scan.files.map((f) => [f.relativePath, f]));
  for (const name of ['report.pdf', 'report copy.pdf', 'clip.mp4']) await writeFile(path.join(work, name), `changed after analysis: ${name}`);
  const plan = buildPlan(analysis.preview, { scan: analysis.scan, grant, sessionId: grant.sessionId, deleteMode: 'trash',
    deleteSelections: 'all-duplicates', now: new Date() });
  assert.deepEqual(plan.summary.trash, 1);
  for (const op of plan.operations) {
    const f = snapshot.get(op.source)!;
    assert.deepEqual(op.expected, { size: f.size, modifiedNs: f.modifiedNs, device: f.device, inode: f.inode, sha256: f.sha256 }, op.source);
  }
  await savePlan(state, plan, grant);
});

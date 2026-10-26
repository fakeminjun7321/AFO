// #8 plan building and one-time approvals. Pure plan tests plus a real state folder under mkdtemp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AfoError, OperationPlanSchema } from '../packages/contracts/src/index.js';
import type { ErrorCode, OperationPlan } from '../packages/contracts/src/index.js';
import { buildPlan, canonicalJson, carryOverSelection, planContentHash, planHashMatches } from '../packages/engine/src/planning.js';
import type { PlanInput, PlanProposal } from '../packages/engine/src/planning.js';
import { consumeApproval, isApprovalUsed, issueApproval } from '../packages/filesystem/src/approvals.js';

const h = (c: string): string => c.repeat(64);
const NOW = new Date('2026-10-26T12:00:00.000Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);
const grant = { id: h('a'), canonicalPath: '/afo-fixture', sessionId: 'session-0001' };
const expected = (n: number, sha: string | null = null) => ({ size: 10 * n, modifiedNs: String(1000 + n), device: '1', inode: String(n), sha256: sha });
const fid = (n: number): string => n.toString(16).padStart(64, '0');
const mv = (n: number, source: string, destination: string): PlanProposal => ({ fileId: fid(n), source, kind: 'move', destination,
  reason: '확장자 규칙', ruleId: null, keeper: null, expected: expected(n) });
const trash = (n: number, source: string, keeper: string | null = null): PlanProposal => ({ fileId: fid(n), source, kind: 'trash',
  destination: null, reason: '중복 후보', ruleId: null, keeper, expected: expected(n, keeper ? h('c') : null) });
const input = (extra: Partial<PlanInput> = {}): PlanInput => ({ grant, profile: { id: 'profile-1', revision: 2 }, deleteMode: 'trash',
  proposals: [mv(1, 'a.pdf', '문서/a.pdf'), mv(2, 'b.png', '이미지/b.png'), trash(3, 'c (1).pdf', 'c.pdf')],
  occupied: { files: ['a.pdf', 'b.png', 'c (1).pdf', 'c.pdf'], directories: [] }, now: NOW, ...extra });
const code = (expectedCode: ErrorCode) => (error: unknown): boolean => {
  assert.ok(error instanceof AfoError, String(error)); assert.equal(error.code, expectedCode, error.message); return true;
};
const stateDir = async (t: test.TestContext): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'afo-test-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const ids = (plan: OperationPlan, kind: string): string[] => plan.operations.filter((op) => op.kind === kind).map((op) => op.id).sort();
const ctx = (plan: OperationPlan, extra: Record<string, unknown> = {}) => ({ plan, sessionId: grant.sessionId, rootGrantId: grant.id,
  profile: { id: 'profile-1', revision: 2 }, now: later(1000), ...extra });

test('canonical JSON sorts keys recursively and rejects non-JSON values', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson({ a: 1n }));
});

test('the same input gives the same plan and ID regardless of proposal order; the ID covers every field', () => {
  const a = buildPlan(input());
  const b = buildPlan(input({ proposals: [...input().proposals].reverse() }));
  assert.equal(a.id, b.id);
  assert.deepEqual(a, b);
  assert.ok(planHashMatches(a));
  assert.equal(OperationPlanSchema.parse(a).summary.logicalBytes, 60);
  assert.deepEqual(a.summary, { move: 2, trash: 1, delete: 0, logicalBytes: 60 });
  const edited: OperationPlan = { ...a, operations: a.operations.map((op) => op.kind === 'move' ? { ...op, destination: `x/${op.destination}` } : op) };
  assert.equal(planHashMatches(edited), false, 'destination edit');
  assert.equal(planHashMatches({ ...a, profileRevision: 3 }), false, 'profile revision');
  assert.equal(planHashMatches({ ...a, expiresAt: later(10 * 60 * 60 * 1000).toISOString() }), false, 'validity window');
  assert.equal(planHashMatches({ ...a, rootGrantId: h('b') }), false, 'root');
  assert.notEqual(buildPlan(input({ profile: null })).id, a.id);
  assert.equal(planContentHash(a), a.id);
});

test('destination collisions get predictable suffixes; case and NFC/NFD count as the same name', () => {
  const nfd = '보고서.pdf'.normalize('NFD');
  const plan = buildPlan(input({
    proposals: [mv(1, 'x/Report.PDF', '문서/report.pdf'), mv(2, 'y/report.pdf', '문서/REPORT.pdf'),
      mv(3, 'z/보고서.pdf', `문서/${'보고서.pdf'.normalize('NFC')}`), mv(4, '.env', '설정/.env'), mv(5, 'w/.env', '설정/.env')],
    occupied: { files: ['x/Report.PDF', 'y/report.pdf', 'z/보고서.pdf', '.env', 'w/.env', `문서/${nfd}`, '문서/report (2).pdf'],
      directories: ['문서', 'x', 'y', 'z', 'w'] } }));
  const dest = Object.fromEntries(plan.operations.map((op) => [op.source, op.destination]));
  assert.equal(dest['x/Report.PDF'], '문서/report.pdf');
  assert.equal(dest['y/report.pdf'], '문서/REPORT (3).pdf', '(2) is taken by an existing file, case-insensitively');
  assert.equal(dest['z/보고서.pdf'], `문서/${'보고서 (2).pdf'.normalize('NFC')}`, 'existing NFD name blocks the NFC name');
  assert.equal(dest['.env'], '설정/.env');
  assert.equal(dest['w/.env'], '설정/.env (2)', 'dotfile has no extension');
  assert.match(plan.operations.find((op) => op.source === 'y/report.pdf')!.reason, /REPORT \(3\)\.pdf/u);
});

test('unsafe or meaningless destinations become review items instead of being renamed silently', () => {
  const plan = buildPlan(input({
    proposals: [mv(1, 'a.pdf', 'CON/a.pdf'), mv(2, 'b.pdf', '문서/b.pdf.'), mv(3, '문서/c.pdf', '문서/C.PDF'),
      mv(4, 'd.pdf', 'docs/d.pdf'), mv(5, 'e.pdf', '../e.pdf'), { ...mv(6, 'f.pdf', 'x'), destination: null }],
    occupied: { files: ['a.pdf', 'b.pdf', '문서/c.pdf', 'd.pdf', 'e.pdf', 'f.pdf', 'docs'], directories: ['문서'] } }));
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.reviewItems.length, 6);
  const reason = Object.fromEntries(plan.reviewItems.map((r) => [r.source, r.reason]));
  assert.match(reason['a.pdf']!, /안전하게 쓸 수 없어/u);
  assert.match(reason['b.pdf']!, /안전하게 쓸 수 없어/u);
  assert.match(reason['문서/c.pdf']!, /이미 정리됨/u);
  assert.match(reason['d.pdf']!, /폴더 자리에 같은 이름의 파일/u);
  assert.match(reason['e.pdf']!, /안전하게 쓸 수 없어/u);
});

test('when every suffix is taken the file is left for review', () => {
  const files = ['a.pdf', '문서/a.pdf', ...Array.from({ length: 98 }, (_, i) => `문서/a (${i + 2}).pdf`)];
  const plan = buildPlan(input({ proposals: [mv(1, 'a.pdf', '문서/a.pdf')], occupied: { files, directories: ['문서'] } }));
  assert.equal(plan.operations.length, 0);
  assert.match(plan.reviewItems[0]!.reason, /모두 사용 중/u);
});

test('delete mode and kinds must agree; a file gets at most one plan item', () => {
  assert.throws(() => buildPlan(input({ deleteMode: 'permanent' })), code('MODE_MISMATCH'));
  assert.throws(() => buildPlan(input({ proposals: [mv(1, 'a.pdf', '문서/a.pdf'), mv(1, 'a.pdf', '문서/a2.pdf')] })), code('PLAN_CHANGED'));
  assert.throws(() => buildPlan(input({ proposals: [trash(3, 'c (1).pdf', 'c (1).pdf')] })), 'keeper equal to target');
});

test('a valid batch is approved once and spent once; the service returns only the approved operations', async (t) => {
  const dir = await stateDir(t);
  const plan = buildPlan(input());
  const moves = ids(plan, 'move');
  const approval = await issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: [moves[0]!], mode: 'organize', now: NOW });
  assert.equal(approval.usedAt, null);
  assert.equal(approval.planId, plan.id);
  assert.deepEqual(approval.operationIds, [moves[0]]);
  const { operations, approval: spent } = await consumeApproval(dir, approval.id, ctx(plan));
  assert.deepEqual(operations.map((op) => op.id), [moves[0]], 'partial selection: the other move is not returned');
  assert.notEqual(spent.usedAt, null);
  assert.equal(await isApprovalUsed(dir, approval.id), true);
  await assert.rejects(consumeApproval(dir, approval.id, ctx(plan)), code('APPROVAL_USED'), 'replay');
});

test('approval is refused when missing, malformed, forged in the request, or for the wrong session or root', async (t) => {
  const dir = await stateDir(t);
  const plan = buildPlan(input());
  const moves = ids(plan, 'move');
  await assert.rejects(consumeApproval(dir, 'deadbeefdeadbeef', ctx(plan)), code('APPROVAL_MISSING'));
  await assert.rejects(consumeApproval(dir, '../../etc/passwd', ctx(plan)), code('APPROVAL_INVALID'));
  await assert.rejects(consumeApproval(dir, '', ctx(plan)), code('APPROVAL_INVALID'));
  // A caller cannot hand in its own approval object; only an ID the service stored.
  await assert.rejects(consumeApproval(dir, JSON.stringify({ approved: true }), ctx(plan)), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(dir, { plan, sessionId: 'session-9999', operationIds: moves, mode: 'organize', now: NOW }), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: ['ffffffffffffffff'], mode: 'organize', now: NOW }), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: [], mode: 'organize', now: NOW }), code('APPROVAL_INVALID'));
  await assert.rejects(issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: [...moves].reverse(), mode: 'organize', now: NOW }), code('APPROVAL_INVALID'));
  const approval = await issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: moves, mode: 'organize', now: NOW });
  await assert.rejects(consumeApproval(dir, approval.id, ctx(plan, { sessionId: 'session-9999' })), code('APPROVAL_INVALID'));
  await assert.rejects(consumeApproval(dir, approval.id, ctx(plan, { rootGrantId: h('b') })), code('APPROVAL_INVALID'));
  assert.equal(await isApprovalUsed(dir, approval.id), false, 'refusals do not spend the approval');
  // A damaged record is refused, not guessed.
  await writeFile(path.join(dir, 'approvals', `${approval.id}.json`), '{"formatVersion":1');
  await assert.rejects(consumeApproval(dir, approval.id, ctx(plan)), code('APPROVAL_INVALID'));
});

test('expired plan or approval, changed plan, changed profile and changed mode are refused', async (t) => {
  const dir = await stateDir(t);
  const plan = buildPlan(input());
  const moves = ids(plan, 'move'); const trashes = ids(plan, 'trash');
  await assert.rejects(issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: [...moves, ...trashes].sort(), mode: 'organize', now: NOW }), code('MODE_MISMATCH'));
  await assert.rejects(issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: trashes, mode: 'permanent-delete', now: NOW }), code('MODE_MISMATCH'));
  await assert.rejects(issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: moves, mode: 'organize', now: later(2 * 60 * 60 * 1000) }), code('PLAN_CHANGED'), 'expired plan');
  const tampered = { ...plan, operations: plan.operations.map((op) => op.kind === 'move' ? { ...op, destination: `x/${op.destination}` } : op) };
  await assert.rejects(issueApproval(dir, { plan: tampered, sessionId: grant.sessionId, operationIds: moves, mode: 'organize', now: NOW }), code('PLAN_CHANGED'));

  const approval = await issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: moves, mode: 'organize', now: NOW });
  assert.ok(Date.parse(approval.expiresAt) - NOW.getTime() <= 10 * 60 * 1000);
  await assert.rejects(consumeApproval(dir, approval.id, ctx(tampered)), code('PLAN_CHANGED'), 'edited plan content');
  const rebuilt = buildPlan(input({ now: later(5000) }));
  await assert.rejects(consumeApproval(dir, approval.id, ctx(rebuilt)), code('PLAN_CHANGED'), 'a different (re-built) plan');
  for (const profile of [{ id: 'profile-1', revision: 3 }, { id: 'profile-2', revision: 2 }, null])
    await assert.rejects(consumeApproval(dir, approval.id, ctx(plan, { profile })), code('PROFILE_CHANGED'), JSON.stringify(profile));
  await assert.rejects(consumeApproval(dir, approval.id, ctx(plan, { now: later(10 * 60 * 1000) })), code('APPROVAL_EXPIRED'));
  const { operations } = await consumeApproval(dir, approval.id, ctx(plan));
  assert.deepEqual(operations.map((op) => op.id).sort(), moves);
});

test('the keeper of a duplicate group can never be selected for deletion ("delete all copies")', async (t) => {
  const dir = await stateDir(t);
  // Both copies proposed for trash with each other as keeper: the plan itself is refused.
  assert.throws(() => buildPlan(input({ proposals: [trash(3, 'c (1).pdf', 'c.pdf'), trash(4, 'c.pdf', 'c (1).pdf')],
    occupied: { files: ['c (1).pdf', 'c.pdf'], directories: [] } })));
  const plan = buildPlan(input());
  // A hand-made plan that slips past the builder is caught by the plan contract before any approval is stored.
  const bad = { ...plan, operations: [...plan.operations, { ...plan.operations.find((op) => op.kind === 'trash')!, id: 'aaaaaaaaaaaaaaaa', fileId: h('e'), source: 'c.pdf', keeper: 'c (1).pdf' }] };
  await assert.rejects(issueApproval(dir, { plan: bad as OperationPlan, sessionId: grant.sessionId, operationIds: ['aaaaaaaaaaaaaaaa'], mode: 'trash', now: NOW }), code('PLAN_CHANGED'));
  assert.deepEqual(await readdir(dir).catch(() => []), [], 'nothing stored for refused requests');
});

test('only unchanged approved items are carried over after a re-scan; the selection never grows', () => {
  const first = buildPlan(input());
  const approved = ids(first, 'move').slice(0, 1);
  const moved = first.operations.find((op) => op.id === approved[0])!;
  const changedInput = input({ now: later(60_000), proposals: input().proposals.map((p) =>
    p.source === 'b.png' ? { ...p, expected: { ...p.expected, modifiedNs: '999999' } } : p) });
  const second = buildPlan(changedInput);
  const result = carryOverSelection(approved, second);
  assert.deepEqual(result.unchanged, approved, 'same file, same destination → same ID');
  assert.ok(result.needsConfirmation.length === second.operations.length - 1);
  assert.ok(result.unchanged.every((id) => approved.includes(id)));
  // If the approved file itself changed, it is no longer carried over.
  const third = buildPlan(input({ now: later(60_000), proposals: input().proposals.map((p) =>
    p.source === moved.source ? { ...p, expected: { ...p.expected, size: p.expected.size + 1 } } : p) }));
  assert.deepEqual(carryOverSelection(approved, third).unchanged, []);
});

test('two concurrent uses of one approval: exactly one succeeds', async (t) => {
  const dir = await stateDir(t);
  const plan = buildPlan(input());
  const approval = await issueApproval(dir, { plan, sessionId: grant.sessionId, operationIds: ids(plan, 'move'), mode: 'organize', now: NOW });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeApproval(dir, approval.id, ctx(plan))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results) if (r.status === 'rejected') code('APPROVAL_USED')(r.reason);
});

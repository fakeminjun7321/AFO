import test from 'node:test';
import assert from 'node:assert/strict';
import { AfoError, OperationPlanSchema, PreviewSchema } from '../packages/contracts/src/index.js';
import type { ErrorCode, OperationPlan, Preview, RootGrant, ScanResult } from '../packages/contracts/src/index.js';
import { approvalChoices, approvalCode, buildPlan, buildPreview, chooseKeeper, diffPlans, planHash, selectOperations }
  from '../packages/engine/src/index.js';
import type { BuildPlanOptions } from '../packages/engine/src/index.js';
import { LAST_COPY_REASON, LastCopyError } from '../packages/engine/src/plan.js';
import { scanFixture } from './helpers.js';

/* #8 plan builder: pure, synthetic snapshots only (no filesystem). */
const code = (expected: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === expected;
const A = 'a'.repeat(64); const B = 'b'.repeat(64); const C = 'c'.repeat(64); const D = 'd'.repeat(64);
const NOW = new Date('2026-10-26T01:00:00.000Z');
const grant: RootGrant = { formatVersion: 1, id: 'e'.repeat(64), canonicalPath: '/afo-fixture', device: '1', inode: '2', scope: 'work',
  sessionId: 'session-1234', issuedAt: NOW.toISOString() };

function scan(): ScanResult {
  const entries: [string, number, string | null][] = [['report.pdf', 10, A], ['report copy.pdf', 10, A], ['a.jpg', 20, B],
    ['이미지/b.jpg', 20, B], ['ref/old.txt', 5, C], ['notes', 7, null], ['clip.mp4', 30, D]];
  const s = scanFixture(entries.map(([name]) => name));
  entries.forEach(([, size, sha], i) => Object.assign(s.files[i]!, { size, sha256: sha }));
  s.directories = ['이미지', 'ref'];
  return s;
}
const preview = (s: ScanResult = scan()): Preview => buildPreview(s, { protectedPaths: ['ref/old.txt'] });
const opts = (over: Partial<BuildPlanOptions> = {}): BuildPlanOptions =>
  ({ scan: scan(), grant, sessionId: grant.sessionId, deleteMode: 'trash', now: NOW, ...over });
const bySource = (plan: OperationPlan) => Object.fromEntries(plan.operations.map((op) => [op.source, op]));
const reviewOf = (plan: OperationPlan) => Object.fromEntries(plan.reviewItems.map((r) => [r.source, r.status]));

test('same inputs give the same plan; the ID is the hash of the canonical plan without id', () => {
  const p = preview();
  const one = buildPlan(p, opts({ deleteSelections: 'all-duplicates' }));
  const two = buildPlan(PreviewSchema.parse(JSON.parse(JSON.stringify(p))), opts({ deleteSelections: 'all-duplicates' }));
  assert.deepEqual(one, two);
  assert.equal(one.id, planHash(one));
  assert.equal(one.expiresAt, '2026-10-26T02:00:00.000Z');
  assert.notEqual(buildPlan(p, opts({ now: new Date(NOW.getTime() + 1) })).id, one.id, 'time is part of the plan');
  assert.notEqual(buildPlan(p, opts({ deleteSelections: 'all-duplicates', deleteMode: 'permanent' })).id, one.id);
  OperationPlanSchema.parse(one);
});

test('moves come from preview moves; keep, review and protected files are review items, never operations', () => {
  const plan = buildPlan(preview(), opts());
  assert.deepEqual(Object.fromEntries(plan.operations.map((op) => [op.source, [op.kind, op.destination]])), {
    'a.jpg': ['move', '이미지/a.jpg'], 'clip.mp4': ['move', '영상/clip.mp4'],
    'report copy.pdf': ['move', '문서/report copy.pdf'], 'report.pdf': ['move', '문서/report.pdf'] });
  assert.deepEqual(reviewOf(plan), { notes: 'review', 'ref/old.txt': 'keep', '이미지/b.jpg': 'keep' });
  const op = bySource(plan)['clip.mp4']!;
  assert.deepEqual(op.expected, { size: 30, modifiedNs: '100000', device: '1', inode: '7', sha256: D });
  assert.deepEqual(plan.summary, { move: 4, trash: 0, delete: 0, logicalBytes: 70 });
  assert.equal(plan.rootGrantId, grant.id); assert.equal(plan.rootPath, grant.canonicalPath);
});

test('"all duplicates" deletes candidates only and keeps one keeper per group (its move is held back)', () => {
  for (const [mode, kind] of [['trash', 'trash'], ['permanent', 'delete']] as const) {
    const plan = buildPlan(preview(), opts({ deleteSelections: 'all-duplicates', deleteMode: mode }));
    const ops = bySource(plan);
    assert.deepEqual([ops['report.pdf']!.kind, ops['report.pdf']!.keeper], [kind, 'report copy.pdf']);
    assert.deepEqual([ops['이미지/b.jpg']!.kind, ops['이미지/b.jpg']!.keeper], [kind, 'a.jpg']);
    assert.equal(ops['report.pdf']!.expected.sha256, A);
    for (const keeper of ['report copy.pdf', 'a.jpg']) {
      assert.equal(ops[keeper], undefined, `${keeper} is not an operation`);
      assert.equal(reviewOf(plan)[keeper], 'keep');
    }
    assert.equal(ops['ref/old.txt'], undefined);
    assert.equal(plan.summary[kind], 2);
  }
});

test('keeper changes move the deletion to the other file and change only those operation IDs', () => {
  const base = preview();
  const groupA = base.duplicates.find((g) => g.sha256 === A)!;
  const before = buildPlan(base, opts({ deleteSelections: [{ sha256: A, candidates: groupA.candidates }] }));
  const changed = chooseKeeper(base, A, 'report.pdf');
  const after = buildPlan(changed, opts({ deleteSelections: [{ sha256: A, candidates: ['report copy.pdf'] }] }));
  assert.equal(bySource(after)['report copy.pdf']!.keeper, 'report.pdf');
  assert.equal(bySource(after)['report.pdf'], undefined);
  const diff = diffPlans(before, after);
  assert.deepEqual(diff.unchanged.length, 2, 'a.jpg and clip.mp4 moves are the same operations');
  assert.equal(diff.added.length, 1); assert.equal(diff.removed.length, 1);
  assert.equal(diff.rootChanged || diff.profileChanged || diff.deleteModeChanged, false);
});

test('invalid duplicate selections are KEEPER_INVALID; explicit deletes have no keeper and stay inside the analysis', () => {
  const p = preview();
  assert.throws(() => buildPlan(p, opts({ deleteSelections: [{ sha256: A, candidates: ['report copy.pdf'] }] })), code('KEEPER_INVALID'),
    'the keeper is not a candidate');
  assert.throws(() => buildPlan(p, opts({ deleteSelections: [{ sha256: A, candidates: ['clip.mp4'] }] })), code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(p, opts({ deleteSelections: [{ sha256: A, candidates: [] }] })), code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(p, opts({ deleteSelections: [{ sha256: C, candidates: ['ref/old.txt'] }] })), code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(p, opts({ deleteSelections: [{ sha256: A, candidates: ['report.pdf'] }, { sha256: A, candidates: ['report.pdf'] }] })),
    code('KEEPER_INVALID'));
  assert.throws(() => buildPlan(p, opts({ deleteSelections: 'all-duplicates', explicitDeletes: ['a.jpg'] })), code('KEEPER_INVALID'),
    'a keeper cannot also be chosen for deletion');
  assert.throws(() => buildPlan(p, opts({ explicitDeletes: ['ref/old.txt'] })), code('ROOT_FORBIDDEN'));
  assert.throws(() => buildPlan(p, opts({ explicitDeletes: ['missing.pdf'] })), code('SOURCE_MISSING'));
  // A forged preview whose group claims a file with other content is refused against the scan hashes.
  const forged = PreviewSchema.parse({ ...p, duplicates: p.duplicates.map((g) => g.sha256 === A
    ? { ...g, candidates: ['report.pdf'], members: undefined } : g) });
  const s = scan(); s.files[0]!.sha256 = D;
  assert.throws(() => buildPlan(forged, opts({ scan: s, deleteSelections: [{ sha256: A, candidates: ['report.pdf'] }] })), code('KEEPER_INVALID'));
  const plan = buildPlan(p, opts({ explicitDeletes: ['notes'], deleteMode: 'permanent' }));
  assert.deepEqual([bySource(plan)['notes']!.kind, bySource(plan)['notes']!.keeper], ['delete', null]);
});

test('O-4: deleting every copy of one content is refused unless allowLastCopy is exactly true; single files need no flag', () => {
  const p = preview();
  const both = ['report.pdf', 'report copy.pdf'];
  const refused = (over: Partial<BuildPlanOptions>): void => {
    assert.throws(() => buildPlan(p, opts(over)), (e: unknown) => e instanceof LastCopyError && e.code === 'KEEPER_INVALID' &&
      /마지막 사본/u.test(e.message) && e.paths.join() === 'report copy.pdf,report.pdf');
  };
  refused({ explicitDeletes: both });
  refused({ explicitDeletes: both, deleteMode: 'permanent' });
  refused({ explicitDeletes: both, allowLastCopy: 'yes' as unknown as boolean });
  refused({ explicitDeletes: both, allowLastCopy: false });
  for (const mode of ['trash', 'permanent'] as const) {
    const plan = buildPlan(p, opts({ explicitDeletes: both, allowLastCopy: true, deleteMode: mode }));
    for (const source of both) {
      assert.equal(bySource(plan)[source]!.keeper, null);
      assert.equal(bySource(plan)[source]!.reason, LAST_COPY_REASON);
    }
  }
  // Not a last copy: one file of a pair, a file with unique content, an unhashed file, or a duplicate deletion that keeps its keeper.
  for (const over of [{ explicitDeletes: ['report.pdf'] }, { explicitDeletes: ['clip.mp4', 'notes'] },
    { deleteSelections: 'all-duplicates' as const }, { deleteSelections: 'all-duplicates' as const, explicitDeletes: ['clip.mp4'] }]) {
    const plan = buildPlan(p, opts(over));
    assert.ok(plan.operations.every((op) => op.reason !== LAST_COPY_REASON), JSON.stringify(over));
  }
  assert.equal(bySource(buildPlan(p, opts({ explicitDeletes: ['clip.mp4'] })))['clip.mp4']!.reason, '사용자가 직접 고른 삭제 파일입니다.');
});

test('a move onto or below another file of the plan, or colliding with another move, becomes review', () => {
  const p = preview();
  const edit = (changes: Record<string, string>): Preview => PreviewSchema.parse({ ...p, items: p.items.map((i) =>
    changes[i.source] ? { ...i, action: 'move', destination: changes[i.source], reasonCode: 'USER_OVERRIDE' } : i) });
  const onKeep = buildPlan(edit({ 'clip.mp4': '이미지/b.jpg' }), opts());
  assert.equal(reviewOf(onKeep)['clip.mp4'], 'review');
  const onReview = buildPlan(edit({ 'clip.mp4': 'notes/clip.mp4' }), opts());
  assert.equal(reviewOf(onReview)['clip.mp4'], 'review', 'a file path cannot become a folder');
  const collide = buildPlan(edit({ 'clip.mp4': 'x/same.mp4', 'a.jpg': 'X/SAME.mp4' }), opts());
  assert.deepEqual([reviewOf(collide)['clip.mp4'], reviewOf(collide)['a.jpg']], ['review', 'review']);
  const parent = buildPlan(edit({ 'clip.mp4': 'x/y', 'a.jpg': 'x/y/a.jpg' }), opts());
  assert.deepEqual([reviewOf(parent)['clip.mp4'], reviewOf(parent)['a.jpg']], ['review', 'review']);
  OperationPlanSchema.parse(parent);
});

test('wrong root, session, cancelled analysis and preview/scan mismatch are refused', () => {
  const p = preview();
  assert.throws(() => buildPlan(p, opts({ sessionId: 'other-session' })), code('ROOT_FORBIDDEN'));
  assert.throws(() => buildPlan(p, opts({ grant: { ...grant, canonicalPath: '/afo-other' } })), code('ROOT_FORBIDDEN'));
  assert.throws(() => buildPlan(PreviewSchema.parse({ ...p, cancelled: true }), opts()), code('CANCELLED'));
  const s = scan(); s.files[6]!.relativePath = 'clip2.mp4';
  assert.throws(() => buildPlan(p, opts({ scan: s })), code('PLAN_CHANGED'));
  assert.throws(() => buildPlan(p, { ...opts(), now: new Date(Number.NaN) }), TypeError);
});

test('a changed file (new mtime) changes only its operation ID', () => {
  const before = buildPlan(preview(), opts());
  const s = scan(); s.files[6]!.modifiedNs = '200000';
  const after = buildPlan(preview(s), opts({ scan: s }));
  const diff = diffPlans(before, after);
  assert.deepEqual([diff.added, diff.removed].map((x) => x.map((id) => after.operations.concat(before.operations).find((o) => o.id === id)!.source)),
    [['clip.mp4'], ['clip.mp4']]);
  assert.equal(diff.unchanged.length, 3);
});

test('approval codes bind plan, sorted IDs and mode; one mode per approval', () => {
  const plan = buildPlan(preview(), opts({ deleteSelections: 'all-duplicates' }));
  const choices = approvalChoices(plan);
  assert.deepEqual(choices.map((c) => [c.mode, c.operationIds.length]), [['organize', 1], ['trash', 2]]);
  const trash = choices[1]!;
  assert.match(trash.code, /^[a-f0-9]{8}$/u);
  assert.equal(approvalCode(plan.id, [...trash.operationIds].reverse(), 'trash'), trash.code, 'order does not matter');
  assert.notEqual(approvalCode(plan.id, trash.operationIds.slice(0, 1), 'trash'), trash.code);
  assert.notEqual(approvalCode(plan.id, trash.operationIds, 'permanent-delete'), trash.code);
  const move = choices[0]!.operationIds[0]!;
  assert.throws(() => selectOperations(plan, [move, ...trash.operationIds], 'trash'), code('MODE_MISMATCH'));
  assert.throws(() => selectOperations(plan, trash.operationIds, 'permanent-delete'), code('MODE_MISMATCH'));
  assert.throws(() => selectOperations(plan, ['0123456789abcdef'], 'organize'), code('APPROVAL_INVALID'));
  assert.throws(() => selectOperations(plan, [move, move], 'organize'), code('APPROVAL_INVALID'));
  assert.throws(() => selectOperations(plan, [], 'organize'), code('APPROVAL_INVALID'));
});

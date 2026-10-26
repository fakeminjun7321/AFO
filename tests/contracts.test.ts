import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AfoError, ApprovalSchema, ErrorCodeSchema, ExecutionReportSchema, FileSchema, JournalEntrySchema, OperationPlanSchema,
  PlanOperationSchema, ProfileSchema, ReferenceGrantSchema, RelativePathSchema, RootGrantSchema, ScanSchema, approvalModeKind,
  isAfoError } from '../packages/contracts/src/index.js';
import { scanFixture } from './helpers.js';

test('portable relative paths reject traversal, absolute paths and Windows aliases', () => {
  for (const value of ['../secret', '/secret', 'C:/secret', 'a\\b', 'a//b', './a', 'a/../b', 'NUL.txt', 'a/CON', 'a./b', 'a\0b'])
    assert.equal(RelativePathSchema.safeParse(value).success, false, value);
  for (const value of ['물리/실험 보고서.hwpx', '사진/😀.jpg', '문서/a.pdf'])
    assert.equal(RelativePathSchema.parse(value), value);
});
test('file contracts require complete, correctly typed evidence', () => {
  const file = scanFixture(['a.pdf']).files[0]!;
  const { modifiedNs: _, ...missing } = file;
  assert.throws(() => FileSchema.parse(missing));
  assert.throws(() => FileSchema.parse({ ...file, size: '20' }));
  assert.throws(() => FileSchema.parse({ ...file, size: 0.5 }));
  assert.throws(() => FileSchema.parse({ ...file, approved: true }));
});
test('scans reject duplicate records and spoofed boolean state', () => {
  const scan = scanFixture(['a.pdf']);
  assert.throws(() => ScanSchema.parse({ ...scan, files: [scan.files[0], scan.files[0]] }));
  assert.throws(() => ScanSchema.parse({ ...scan, complete: 'true' }));
  assert.throws(() => ProfileSchema.parse({ status: 'confirmed', rules: [] }));
});

const h = (c: string): string => c.repeat(64);
const now = '2026-10-26T01:00:00.000Z';
const minutes = (n: number): string => new Date(Date.parse(now) + n * 60_000).toISOString();
const expected = (sha256: string | null = null) => ({ size: 10, modifiedNs: '1', device: '1', inode: '2', sha256 });
const op = (id: string, kind: 'move' | 'trash' | 'delete', source: string, extra: Record<string, unknown> = {}) => ({
  id, kind, fileId: createHash('sha256').update(source).digest('hex'), source,
  destination: kind === 'move' ? `정리/${source}` : null, reason: '테스트', ruleId: null, keeper: null, expected: expected(), ...extra });
const plan = (operations: unknown[], extra: Record<string, unknown> = {}) => ({
  formatVersion: 1, id: h('1'), rootGrantId: h('2'), rootPath: '/afo-fixture', sessionId: 'session-0001',
  createdAt: now, expiresAt: minutes(30), profileId: null, profileRevision: null, deleteMode: 'trash', operations,
  reviewItems: [], summary: { move: 1, trash: 0, delete: 0, logicalBytes: 10 }, ...extra });
const approval = (extra: Record<string, unknown> = {}) => ({
  formatVersion: 1, id: 'approval-0001', planId: h('1'), sessionId: 'session-0001', rootGrantId: h('2'),
  operationIds: ['0000000a', '0000000b'], mode: 'organize', profileId: 'p1', profileRevision: 2,
  issuedAt: now, expiresAt: minutes(10), usedAt: null, ...extra });
const entry = (extra: Record<string, unknown> = {}) => ({
  formatVersion: 1, runId: 'run-00000001', seq: 0, opId: '0000000a', planId: h('1'), rootGrantId: h('2'), approvalId: 'approval-0001', phase: 'intent',
  kind: 'move', source: 'a.pdf', destination: '문서/a.pdf', before: { device: '1', inode: '2', size: 10, sha256: null },
  after: null, errorCode: null, at: now, ...extra });
const fails = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown, label: string): void =>
  assert.equal(schema.safeParse(value).success, false, label);

test('error codes are a closed set and AfoError carries one', () => {
  const error = new AfoError('DEST_EXISTS', '이미 있음');
  assert.equal(error.code, 'DEST_EXISTS'); assert.ok(error instanceof Error); assert.ok(isAfoError(error, 'DEST_EXISTS'));
  assert.equal(isAfoError(new Error('x')), false);
  assert.throws(() => new AfoError('NOPE' as never, 'x'));
  assert.equal(ErrorCodeSchema.safeParse('UNKNOWN').success, true);
});
test('root and reference grants require full identity and the right scope', () => {
  const grant = { formatVersion: 1, id: h('a'), canonicalPath: '/afo-fixture', device: '1', inode: '2',
    sessionId: 'session-0001', issuedAt: now, scope: 'work' };
  assert.equal(RootGrantSchema.parse(grant).scope, 'work');
  assert.equal(RootGrantSchema.safeParse({ ...grant, canonicalPath: 'C:\\afo' }).success, true);
  const { inode: _, ...missing } = grant;
  fails(RootGrantSchema, missing, 'missing inode');
  fails(RootGrantSchema, { ...grant, device: 1 }, 'numeric device');
  fails(RootGrantSchema, { ...grant, canonicalPath: 'relative/path' }, 'relative path');
  assert.equal(RootGrantSchema.safeParse({ ...grant, canonicalPath: '\\\\server\\share\\afo' }).success, true, 'UNC share');
  fails(RootGrantSchema, { ...grant, canonicalPath: '\\\\?\\C:\\afo' }, 'Win32 namespace path');
  fails(RootGrantSchema, { ...grant, canonicalPath: '\\\\.\\PhysicalDrive0' }, 'device path');
  fails(RootGrantSchema, { ...grant, issuedAt: 'yesterday' }, 'bad date');
  fails(RootGrantSchema, { ...grant, scope: 'reference' }, 'reference scope as root');
  fails(RootGrantSchema, { ...grant, formatVersion: 2 }, 'version');
  const reference = { ...grant, scope: 'reference', readOnly: true };
  assert.equal(ReferenceGrantSchema.parse(reference).readOnly, true);
  fails(ReferenceGrantSchema, { ...grant, scope: 'reference' }, 'readOnly missing');
  fails(ReferenceGrantSchema, { ...reference, readOnly: false }, 'readOnly false');
  fails(ReferenceGrantSchema, { ...reference, scope: 'work' }, 'work scope as reference');
});
test('plan operations allow destinations only on moves and validate keepers', () => {
  assert.equal(PlanOperationSchema.parse(op('0000000a', 'move', 'a.pdf')).kind, 'move');
  fails(PlanOperationSchema, op('0000000a', 'trash', 'a.pdf', { destination: 'x/a.pdf' }), 'trash with destination');
  fails(PlanOperationSchema, op('0000000a', 'move', 'a.pdf', { destination: null }), 'move without destination');
  fails(PlanOperationSchema, op('0000000a', 'move', 'a.pdf', { destination: 'A.pdf' }), 'move onto itself (case)');
  fails(PlanOperationSchema, op('0000000a', 'move', 'a.pdf', { destination: '../a.pdf' }), 'traversal');
  fails(PlanOperationSchema, op('0000000a', 'delete', 'a.pdf', { keeper: 'b.pdf' }), 'keeper without hash');
  fails(PlanOperationSchema, op('0000000a', 'delete', 'a.pdf', { keeper: 'a.pdf', expected: expected(h('c')) }), 'keeper is source');
  fails(PlanOperationSchema, op('0000000a', 'move', 'a.pdf', { keeper: 'b.pdf', expected: expected(h('c')) }), 'move with keeper');
  fails(PlanOperationSchema, op('XYZ', 'trash', 'a.pdf'), 'bad op id');
  fails(PlanOperationSchema, op('0000000a', 'purge' as never, 'a.pdf'), 'unknown kind');
  fails(PlanOperationSchema, { ...op('0000000a', 'trash', 'a.pdf'), approved: true }, 'extra key');
  assert.equal(PlanOperationSchema.safeParse(op('0000000a', 'delete', 'a.pdf', { keeper: 'b.pdf', expected: expected(h('c')) })).success, true);
});
test('operation plans keep summary, ids, destinations, keepers and delete mode consistent', () => {
  const move = op('0000000a', 'move', 'a.pdf');
  const valid = plan([move]);
  assert.equal(OperationPlanSchema.parse(valid).summary.move, 1);
  const two = { move: 2, trash: 0, delete: 0, logicalBytes: 20 };
  assert.equal(OperationPlanSchema.safeParse(plan([move, op('0000000b', 'move', 'b.pdf')], { summary: two })).success, true);
  fails(OperationPlanSchema, plan([move, op('0000000a', 'move', 'b.pdf')], { summary: two }), 'duplicate op id');
  fails(OperationPlanSchema, plan([move], { summary: { move: 1, trash: 0, delete: 0, logicalBytes: 11 } }), 'bytes mismatch');
  fails(OperationPlanSchema, plan([move], { summary: { move: 0, trash: 1, delete: 0, logicalBytes: 10 } }), 'count mismatch');
  fails(OperationPlanSchema, plan([move, op('0000000b', 'move', 'b.pdf', { destination: '정리/a.pdf' })], { summary: two }), 'same destination');
  fails(OperationPlanSchema, plan([move, op('0000000b', 'move', 'b.pdf', { destination: 'a.pdf' })], { summary: two }), 'destination is another source');
  fails(OperationPlanSchema, plan([move, { ...op('0000000b', 'move', 'b.pdf'), fileId: move.fileId }], { summary: two }), 'same file twice');
  const keeperIsTarget = op('0000000b', 'trash', 'b.pdf', { keeper: 'a.pdf', expected: expected(h('c')) });
  fails(OperationPlanSchema, plan([move, keeperIsTarget], { summary: { move: 1, trash: 1, delete: 0, logicalBytes: 20 } }), 'keeper is in plan');
  const del = op('0000000b', 'delete', 'b.pdf');
  fails(OperationPlanSchema, plan([del], { summary: { move: 0, trash: 0, delete: 1, logicalBytes: 10 } }), 'delete in trash mode');
  assert.equal(OperationPlanSchema.safeParse(plan([del], { deleteMode: 'permanent', summary: { move: 0, trash: 0, delete: 1, logicalBytes: 10 } })).success, true);
  fails(OperationPlanSchema, plan([op('0000000b', 'trash', 'b.pdf')], { deleteMode: 'permanent', summary: { move: 0, trash: 1, delete: 0, logicalBytes: 10 } }), 'trash in permanent mode');
  fails(OperationPlanSchema, plan([move], { profileId: 'p1' }), 'profile id without revision');
  assert.equal(OperationPlanSchema.safeParse(plan([move], { profileId: 'p1', profileRevision: 3 })).success, true);
  fails(OperationPlanSchema, plan([move], { expiresAt: now }), 'expires at creation');
  fails(OperationPlanSchema, plan([move], { reviewItems: [{ fileId: move.fileId, source: 'a.pdf', status: 'review', reason: 'x' }] }), 'op and review item for one file');
  const { summary: _, ...noSummary } = valid;
  fails(OperationPlanSchema, noSummary, 'missing summary');
  fails(OperationPlanSchema, { ...valid, operations: 'all' }, 'operations wrong type');
  fails(OperationPlanSchema, { ...valid, approved: true }, 'spoofed approval flag');
});
test('approvals are sorted, bounded in time and bound to one profile revision', () => {
  assert.equal(ApprovalSchema.parse(approval()).mode, 'organize');
  assert.deepEqual(approvalModeKind, { organize: 'move', trash: 'trash', 'permanent-delete': 'delete' });
  fails(ApprovalSchema, approval({ operationIds: ['0000000b', '0000000a'] }), 'unsorted ids');
  fails(ApprovalSchema, approval({ operationIds: ['0000000a', '0000000a'] }), 'duplicate ids');
  fails(ApprovalSchema, approval({ operationIds: [] }), 'empty selection');
  fails(ApprovalSchema, approval({ expiresAt: minutes(-1) }), 'expires before issue');
  fails(ApprovalSchema, approval({ expiresAt: now }), 'expires at issue');
  fails(ApprovalSchema, approval({ expiresAt: minutes(11) }), 'longer than ttl');
  fails(ApprovalSchema, approval({ usedAt: minutes(-1) }), 'used before issue');
  fails(ApprovalSchema, approval({ profileRevision: null }), 'profile id without revision');
  fails(ApprovalSchema, approval({ mode: 'all' }), 'unknown mode');
  fails(ApprovalSchema, approval({ approved: true }), 'boolean approval');
  const { planId: _, ...noPlan } = approval();
  fails(ApprovalSchema, noPlan, 'missing plan id');
  assert.equal(ApprovalSchema.safeParse(approval({ profileId: null, profileRevision: null, usedAt: minutes(1) })).success, true);
});
test('journal entries and reports tie error codes and identities to phases', () => {
  assert.equal(JournalEntrySchema.parse(entry()).phase, 'intent');
  const { planId: _p, ...noPlan } = entry(); fails(JournalEntrySchema, noPlan, 'journal without planId');
  const { rootGrantId: _r, ...noRoot } = entry(); fails(JournalEntrySchema, noRoot, 'journal without rootGrantId');
  const after = { device: '1', inode: '2', size: 10, sha256: null };
  assert.equal(JournalEntrySchema.safeParse(entry({ phase: 'done', after })).success, true);
  assert.equal(JournalEntrySchema.safeParse(entry({ phase: 'skipped', errorCode: 'FILE_CHANGED' })).success, true);
  fails(JournalEntrySchema, entry({ phase: 'done' }), 'done move without after');
  fails(JournalEntrySchema, entry({ after }), 'intent with after');
  fails(JournalEntrySchema, entry({ phase: 'failed' }), 'failed without code');
  fails(JournalEntrySchema, entry({ phase: 'failed', errorCode: 'NOT_A_CODE' }), 'unknown code');
  fails(JournalEntrySchema, entry({ errorCode: 'DEST_EXISTS' }), 'intent with code');
  fails(JournalEntrySchema, entry({ kind: 'trash' }), 'trash with destination');
  fails(JournalEntrySchema, entry({ kind: 'trash', destination: null, phase: 'undone' }), 'undo of trash');
  fails(JournalEntrySchema, entry({ seq: -1 }), 'negative seq');
  const report = { formatVersion: 1, runId: 'run-00000001', planId: h('1'), approvalId: 'approval-0001',
    results: [{ opId: '0000000a', status: 'moved', errorCode: null, detail: '' },
      { opId: '0000000b', status: 'failed', errorCode: 'FILE_CHANGED', detail: '변경됨' }],
    space: { logicalBytesSelected: 20, freeBytesBefore: null, freeBytesAfter: null, note: '휴지통은 확보량이 아닙니다.' } };
  assert.equal(ExecutionReportSchema.parse(report).results.length, 2);
  fails(ExecutionReportSchema, { ...report, results: [report.results[0], report.results[0]] }, 'duplicate result');
  fails(ExecutionReportSchema, { ...report, results: [{ ...report.results[1], errorCode: null }] }, 'failed without code');
  fails(ExecutionReportSchema, { ...report, results: [{ ...report.results[0], errorCode: 'UNKNOWN' }] }, 'success with code');
  fails(ExecutionReportSchema, { ...report, space: { ...report.space, freeBytesAfter: -1 } }, 'negative bytes');
});

/**
 * #4 verifier tests (independent of the builder's tests). Synthetic temp data only.
 * V4-F3 and V4-S7 were updated after the builder fixes in 61c737d/bfd5970 (re-verification on integ/m1).
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes,
  writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AfoError, APPROVAL_TTL_MS, ApprovalSchema, ErrorCodeSchema, ExecutionReportSchema, isAfoError, JournalEntrySchema,
  OperationPlanSchema, PlanOperationSchema, PreviewSchema, ProfileSchema, ReferenceGrantSchema, RootGrantSchema,
  ScanSchema } from '../packages/contracts/src/index.js';
import type { ErrorCode, JournalEntry } from '../packages/contracts/src/index.js';
import { appendJournal, assertStateDirOutside, journalFile, MAX_STATE_JSON_BYTES, readJournal, readJson, resolveStateDir,
  statePaths, writeJsonAtomic } from '../packages/filesystem/src/state.js';
import { createFixture, createManifest, diffManifest, FIXTURE_PREFIX, sameManifest } from './fixtures/index.js';

type Obj = Record<string, unknown>;
const H = (c: string): string => c.repeat(64);
const T0 = '2026-10-26T01:00:00.000Z';
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const clone = <V>(v: V): V => structuredClone(v);
const ok = (schema: z.ZodType, value: unknown, label = ''): void => {
  const r = schema.safeParse(value);
  assert.ok(r.success, `${label} expected valid: ${r.success ? '' : JSON.stringify(r.error.issues)}`);
};
const bad = (schema: z.ZodType, value: unknown, label: string): void =>
  assert.equal(schema.safeParse(value).success, false, `${label} must be rejected`);
const withAt = (base: Obj, dotted: string, edit: (target: Obj) => void): Obj => {
  const copy = clone(base);
  let target: unknown = copy;
  for (const part of dotted === '' ? [] : dotted.split('.')) target = (target as Obj)[part];
  edit(target as Obj);
  return copy;
};
const wrongType = (v: unknown): unknown => typeof v === 'string' ? 123 : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : v === null ? {} : Array.isArray(v) ? {} : [];
/** Every key at each listed object level: removal, wrong type, plus an extra `approved: true` key. */
function mutateAll(schema: z.ZodType, valid: Obj, levels: string[], name: string): number {
  let count = 0;
  for (const level of ['', ...levels]) {
    let target: unknown = valid;
    for (const part of level === '' ? [] : level.split('.')) target = (target as Obj)[part];
    for (const key of Object.keys(target as Obj)) {
      bad(schema, withAt(valid, level, (o) => { delete o[key]; }), `${name}: remove ${level}.${key}`);
      bad(schema, withAt(valid, level, (o) => { o[key] = wrongType(o[key]); }), `${name}: wrong type ${level}.${key}`);
      count += 2;
    }
    bad(schema, withAt(valid, level, (o) => { o['approved'] = true; }), `${name}: extra approved at ${level || 'top'}`);
    count += 1;
  }
  return count;
}
const BAD_HEX = [H('A'), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`, '', ` ${'a'.repeat(63)}`];

/* ---------------- valid examples ---------------- */
const rootGrant: Obj = { formatVersion: 1, id: H('a'), canonicalPath: '/afo-verify/root', device: '16777230', inode: '4242',
  scope: 'work', sessionId: 'session-0001', issuedAt: T0 };
const referenceGrant: Obj = { ...clone(rootGrant), scope: 'reference', readOnly: true, canonicalPath: '/afo-verify/reference' };
const expected = (size: number, sha256: string | null = null): Obj => ({ size, modifiedNs: '1761440400000000000', device: '1', inode: '7', sha256 });
const moveOp: Obj = { id: '0000000a', kind: 'move', fileId: H('b'), source: '보고서 최종.pdf', destination: '문서/보고서 최종.pdf',
  reason: '기본 규칙: 문서', ruleId: null, keeper: null, expected: expected(6) };
const deleteOp: Obj = { id: '0000000b', kind: 'delete', fileId: H('c'), source: '같은 내용 2.zip', destination: null,
  reason: '내용 해시가 같은 중복', ruleId: null, keeper: '같은 내용 1.zip', expected: expected(10, H('d')) };
const trashOp: Obj = { ...clone(deleteOp), id: '0000000c', kind: 'trash' };
const plan: Obj = { formatVersion: 1, id: H('e'), rootGrantId: H('a'), rootPath: '/afo-verify/root', sessionId: 'session-0001',
  createdAt: T0, expiresAt: at(3_600_000), profileId: 'profile-1', profileRevision: 2, deleteMode: 'permanent',
  operations: [clone(moveOp), clone(deleteOp)],
  reviewItems: [{ fileId: H('f'), source: '같은 내용 1.zip', status: 'keep', reason: '남길 원본' }],
  summary: { move: 1, trash: 0, delete: 1, logicalBytes: 16 } };
const approval: Obj = { formatVersion: 1, id: 'approval-0001', planId: H('e'), sessionId: 'session-0001', rootGrantId: H('a'),
  operationIds: ['0000000a'], mode: 'organize', profileId: 'profile-1', profileRevision: 2, issuedAt: T0,
  expiresAt: at(APPROVAL_TTL_MS), usedAt: null };
const journalDone: Obj = { formatVersion: 1, runId: 'run-00000001', seq: 1, opId: '0000000a', approvalId: 'approval-0001',
  phase: 'done', kind: 'move', source: '보고서 최종.pdf', destination: '문서/보고서 최종.pdf',
  before: { device: '1', inode: '7', size: 6, sha256: null }, after: { device: '1', inode: '7', size: 6, sha256: null },
  errorCode: null, at: T0 };
const report: Obj = { formatVersion: 1, runId: 'run-00000001', planId: H('e'), approvalId: 'approval-0001',
  results: [{ opId: '0000000a', status: 'moved', errorCode: null, detail: '' },
    { opId: '0000000b', status: 'failed', errorCode: 'FILE_CHANGED', detail: '미리보기 이후 크기가 바뀜' }],
  space: { logicalBytesSelected: 16, freeBytesBefore: 1000, freeBytesAfter: null, note: '휴지통 이동은 확보량이 아닙니다.' } };

/* ---------------- contracts ---------------- */
test('V4-C1 every new schema accepts its valid example and rejects each removed key, wrong type and extra approved key', () => {
  const cases: [string, z.ZodType, Obj, string[]][] = [
    ['RootGrant', RootGrantSchema, rootGrant, []],
    ['ReferenceGrant', ReferenceGrantSchema, referenceGrant, []],
    ['PlanOperation(move)', PlanOperationSchema, moveOp, ['expected']],
    ['PlanOperation(delete)', PlanOperationSchema, deleteOp, ['expected']],
    ['OperationPlan', OperationPlanSchema, plan, ['summary', 'operations.0', 'operations.0.expected', 'reviewItems.0']],
    ['Approval', ApprovalSchema, approval, []],
    ['JournalEntry', JournalEntrySchema, journalDone, ['before', 'after']],
    ['ExecutionReport', ExecutionReportSchema, report, ['space', 'results.0']],
  ];
  let total = 0;
  for (const [name, schema, valid, levels] of cases) { ok(schema, valid, name); total += mutateAll(schema, valid, levels, name); }
  assert.ok(total > 200, `ran ${total} mutations`);
});

test('V4-C2 grants: hex, path, digits, scope and readOnly boundaries; work and reference grants are not interchangeable', () => {
  for (const id of BAD_HEX) bad(RootGrantSchema, { ...rootGrant, id }, `grant id ${JSON.stringify(id)}`);
  for (const p of ['', 'relative/root', './root', '/afo\u0000x', 'C:relative', 'x'.repeat(4097)])
    bad(RootGrantSchema, { ...rootGrant, canonicalPath: p }, `canonicalPath ${JSON.stringify(p.slice(0, 20))}`);
  for (const p of ['/afo', 'C:\\AFO-Test', 'D:/x', '\\\\server\\share']) ok(RootGrantSchema, { ...rootGrant, canonicalPath: p }, p);
  for (const d of ['', '-1', '1.5', ' 1', 1]) bad(RootGrantSchema, { ...rootGrant, device: d }, `device ${String(d)}`);
  for (const s of ['short', 'has space-0001', '../../x-0001', 'x'.repeat(129), 'a/b/c/d/e']) bad(RootGrantSchema, { ...rootGrant, sessionId: s }, `session ${s}`);
  for (const t of ['2026-10-26', 'yesterday', '']) bad(RootGrantSchema, { ...rootGrant, issuedAt: t }, `issuedAt ${t}`);
  bad(RootGrantSchema, referenceGrant, 'reference grant as root grant');
  bad(RootGrantSchema, { ...rootGrant, scope: 'reference' }, 'root grant with reference scope');
  bad(RootGrantSchema, { ...rootGrant, readOnly: true }, 'root grant with readOnly');
  bad(ReferenceGrantSchema, rootGrant, 'root grant as reference grant');
  bad(ReferenceGrantSchema, { ...referenceGrant, readOnly: false }, 'reference readOnly false');
  bad(ReferenceGrantSchema, { ...referenceGrant, scope: 'work' }, 'reference with work scope');
  bad(RootGrantSchema, { ...rootGrant, formatVersion: 2 }, 'formatVersion 2');
});

test('V4-C3 PlanOperation boundaries: sizes, ids, hashes, destination and keeper rules', () => {
  const op = (patch: Obj, base: Obj = moveOp): Obj => ({ ...clone(base), ...patch });
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])
    bad(PlanOperationSchema, op({ expected: { ...expected(0), size } }), `size ${size}`);
  ok(PlanOperationSchema, op({ expected: expected(0) }), 'size 0 (empty file)');
  ok(PlanOperationSchema, op({ expected: expected(Number.MAX_SAFE_INTEGER) }), 'size MAX_SAFE_INTEGER');
  for (const sha of BAD_HEX) bad(PlanOperationSchema, op({ expected: expected(6, sha) }), `expected.sha256 ${sha.slice(0, 8)}`);
  for (const sha of BAD_HEX) bad(PlanOperationSchema, op({ fileId: sha }), `fileId ${sha.slice(0, 8)}`);
  for (const id of ['0a', '0000000A', 'zzzzzzzz', 'a'.repeat(65), '0000-000a']) bad(PlanOperationSchema, op({ id }), `op id ${id}`);
  bad(PlanOperationSchema, op({ expected: { ...expected(6), modifiedNs: '-1' } }), 'negative modifiedNs');
  bad(PlanOperationSchema, op({ kind: 'copy' }), 'kind copy');
  bad(PlanOperationSchema, op({ destination: null }), 'move without destination');
  bad(PlanOperationSchema, op({ destination: '문서/x.pdf' }, trashOp), 'trash with destination');
  bad(PlanOperationSchema, op({ destination: '보고서 최종.PDF' }), 'destination equals source (case)');
  bad(PlanOperationSchema, op({ destination: '보고서 최종.pdf'.normalize('NFD') }), 'destination equals source (NFD)');
  for (const d of ['../밖.pdf', '/abs.pdf', '문서\\x.pdf', '문서//x.pdf', '문서/./x.pdf', 'CON', '문서/x.pdf.', 'a:b'])
    bad(PlanOperationSchema, op({ destination: d }), `destination ${d}`);
  bad(PlanOperationSchema, op({ reason: '' }), 'empty reason');
  bad(PlanOperationSchema, op({ keeper: '같은 내용 1.zip' }), 'keeper on move');
  bad(PlanOperationSchema, op({ keeper: '같은 내용 2.ZIP' }, deleteOp), 'keeper equals delete source (case)');
  bad(PlanOperationSchema, op({ expected: expected(10) }, deleteOp), 'keeper without content hash');
  bad(PlanOperationSchema, op({ keeper: '../같은 내용 1.zip' }, deleteOp), 'keeper outside root');
  const missingKeeper = op({}, deleteOp); delete missingKeeper['keeper'];
  bad(PlanOperationSchema, missingKeeper, 'delete op with keeper key missing');
  // Design: a selected non-duplicate file may be deleted without a keeper; keeper:null is accepted on purpose.
  ok(PlanOperationSchema, op({ keeper: null, expected: expected(10) }, deleteOp), 'delete without duplicate keeper (by design)');
  ok(PlanOperationSchema, trashOp, 'trash with keeper');
});

test('V4-C4 OperationPlan consistency: summary, uniqueness, collisions, keeper, delete mode and profile binding', () => {
  const p = (edit: (o: Obj) => void): Obj => withAt(plan, '', edit);
  const ops = (o: Obj): Obj[] => o['operations'] as Obj[];
  bad(OperationPlanSchema, p((o) => { (o['summary'] as Obj)['move'] = 2; }), 'summary count mismatch');
  bad(OperationPlanSchema, p((o) => { (o['summary'] as Obj)['logicalBytes'] = 15; }), 'logicalBytes mismatch');
  bad(OperationPlanSchema, p((o) => { (o['summary'] as Obj)['logicalBytes'] = -16; }), 'negative logicalBytes');
  bad(OperationPlanSchema, p((o) => { ops(o)[1]!['id'] = '0000000a'; }), 'duplicate op id');
  bad(OperationPlanSchema, p((o) => { ops(o)[1]!['source'] = '보고서 최종.PDF'; }), 'two ops on one source (case)');
  bad(OperationPlanSchema, p((o) => { ops(o)[1]!['fileId'] = H('b'); }), 'two ops on one fileId');
  bad(OperationPlanSchema, p((o) => { (o['reviewItems'] as Obj[])[0]!['source'] = '보고서 최종.pdf'; }), 'op and review on one file');
  bad(OperationPlanSchema, p((o) => {
    const second = { ...clone(moveOp), id: '0000000d', fileId: H('9'), source: 'b.pdf', destination: '문서/보고서 최종.PDF' };
    ops(o).push(second); (o['summary'] as Obj)['move'] = 2; (o['summary'] as Obj)['logicalBytes'] = 22;
  }), 'two destinations collide (case)');
  bad(OperationPlanSchema, p((o) => { ops(o)[0]!['destination'] = '같은 내용 2.zip'; }), 'destination is another op source');
  bad(OperationPlanSchema, p((o) => {
    ops(o)[1]!['keeper'] = '보고서 최종.pdf';
  }), 'keeper is another op source');
  bad(OperationPlanSchema, p((o) => { o['deleteMode'] = 'trash'; }), 'deleteMode trash with delete op');
  bad(OperationPlanSchema, p((o) => { ops(o)[1]!['kind'] = 'trash'; (o['summary'] as Obj)['delete'] = 0; (o['summary'] as Obj)['trash'] = 1; }),
    'deleteMode permanent with trash op');
  ok(OperationPlanSchema, p((o) => { o['deleteMode'] = 'trash'; ops(o)[1]!['kind'] = 'trash'; (o['summary'] as Obj)['delete'] = 0; (o['summary'] as Obj)['trash'] = 1; }),
    'trash plan');
  bad(OperationPlanSchema, p((o) => { o['profileRevision'] = null; }), 'profileId without revision');
  bad(OperationPlanSchema, p((o) => { o['profileId'] = null; }), 'revision without profileId');
  bad(OperationPlanSchema, p((o) => { o['profileRevision'] = 0; }), 'revision 0');
  ok(OperationPlanSchema, p((o) => { o['profileId'] = null; o['profileRevision'] = null; }), 'no profile');
  bad(OperationPlanSchema, p((o) => { o['expiresAt'] = o['createdAt']; }), 'expiresAt == createdAt');
  bad(OperationPlanSchema, p((o) => { o['expiresAt'] = at(-1); }), 'expiresAt before createdAt');
  bad(OperationPlanSchema, p((o) => { o['rootPath'] = 'relative'; }), 'relative rootPath');
  for (const id of BAD_HEX) bad(OperationPlanSchema, p((o) => { o['id'] = id; }), `plan id ${id.slice(0, 8)}`);
  ok(OperationPlanSchema, p((o) => { o['operations'] = []; o['summary'] = { move: 0, trash: 0, delete: 0, logicalBytes: 0 }; }), 'empty plan');
});

test('V4-C5 Approval: non-empty sorted ids, at most 10 minutes, one known mode, profile binding, used time order', () => {
  const a = (patch: Obj): Obj => ({ ...clone(approval), ...patch });
  bad(ApprovalSchema, a({ operationIds: [] }), 'empty operationIds');
  bad(ApprovalSchema, a({ operationIds: ['0000000b', '0000000a'] }), 'unsorted ids');
  bad(ApprovalSchema, a({ operationIds: ['0000000a', '0000000a'] }), 'duplicate ids');
  bad(ApprovalSchema, a({ operationIds: ['0000000A'] }), 'uppercase op id');
  ok(ApprovalSchema, a({ operationIds: ['0000000a', '0000000b'] }), 'sorted ids');
  ok(ApprovalSchema, a({ expiresAt: at(APPROVAL_TTL_MS) }), 'exactly 10 minutes');
  bad(ApprovalSchema, a({ expiresAt: at(APPROVAL_TTL_MS + 1) }), '10 minutes + 1 ms');
  bad(ApprovalSchema, a({ expiresAt: at(24 * 3_600_000) }), '1 day');
  bad(ApprovalSchema, a({ expiresAt: T0 }), 'expires at issue');
  bad(ApprovalSchema, a({ expiresAt: at(-1000) }), 'expires before issue');
  bad(ApprovalSchema, a({ usedAt: at(-1) }), 'used before issue');
  ok(ApprovalSchema, a({ usedAt: at(60_000) }), 'used 1 minute later');
  for (const mode of ['delete', 'move', 'all', 'ORGANIZE', '']) bad(ApprovalSchema, a({ mode }), `mode ${mode}`);
  for (const mode of ['organize', 'trash', 'permanent-delete']) ok(ApprovalSchema, a({ mode }), mode);
  bad(ApprovalSchema, a({ profileRevision: null }), 'profileId without revision');
  bad(ApprovalSchema, a({ approved: true }), 'approved: true');
  bad(ApprovalSchema, a({ confirmed: true }), 'confirmed: true');
  assert.equal(APPROVAL_TTL_MS, 600_000);
});

test('V4-C6 JournalEntry and ExecutionReport internal consistency', () => {
  const j = (patch: Obj): Obj => ({ ...clone(journalDone), ...patch });
  const trashIntent = { destination: null, kind: 'trash', phase: 'intent', after: null };
  ok(JournalEntrySchema, j(trashIntent), 'trash intent');
  ok(JournalEntrySchema, j({ phase: 'intent', after: null }), 'move intent');
  for (const seq of [-1, 1.5, '1']) bad(JournalEntrySchema, j({ seq }), `seq ${String(seq)}`);
  bad(JournalEntrySchema, j({ destination: null }), 'move without destination');
  bad(JournalEntrySchema, j({ after: null }), 'done move without after');
  bad(JournalEntrySchema, j({ phase: 'intent' }), 'move intent with after');
  bad(JournalEntrySchema, j({ ...trashIntent, phase: 'done', after: journalDone['after'] }), 'trash done with after');
  bad(JournalEntrySchema, j({ ...trashIntent, phase: 'failed' }), 'failed without errorCode');
  bad(JournalEntrySchema, j({ ...trashIntent, phase: 'skipped' }), 'skipped without errorCode');
  ok(JournalEntrySchema, j({ ...trashIntent, phase: 'failed', errorCode: 'TRASH_FAILED' }), 'failed with errorCode');
  bad(JournalEntrySchema, j({ ...trashIntent, errorCode: 'UNKNOWN' }), 'intent with errorCode');
  bad(JournalEntrySchema, j({ ...trashIntent, phase: 'undo-intent' }), 'undo of trash');
  bad(JournalEntrySchema, j({ ...trashIntent, kind: 'delete', phase: 'undone' }), 'undo of delete');
  bad(JournalEntrySchema, j({ ...trashIntent, phase: 'failed', errorCode: 'NOPE' }), 'unknown errorCode');
  bad(JournalEntrySchema, j({ phase: 'commit' }), 'unknown phase');
  bad(JournalEntrySchema, j({ runId: '../../etc' }), 'runId with path');
  bad(JournalEntrySchema, j({ before: { device: '1', inode: '7', size: -1, sha256: null } }), 'negative before.size');

  const r = (edit: (o: Obj) => void): Obj => withAt(report, '', edit);
  const results = (o: Obj): Obj[] => o['results'] as Obj[];
  bad(ExecutionReportSchema, r((o) => { results(o)[1]!['errorCode'] = null; }), 'failed without errorCode');
  bad(ExecutionReportSchema, r((o) => { results(o)[1]!['status'] = 'skipped'; results(o)[1]!['errorCode'] = null; }), 'skipped without errorCode');
  bad(ExecutionReportSchema, r((o) => { results(o)[0]!['errorCode'] = 'UNKNOWN'; }), 'moved with errorCode');
  for (const status of ['trashed', 'deleted']) bad(ExecutionReportSchema, r((o) => { results(o)[0]!['status'] = status; results(o)[0]!['errorCode'] = 'UNKNOWN'; }), `${status} with errorCode`);
  ok(ExecutionReportSchema, r((o) => { results(o)[1]!['status'] = 'unknown'; results(o)[1]!['errorCode'] = null; }), 'unknown without code');
  bad(ExecutionReportSchema, r((o) => { results(o)[1]!['opId'] = '0000000a'; }), 'duplicate result opId');
  bad(ExecutionReportSchema, r((o) => { results(o)[0]!['status'] = 'ok'; }), 'unknown status');
  bad(ExecutionReportSchema, r((o) => { (o['space'] as Obj)['freeBytesBefore'] = -1; }), 'negative free space');
  bad(ExecutionReportSchema, r((o) => { (o['space'] as Obj)['reclaimedBytes'] = 16; }), 'extra reclaimedBytes');
  ok(ExecutionReportSchema, r((o) => { o['results'] = []; }), 'empty results');
});

test('V4-C7 ErrorCode covers the design list; unknown codes are rejected, including through AfoError', () => {
  const design = ['ROOT_FORBIDDEN', 'PATH_OUTSIDE_ROOT', 'LINK_REJECTED', 'FILE_CHANGED', 'SOURCE_MISSING', 'DEST_EXISTS', 'CROSS_VOLUME',
    'NOT_SUPPORTED', 'PERMISSION_DENIED', 'LOCKED_BY_OTHER', 'FILE_BUSY', 'APPROVAL_MISSING', 'APPROVAL_INVALID', 'APPROVAL_EXPIRED',
    'APPROVAL_USED', 'PLAN_CHANGED', 'PROFILE_CHANGED', 'MODE_MISMATCH', 'KEEPER_INVALID', 'JOURNAL_FAILED', 'TRASH_FAILED',
    'STATE_DIR_CONFLICT', 'DISK_FULL', 'CANCELLED', 'UNKNOWN'];
  for (const c of design) ok(ErrorCodeSchema, c, c);
  const extra = ErrorCodeSchema.options.filter((c) => !design.includes(c));
  assert.deepEqual([...extra].sort(), ['STATE_CORRUPT', 'STATE_DIR_INVALID']);
  for (const c of ['NOPE', 'unknown', '', 'DEST_EXISTS ', 0, null]) bad(ErrorCodeSchema, c, `code ${String(c)}`);
  assert.throws(() => new AfoError('NOPE' as ErrorCode, 'x'));
  const e = new AfoError('DEST_EXISTS', '목적지가 있습니다.', { cause: new Error('EEXIST') });
  assert.ok(e instanceof Error && e.name === 'AfoError' && e.code === 'DEST_EXISTS' && e.cause instanceof Error);
  assert.ok(isAfoError(e) && isAfoError(e, 'DEST_EXISTS') && !isAfoError(e, 'UNKNOWN'));
  assert.ok(!isAfoError({ code: 'DEST_EXISTS', message: 'forged' }), 'plain object is not an AfoError');
});

test('V4-C8 existing read-only contracts still accept their shape and reject approval-like extras', () => {
  const root = { id: H('a'), canonicalPath: '/afo-fixture', readOnly: true };
  const scan = { root, files: [{ id: H('1'), relativePath: 'a.txt', size: 1, modifiedNs: '1', device: '1', inode: '1', sha256: null }],
    directories: [], skipped: [], complete: true };
  ok(ScanSchema, scan, 'scan');
  bad(ScanSchema, { ...scan, approved: true }, 'scan approved');
  bad(ScanSchema, { ...scan, root: { ...root, readOnly: false } }, 'scan writable root');
  const profile = { formatVersion: 1, id: 'p', revision: 1, status: 'confirmed', referenceRoot: root, referenceFiles: ['x/a.pdf', 'x/b.pdf'],
    rules: [{ id: 'r1', extension: '.pdf', keyword: null, targetDirectory: 'x', evidence: ['x/a.pdf', 'x/b.pdf'] }] };
  ok(ProfileSchema, profile, 'profile');
  bad(ProfileSchema, { ...profile, approved: true }, 'profile approved');
  const preview = { formatVersion: 1, mode: 'preview-only', id: 'p', root, profileRevision: null, items: [], duplicates: [], largeFiles: [],
    skipped: [], scanComplete: true, executionAvailable: false };
  ok(PreviewSchema, preview, 'preview');
  bad(PreviewSchema, { ...preview, executionAvailable: true }, 'preview execution');
  bad(PreviewSchema, { ...preview, approved: true }, 'preview approved');
});

/* ---------------- state folder ---------------- */
const STATE_DEFAULT = path.join(homedir(), 'Library', 'Application Support', 'AFO');
const exists = async (p: string): Promise<boolean> => { try { await lstat(p); return true; } catch { return false; } };
const defaultExistedBefore = process.platform === 'darwin' ? exists(STATE_DEFAULT) : Promise.resolve(false);
const code = (c: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === c;
async function tempDir(t: TestContext, label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), `${FIXTURE_PREFIX}v4-${label}-`)));
  t.after(async () => { await chmod(dir, 0o700).catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
const temps = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((n) => n.endsWith('.tmp'));

test('V4-S1 AFO_STATE_DIR resolution on this OS: empty, blank, relative and tilde values are rejected; absolute is normalized', () => {
  for (const v of ['', ' ', '\t', 'state', './state', '../state', '~/afo-state', process.platform === 'win32' ? '\\afo' : 'C:\\afo'])
    assert.throws(() => resolveStateDir({ AFO_STATE_DIR: v }), code('STATE_DIR_INVALID'), JSON.stringify(v));
  const dir = path.join(tmpdir(), 'afo-verify-state');
  assert.equal(resolveStateDir({ AFO_STATE_DIR: `${dir}${path.sep}x${path.sep}..` }), dir);
  assert.equal(resolveStateDir({ AFO_STATE_DIR: dir, HOME: '/elsewhere' }), dir, 'explicit value wins over defaults');
  if (process.platform === 'darwin') assert.equal(resolveStateDir({}), STATE_DEFAULT, 'default resolves (not created)');
});

test('V4-S2 state folder overlapping the work root is rejected by real path, including case, NFD and symlink aliases', async (t) => {
  const base = await tempDir(t, 'overlap');
  const root = path.join(base, '작업 루트');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'inner'), { recursive: true }); await mkdir(outside);
  const conflict = async (state: string, r = root, label = state): Promise<void> =>
    assert.rejects(assertStateDirOutside(state, r), code('STATE_DIR_CONFLICT'), label);
  await conflict(root, root, 'equal');
  await conflict(`${root}${path.sep}`, root, 'equal with trailing sep');
  await conflict(path.join(root, 'state'), root, 'inside (not yet created)');
  await conflict(path.join(root, 'a', 'b', 'c'), root, 'deep inside (not yet created)');
  await conflict(path.join(root, 'inner'), root, 'inside existing');
  await conflict(base, root, 'contains root');
  await conflict(path.parse(base).root, root, 'disk root contains root');
  await conflict(path.join(root, 'inner', '..', 'state'), root, 'dotdot back inside');
  if (process.platform !== 'linux') {
    await conflict(path.join(base, '작업 루트'.normalize('NFD'), 'state'), root, 'NFD alias');
    await conflict(path.join(base.toUpperCase() === base ? base.toLowerCase() : base.toUpperCase(), '작업 루트', 'state'), root, 'case alias');
  }
  if (process.platform !== 'win32') {
    await symlink(root, path.join(outside, 'alias'));
    await conflict(path.join(outside, 'alias', 'state'), root, 'symlink alias to root');
    await conflict(path.join(root, 'state'), path.join(outside, 'alias'), 'root given through symlink');
    await symlink(path.join(root, 'inner'), path.join(outside, 'alias-inner'));
    await conflict(path.join(outside, 'alias-inner'), root, 'symlink alias to inside');
  }
  await assertStateDirOutside(path.join(outside, 'state'), root);
  await assertStateDirOutside(`${root}-state`, root);
  await assertStateDirOutside(`${root}state`, root);
  await assert.rejects(assertStateDirOutside(path.join(outside, 'state'), path.join(base, 'missing-root')), code('ROOT_FORBIDDEN'), 'missing root');
  await writeFile(path.join(outside, 'plain-file'), 'f');
  await assert.rejects(assertStateDirOutside(path.join(outside, 'plain-file', 'state'), root), code('STATE_DIR_INVALID'), 'state under a file');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = path.join(base, 'locked');
    await mkdir(path.join(locked, 'root'), { recursive: true });
    await chmod(locked, 0o000);
    try { await assert.rejects(assertStateDirOutside(path.join(outside, 'state'), path.join(locked, 'root')), code('PERMISSION_DENIED'), 'unreadable root'); }
    finally { await chmod(locked, 0o700); }
  }
});

test('V4-S3 writeJsonAtomic failures keep the previous file intact and leave no temp files', async (t) => {
  const dir = await tempDir(t, 'atomic');
  const file = path.join(dir, 'plan.json');
  const Doc = z.strictObject({ name: z.string(), n: z.number().int() });
  await writeJsonAtomic(file, { name: '원본', n: 1 }, Doc);
  const original = await readFile(file);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readJson(file, Doc), { name: '원본', n: 1 });

  await assert.rejects(writeJsonAtomic(file, { name: '원본', n: 1.5 }, Doc), code('STATE_CORRUPT'), 'schema-invalid value');
  await assert.rejects(writeJsonAtomic(file, { name: '원본', n: 1, approved: true }, Doc), code('STATE_CORRUPT'), 'extra key');
  await assert.rejects(writeJsonAtomic(file, 'x'.repeat(MAX_STATE_JSON_BYTES)), code('STATE_CORRUPT'));
  await assert.rejects(writeJsonAtomic(file, undefined), 'undefined value');
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await temps(dir), []);

  const busy = path.join(dir, 'busy.json');
  await mkdir(busy); await writeFile(path.join(busy, 'keep.txt'), 'keep');
  await assert.rejects(writeJsonAtomic(busy, { name: 'x', n: 1 }, Doc), (e: unknown) => e instanceof AfoError);
  assert.equal(await readFile(path.join(busy, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(await temps(dir), []);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await chmod(dir, 0o500);
    try { await assert.rejects(writeJsonAtomic(file, { name: '새 값', n: 2 }, Doc), code('PERMISSION_DENIED')); }
    finally { await chmod(dir, 0o700); }
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(await temps(dir), []);

    const victim = path.join(dir, 'victim.txt');
    await writeFile(victim, 'victim');
    await symlink(victim, path.join(dir, 'link.json'));
    await writeJsonAtomic(path.join(dir, 'link.json'), { name: 'x', n: 3 }, Doc);
    assert.equal(await readFile(victim, 'utf8'), 'victim', 'symlink target is not written through');
    assert.ok((await lstat(path.join(dir, 'link.json'))).isFile(), 'link replaced by a regular file');
  }
});

test('V4-S4 readJson: missing is null; size limit, symlink, directory, FIFO, bad UTF-8, bad JSON and schema mismatch are STATE_CORRUPT', async (t) => {
  const dir = await tempDir(t, 'read');
  const S = z.string();
  assert.equal(await readJson(path.join(dir, 'missing.json'), S), null);
  const edge = path.join(dir, 'edge.json');
  await writeFile(edge, `"${'a'.repeat(MAX_STATE_JSON_BYTES - 2)}"`);
  assert.equal((await readJson(edge, S))?.length, MAX_STATE_JSON_BYTES - 2, 'exactly 1 MiB is accepted');
  await appendFile(edge, ' ');
  await assert.rejects(readJson(edge, S), code('STATE_CORRUPT'), '1 MiB + 1');
  const cases: [string, string | Buffer][] = [['torn.json', '{"name":'], ['utf8.json', Buffer.from([0x22, 0xff, 0xfe, 0x22])],
    ['shape.json', '{"name":1}'], ['empty.json', '']];
  for (const [name, data] of cases) {
    await writeFile(path.join(dir, name), data);
    await assert.rejects(readJson(path.join(dir, name), z.strictObject({ name: z.string() })), code('STATE_CORRUPT'), name);
  }
  await mkdir(path.join(dir, 'folder.json'));
  await assert.rejects(readJson(path.join(dir, 'folder.json'), S), code('STATE_CORRUPT'), 'directory');
  if (process.platform !== 'win32') {
    await writeFile(path.join(dir, 'real.json'), '"ok"');
    await symlink(path.join(dir, 'real.json'), path.join(dir, 'link.json'));
    await assert.rejects(readJson(path.join(dir, 'link.json'), S), code('STATE_CORRUPT'), 'symlink to a valid file');
    await symlink(path.join(dir, 'nowhere.json'), path.join(dir, 'dangling.json'));
    await assert.rejects(readJson(path.join(dir, 'dangling.json'), S), code('STATE_CORRUPT'), 'dangling symlink is not "missing"');
    await promisify(execFile)('mkfifo', [path.join(dir, 'fifo.json')]);
    await assert.rejects(readJson(path.join(dir, 'fifo.json'), S), code('STATE_CORRUPT'), 'FIFO rejected without blocking');
  }
});

const entry = (seq: number, patch: Partial<JournalEntry> = {}): JournalEntry => ({ formatVersion: 1, runId: 'run-v4-0001', seq,
  opId: '0000000a', approvalId: 'approval-0001', phase: 'intent', kind: 'trash', source: '사진/여행 😀.jpg', destination: null,
  before: { device: '1', inode: '2', size: 5, sha256: null }, after: null, errorCode: null, at: T0, ...patch });

test('V4-S5 journal: appended lines parse independently; torn tail, seq regression, foreign runId and links are handled', async (t) => {
  const state = await tempDir(t, 'journal');
  const file = journalFile(state, 'run-v4-0001');
  assert.equal(path.dirname(file), statePaths(state).journal);
  assert.equal(await readJournal(file), null);
  const written = [entry(0), entry(1, { phase: 'done' }), entry(2, { opId: '0000000b', phase: 'failed', errorCode: 'TRASH_FAILED' })];
  for (const e of written) await appendJournal(file, e);
  const raw = await readFile(file, 'utf8');
  assert.ok(raw.endsWith('\n'));
  const lines = raw.split('\n').slice(0, -1);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => JournalEntrySchema.parse(JSON.parse(l))), written, 'independent line-by-line parse');
  assert.deepEqual(await readJournal(file), { entries: written, corrupt: [] });

  await appendFile(file, '{"formatVersion":1,"runId":"run-v4-0001","se');
  assert.deepEqual((await readJournal(file))?.corrupt.map((c) => c.line), [4], 'torn tail reported, not guessed');
  await appendJournal(file, entry(3, { opId: '0000000c' }));
  const afterTorn = await readJournal(file);
  assert.deepEqual(afterTorn?.entries.map((e) => e.seq), [0, 1, 2, 3], 'entry after torn line survives');
  assert.deepEqual(afterTorn?.corrupt.map((c) => c.line), [4]);
  assert.equal((await readFile(file, 'utf8')).split('\n').length - 1, 5);

  const order = journalFile(state, 'run-v4-0002');
  for (const seq of [0, 5, 3, 5, 6]) await appendJournal(order, entry(seq, { runId: 'run-v4-0002' }));
  await appendJournal(order, entry(7, { runId: 'run-v4-9999' }));
  const ordered = await readJournal(order);
  assert.deepEqual(ordered?.entries.map((e) => e.seq), [0, 5, 6]);
  assert.deepEqual(ordered?.corrupt.map((c) => [c.line, c.reason]),
    [[3, '순번이 증가하지 않음'], [4, '순번이 증가하지 않음'], [6, '다른 실행 ID']]);

  const before = await readFile(file);
  await assert.rejects(appendJournal(file, entry(-1)), code('JOURNAL_FAILED'), 'invalid entry is not written');
  await assert.rejects(appendJournal(file, { ...entry(9), approved: true } as JournalEntry), code('JOURNAL_FAILED'), 'extra key is not written');
  assert.deepEqual(await readFile(file), before);
  const fresh = journalFile(state, 'run-v4-0003');
  await assert.rejects(appendJournal(fresh, entry(0, { runId: 'run-v4-0003', phase: 'done', kind: 'move' })), code('JOURNAL_FAILED'));
  assert.equal(await exists(fresh), false, 'rejected first entry creates no file');

  if (process.platform !== 'win32') {
    const victim = path.join(state, 'victim.txt');
    await writeFile(victim, 'victim');
    const linked = journalFile(state, 'run-v4-0004');
    await symlink(victim, linked);
    await assert.rejects(appendJournal(linked, entry(0, { runId: 'run-v4-0004' })), code('JOURNAL_FAILED'));
    assert.equal(await readFile(victim, 'utf8'), 'victim');
    await assert.rejects(readJournal(linked), code('STATE_CORRUPT'));
  }
});

test('V4-S6 runId cannot escape the journal folder', async (t) => {
  const state = await tempDir(t, 'escape');
  for (const id of ['../x', '../../../../tmp/afo-escape', '..', '.', '', 'a/b-0001', 'a\\b-0001', '/etc/passwd', 'run 00001',
    'run-0001.jsonl/../x', 'x'.repeat(129), 'run\u0000-0001', '런-00000001'])
    assert.throws(() => journalFile(state, id), JSON.stringify(id));
  await assert.rejects(appendJournal(path.join(state, 'journal', 'ok.jsonl'), entry(0, { runId: '../escape' })), code('JOURNAL_FAILED'), 'runId inside entry is validated');
  assert.deepEqual(await readdir(state), [], 'nothing created in the state folder');
  await assert.rejects(access(path.join(tmpdir(), 'afo-escape.jsonl')));
});

test('V4-S7 uppercase or case-variant runIds are rejected by journalFile and appendJournal and create no file', async (t) => {
  const state = await tempDir(t, 'case');
  for (const id of ['RUN-V4-CASE1', 'Run-v4-case1', 'run-v4-casE1', 'ABCDEFGH'])
    assert.throws(() => journalFile(state, id), JSON.stringify(id));
  const lower = journalFile(state, 'run-v4-case1');
  await assert.rejects(appendJournal(lower, entry(0, { runId: 'RUN-V4-CASE1' })), code('JOURNAL_FAILED'), 'uppercase runId in entry');
  await assert.rejects(appendJournal(lower, entry(0, { approvalId: 'Approval-0001' })), code('JOURNAL_FAILED'), 'uppercase approvalId');
  assert.deepEqual(await readdir(state), [], 'no journal folder or file created');
  await appendJournal(lower, entry(0, { runId: 'run-v4-case1' }));
  assert.deepEqual(await readdir(statePaths(state).journal), ['run-v4-case1.jsonl']);
  for (const [schema, value] of [[RootGrantSchema, { ...rootGrant, sessionId: 'Session-0001' }],
    [ApprovalSchema, { ...approval, id: 'APPROVAL-0001' }], [ExecutionReportSchema, { ...report, runId: 'RUN-00000001' }]] as const)
    bad(schema, value, 'uppercase opaque id');
});

/* ---------------- fixtures and manifest ---------------- */
test('V4-F1 fixtures are always created under os.tmpdir() and reject escaping names', async (t) => {
  const tmp = await realpath(tmpdir());
  const fx = await createFixture({ 'a/b.txt': 'b', 'e/': '' }, t);
  assert.equal(path.dirname(fx.root), tmp);
  assert.ok(path.basename(fx.root).startsWith(FIXTURE_PREFIX));
  assert.equal(fx.root, await realpath(fx.root));
  const sentinel = path.join(path.dirname(fx.root), `${FIXTURE_PREFIX}v4-sentinel-${process.pid}`);
  for (const name of ['../x.txt', `../${path.basename(sentinel)}`, '/abs.txt', 'a/../../x.txt', 'a//b.txt', './x', '.', '..', '',
    'a\\b.txt', 'C:x.txt', 'a/\u0000.txt', '..\\x.txt'])
    await assert.rejects(createFixture({ [name]: 'x' }), JSON.stringify(name));
  assert.equal(await exists(sentinel), false, 'no file written beside the fixture');
  await assert.rejects(createFixture({ 'dup.txt': 'a', 'x/../dup.txt': 'b' }));
  await fx.cleanup();
  assert.equal(await exists(fx.root), false, 'cleanup removes the fixture');
});

test('V4-F2 diffManifest detects add, remove, content-only, mtime-only, type swaps, links and NFC/NFD names', async (t) => {
  const when = new Date('2026-01-02T03:04:05.000Z');
  const { root } = await createFixture({ 'keep.txt': { data: 'same', modified: when }, 'content.txt': { data: 'AAAA', modified: when },
    'mtime.txt': { data: 'm', modified: when }, 'gone.txt': 'g', 'folder/child.txt': 'c', 'empty/': '', 'file-to-dir': 'f' }, t);
  const base = await createManifest(root);
  assert.ok(sameManifest(diffManifest(base, await createManifest(root))), 'stable when untouched');
  await writeFile(path.join(root, 'content.txt'), 'BBBB'); await utimes(path.join(root, 'content.txt'), when, when);
  await utimes(path.join(root, 'mtime.txt'), new Date(when.getTime() + 1000), new Date(when.getTime() + 1000));
  await rm(path.join(root, 'gone.txt'));
  await writeFile(path.join(root, '.hidden'), 'h');
  await writeFile(path.join(root, `${'한글'.normalize('NFD')}.txt`), 'nfd');
  await rm(path.join(root, 'folder'), { recursive: true }); await writeFile(path.join(root, 'folder'), 'now a file');
  await rm(path.join(root, 'file-to-dir')); await mkdir(path.join(root, 'file-to-dir'));
  await rm(path.join(root, 'empty'), { recursive: true });
  if (process.platform !== 'win32') await symlink('keep.txt', path.join(root, 'link'));
  const after = await createManifest(root);
  const diff = diffManifest(base, after);
  assert.deepEqual(diff.removed, ['empty', 'folder/child.txt', 'gone.txt']);
  assert.deepEqual(diff.added, ['.hidden', ...(process.platform !== 'win32' ? ['link'] : []), `${'한글'.normalize('NFD')}.txt`].sort());
  assert.deepEqual(diff.changed, ['content.txt', 'file-to-dir', 'folder', 'mtime.txt']);
  const contentOnly = diffManifest(base, after, { ignoreModified: true });
  assert.deepEqual(contentOnly.changed, ['content.txt', 'file-to-dir', 'folder'], 'content change seen even with equal size and mtime');
  assert.ok(!diff.added.includes('한글.txt'.normalize('NFC')), 'NFD name is not silently NFC-normalized');
  assert.equal(sameManifest(diff), false);
});

test('V4-F3 manifest and diff handle file names that collide with Object.prototype members (fixed in 61c737d/bfd5970)', async (t) => {
    // Computed key: a literal `'__proto__': 'p'` would set the prototype and never create the file.
    const { root } = await createFixture({ 'a.txt': 'a', 'constructor': 'c', ['__proto__']: 'p' }, t);
    assert.ok(await exists(path.join(root, '__proto__')), 'fixture really created __proto__');
    const before = await createManifest(root);
    assert.ok(Object.hasOwn(before, '__proto__'), '__proto__ file must appear in the manifest');
    await writeFile(path.join(root, 'toString'), 'added');
    await rm(path.join(root, 'constructor'));
    const diff = diffManifest(before, await createManifest(root));
    assert.deepEqual(diff.added, ['toString']);
    assert.deepEqual(diff.removed, ['constructor']);
    assert.deepEqual(diff.changed, []);
    const mid = await createManifest(root);
    await writeFile(path.join(root, '__proto__'), 'changed');
    await writeFile(path.join(root, 'hasOwnProperty'), 'h'); await writeFile(path.join(root, 'valueOf'), 'v');
    const later = diffManifest(mid, await createManifest(root));
    assert.deepEqual(later, { added: ['hasOwnProperty', 'valueOf'], removed: [], changed: ['__proto__'] });
    await rm(path.join(root, '__proto__'));
    assert.deepEqual(diffManifest(mid, await createManifest(root)).removed, ['__proto__']);
    assert.equal(Object.getPrototypeOf(mid), Object.prototype, 'still a plain object for deepEqual callers');
  });

test('V4-Z default app-data state folder was not created by this run', async () => {
  if (process.platform !== 'darwin') return;
  const existed = await defaultExistedBefore;
  if (!existed) assert.equal(await exists(STATE_DEFAULT), false);
});

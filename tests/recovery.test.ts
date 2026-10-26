import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, link, lstat, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AfoError, OperationPlanSchema } from '../packages/contracts/src/index.js';
import type { JournalEntry, OperationKind, OperationPlan, PlanOperation } from '../packages/contracts/src/index.js';
import { appendJournal, journalFile, statePaths, writeJsonAtomic } from '../packages/filesystem/src/state.js';
import { inspectRuns } from '../packages/filesystem/src/recovery.js';
import type { InspectOptions, RunInspection } from '../packages/filesystem/src/recovery.js';
import { createFixture, createManifest, diffManifest, sameManifest } from './helpers.js';
import type { FixtureSpec } from './helpers.js';

const GRANT = '2'.repeat(64);
const RUN = 'run-00000001';
const hex = (n: number): string => n.toString(16).padStart(8, '0');

async function setup(t: TestContext, spec: FixtureSpec) {
  const root = (await createFixture(spec, t)).root;
  const state = (await createFixture({}, t)).root;
  return { root, state };
}
async function expected(abs: string): Promise<PlanOperation['expected']> {
  const s = await lstat(abs, { bigint: true });
  return { size: Number(s.size), modifiedNs: String(s.mtimeNs), device: String(s.dev), inode: String(s.ino), sha256: null };
}
interface OpSpec { kind: OperationKind; source: string; destination?: string }
async function makePlan(root: string, specs: OpSpec[], extra: Partial<OperationPlan> = {}): Promise<OperationPlan> {
  const operations: PlanOperation[] = [];
  for (const [i, s] of specs.entries()) operations.push({ id: hex(i + 1), kind: s.kind, fileId: createHash('sha256').update(s.source).digest('hex'),
    source: s.source, destination: s.destination ?? null, reason: '합성 테스트', ruleId: null, keeper: null,
    expected: await expected(path.join(root, ...s.source.split('/'))) });
  const count = (k: OperationKind): number => operations.filter((o) => o.kind === k).length;
  return { formatVersion: 1, id: createHash('sha256').update(JSON.stringify(specs) + root).digest('hex'), rootGrantId: GRANT, rootPath: root,
    sessionId: 'session-0001', createdAt: '2026-10-26T01:00:00.000Z', expiresAt: '2026-10-26T01:10:00.000Z', profileId: null, profileRevision: null,
    deleteMode: specs.some((s) => s.kind === 'delete') ? 'permanent' : 'trash', operations, reviewItems: [],
    summary: { move: count('move'), trash: count('trash'), delete: count('delete'), logicalBytes: operations.reduce((a, o) => a + o.expected.size, 0) },
    ...extra };
}
const savePlan = (state: string, plan: OperationPlan): Promise<void> =>
  writeJsonAtomic(path.join(statePaths(state).plans, `${plan.id}.json`), plan, OperationPlanSchema);
const entry = (plan: OperationPlan, seq: number, opId: string, phase: JournalEntry['phase'], extra: Partial<JournalEntry> = {}): JournalEntry => {
  const op = plan.operations.find((o) => o.id === opId)!;
  const before = { device: op.expected.device, inode: op.expected.inode, size: op.expected.size, sha256: null };
  return { formatVersion: 1, runId: RUN, seq, opId, planId: plan.id, rootGrantId: plan.rootGrantId, approvalId: 'approval-0001', phase,
    kind: op.kind, source: op.source, destination: op.destination, before,
    after: op.kind === 'move' && (phase === 'done' || phase === 'undone') ? before : null,
    errorCode: phase === 'failed' || phase === 'skipped' ? 'FILE_CHANGED' : null, at: '2026-10-26T01:01:00.000Z', ...extra };
};
async function journal(state: string, entries: JournalEntry[], runId = RUN): Promise<void> {
  for (const e of entries) await appendJournal(journalFile(state, runId), e);
}
/** Every inspectRuns call is wrapped: the root, the state folder and any extra folder must be byte-for-byte unchanged. */
async function inspect(folders: string[], options?: InspectOptions, stateDir = folders[1]!): Promise<RunInspection[]> {
  const before = await Promise.all(folders.map(createManifest));
  const runs = await inspectRuns(stateDir, options);
  const after = await Promise.all(folders.map(createManifest));
  folders.forEach((folder, i) => assert.ok(sameManifest(diffManifest(before[i]!, after[i]!)),
    `report-only: ${folder} changed ${JSON.stringify(diffManifest(before[i]!, after[i]!))}`));
  return runs;
}
const states = (run: RunInspection): Record<string, string> => Object.fromEntries(run.unfinished.map((u) => [u.opId, u.state]));
async function trySymlink(t: TestContext, target: string, at: string, type: 'file' | 'dir' = 'dir'): Promise<boolean> {
  try { await symlink(target, at, type); return true; } catch (error) {
    if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') { t.skip('Windows symlink 권한 없음: 링크 부모 검사 건너뜀'); return false; }
    throw error;
  }
}

test('empty or missing state folders report no runs; relative or linked journal folders are refused', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a' });
  assert.deepEqual(await inspect([root, state]), []);
  assert.deepEqual(await inspect([root, state], undefined, path.join(state, 'not-created')), []);
  await mkdir(statePaths(state).journal);
  assert.deepEqual(await inspect([root, state]), []);
  await assert.rejects(inspectRuns('relative/state'), (e) => e instanceof AfoError && e.code === 'STATE_DIR_INVALID');
  const other = (await createFixture({ 'journal/': '' }, t)).root;
  if (!await trySymlink(t, path.join(other, 'journal'), path.join(other, 'state-journal'))) return;
  const linked = (await createFixture({}, t)).root;
  await symlink(path.join(other, 'journal'), path.join(linked, 'journal'), 'dir');
  await assert.rejects(inspect([linked, other], undefined, linked), (e) => e instanceof AfoError && e.code === 'STATE_CORRUPT');
});

test('interrupted moves are classified against the real files without touching them', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd', 'e.txt': 'e', 'f.txt': 'f', 'dest/': '' });
  const plan = await makePlan(root, ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ kind: 'move' as const, source: `${n}.txt`, destination: `dest/${n}.txt` })));
  await savePlan(state, plan);
  const at = (rel: string): string => path.join(root, ...rel.split('/'));
  await link(at('b.txt'), at('dest/b.txt'));                                      // crash between link and unlink
  await link(at('c.txt'), at('dest/c.txt')); await unlink(at('c.txt'));           // crash after unlink, before 'done'
  await rm(at('d.txt'));                                                          // someone removed it
  await rm(at('e.txt')); await writeFile(at('e.txt'), 'replaced');                // same name, other file
  await writeFile(at('dest/f.txt'), 'someone else');                              // destination taken by another file
  await journal(state, plan.operations.map((op, i) => entry(plan, i, op.id, 'intent')));
  const [run] = await inspect([root, state]);
  assert.equal(run!.runId, RUN); assert.equal(run!.planId, plan.id); assert.equal(run!.rootPath, root);
  assert.equal(run!.status, 'unfinished'); assert.equal(run!.finished, 0); assert.deepEqual(run!.corrupt, []);
  assert.deepEqual(states(run!), { [hex(1)]: 'not-started', [hex(2)]: 'linked-both', [hex(3)]: 'moved', [hex(4)]: 'missing',
    [hex(5)]: 'conflict', [hex(6)]: 'conflict' });
  const byId = new Map(run!.unfinished.map((u) => [u.opId, u]));
  assert.match(byId.get(hex(2))!.action, /하드링크 2개.*자동으로 지우지 않습니다/u);
  assert.match(byId.get(hex(3))!.action, /다시 실행하지 않습니다/u);
  for (const u of run!.unfinished) {
    assert.equal(u.phase, 'intent'); assert.equal(u.kind, 'move'); assert.equal(u.observed, u.state); assert.equal(u.detail, null);
    assert.doesNotMatch(u.action, /자동으로 (?:정리|복구|해결)합니다/u);
  }
  assert.equal((await lstat(at('b.txt'))).nlink, 2, 'linked-both is left as is');
});

test('finished ops (done, failed, skipped, undone) are never reported as unfinished', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd', 'e.txt': 'e', 'dest/': '' });
  const plan = await makePlan(root, ['a', 'b', 'c', 'd', 'e'].map((n) => ({ kind: 'move' as const, source: `${n}.txt`, destination: `dest/${n}.txt` })));
  await savePlan(state, plan);
  await link(path.join(root, 'a.txt'), path.join(root, 'dest', 'a.txt')); await unlink(path.join(root, 'a.txt'));
  await journal(state, [entry(plan, 0, hex(1), 'intent'), entry(plan, 1, hex(1), 'done'),
    entry(plan, 2, hex(2), 'intent'), entry(plan, 3, hex(2), 'failed'),
    entry(plan, 4, hex(3), 'intent'), entry(plan, 5, hex(3), 'skipped'),
    entry(plan, 6, hex(4), 'skipped'),                                      // refused before it started
    entry(plan, 7, hex(5), 'intent'), entry(plan, 8, hex(5), 'done'), entry(plan, 9, hex(5), 'undo-intent'), entry(plan, 10, hex(5), 'undone')]);
  const [run] = await inspect([root, state]);
  assert.equal(run!.status, 'clean'); assert.equal(run!.finished, 5); assert.deepEqual(run!.unfinished, []);
});

test('interrupted undo is classified in the reverse direction', async (t) => {
  const { root, state } = await setup(t, { 'dest/a.txt': 'a', 'dest/b.txt': 'b', 'dest/c.txt': 'c' });
  // Build the plan from the files at their destination, then describe them as moved from the top folder.
  const plan = await makePlan(root, ['a', 'b', 'c'].map((n) => ({ kind: 'move' as const, source: `dest/${n}.txt` })), {});
  plan.operations = plan.operations.map((op) => ({ ...op, source: op.source.slice('dest/'.length), destination: op.source }));
  plan.summary = { ...plan.summary, move: 3 };
  await savePlan(state, plan);
  await link(path.join(root, 'dest', 'b.txt'), path.join(root, 'b.txt'));                                         // undo: linked back
  await link(path.join(root, 'dest', 'c.txt'), path.join(root, 'c.txt')); await unlink(path.join(root, 'dest', 'c.txt')); // undo finished
  const entries = plan.operations.flatMap((op, i) => [entry(plan, i * 3, op.id, 'intent'), entry(plan, i * 3 + 1, op.id, 'done'),
    entry(plan, i * 3 + 2, op.id, 'undo-intent')]);
  await journal(state, entries);
  const [run] = await inspect([root, state]);
  assert.deepEqual(states(run!), { [hex(1)]: 'not-started', [hex(2)]: 'linked-both', [hex(3)]: 'moved' });
  assert.ok(run!.unfinished.every((u) => u.phase === 'undo-intent'));
  assert.match(run!.unfinished[0]!.action, /되돌리기가 시작되지 않아/u);
  assert.match(run!.unfinished[2]!.action, /되돌리기는 완료.*다시 실행하지 않습니다/u);
  assert.equal(run!.finished, 0);
});

test('interrupted trash and permanent delete report not-started, missing or conflict only', async (t) => {
  const { root, state } = await setup(t, { 't1.txt': '1', 't2.txt': '2', 't3.txt': '3', 'd1.txt': '4', 'd2.txt': '5', 'd3.txt': '6' });
  const trash = await makePlan(root, ['t1', 't2', 't3'].map((n) => ({ kind: 'trash' as const, source: `${n}.txt` })));
  const del = await makePlan(root, ['d1', 'd2', 'd3'].map((n) => ({ kind: 'delete' as const, source: `${n}.txt` })));
  await savePlan(state, trash); await savePlan(state, del);
  await rm(path.join(root, 't2.txt')); await rm(path.join(root, 't3.txt')); await writeFile(path.join(root, 't3.txt'), 'new');
  await rm(path.join(root, 'd2.txt')); await link(path.join(root, 'd3.txt'), path.join(root, 'd3 copy.txt')); // nlink 2
  await journal(state, trash.operations.map((op, i) => entry(trash, i, op.id, 'intent')));
  await journal(state, del.operations.map((op, i) => ({ ...entry(del, i, op.id, 'intent'), runId: 'run-00000002' })), 'run-00000002');
  const runs = await inspect([root, state]);
  assert.deepEqual(runs.map((r) => r.runId), [RUN, 'run-00000002']);
  assert.deepEqual(states(runs[0]!), { [hex(1)]: 'not-started', [hex(2)]: 'missing', [hex(3)]: 'conflict' });
  assert.deepEqual(states(runs[1]!), { [hex(1)]: 'not-started', [hex(2)]: 'missing', [hex(3)]: 'conflict' });
  assert.match(runs[0]!.unfinished[1]!.action, /OS 휴지통/u);
  assert.match(runs[1]!.unfinished[1]!.action, /되돌릴 수 없으며 다시 실행하지 않습니다/u);
  assert.match(runs[1]!.unfinished[2]!.action, /삭제하지 않으며/u);
});

test('a damaged middle line or torn last line makes every open op unknown and is reported', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'dest/': '' });
  const plan = await makePlan(root, ['a', 'b', 'c'].map((n) => ({ kind: 'move' as const, source: `${n}.txt`, destination: `dest/${n}.txt` })));
  await savePlan(state, plan);
  const file = journalFile(state, RUN);
  await link(path.join(root, 'c.txt'), path.join(root, 'dest', 'c.txt')); await unlink(path.join(root, 'c.txt'));
  await journal(state, [entry(plan, 0, hex(1), 'intent')]);
  await appendFile(file, 'not json at all\n');
  await journal(state, [entry(plan, 1, hex(2), 'intent'), entry(plan, 2, hex(2), 'done'), entry(plan, 3, hex(3), 'intent')]);
  await appendFile(file, JSON.stringify({ ...entry(plan, 4, hex(1), 'intent'), source: '../../escape.txt' }) + '\n'); // never followed
  await appendFile(file, '{"formatVersion":1,"runId":"run-000');                                                          // torn last line
  const [run] = await inspect([root, state]);
  assert.equal(run!.status, 'corrupt');
  assert.deepEqual(run!.corrupt.map((c) => c.line), [2, 6, 7]);
  assert.match(run!.corrupt[2]!.reason, /잘린/u);
  assert.equal(run!.finished, 1, 'op b has intent + done among valid lines');
  assert.deepEqual(states(run!), { [hex(1)]: 'unknown', [hex(3)]: 'unknown' });
  assert.deepEqual(run!.unfinished.map((u) => u.observed), ['not-started', 'moved']);
  for (const u of run!.unfinished) { assert.equal(u.detail, 'JOURNAL_DAMAGED'); assert.match(u.action, /손상.*자동으로 다시 실행·원복·삭제하지 않습니다/u); }
});

test('missing, mismatched or invalid plans leave open ops unknown', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a', 'b.txt': 'b', 'dest/': '' });
  const plan = await makePlan(root, [{ kind: 'move', source: 'a.txt', destination: 'dest/a.txt' }, { kind: 'move', source: 'b.txt', destination: 'dest/b.txt' }]);
  await journal(state, [entry(plan, 0, hex(1), 'intent')]);
  let [run] = await inspect([root, state]);
  assert.equal(run!.unfinished[0]!.state, 'unknown'); assert.equal(run!.unfinished[0]!.detail, 'PLAN_MISSING');
  assert.match(run!.unfinished[0]!.action, /^계획 파일이 없어 실제 상태를 확인할 수 없음/u);
  assert.equal(run!.rootPath, null); assert.equal(run!.status, 'unfinished');

  const cases: [string, InspectOptions][] = [
    ['PLAN_MISMATCH', { loadPlan: async () => ({ ...plan, rootGrantId: '3'.repeat(64) }) }],
    ['PLAN_MISMATCH', { loadPlan: async () => ({ ...plan, id: '4'.repeat(64) }) }],
    ['PLAN_MISMATCH', { loadPlan: async () => ({ ...plan, operations: [{ ...plan.operations[0]!, destination: 'dest/other.txt' }, plan.operations[1]!] }) }],
    ['STATE_CORRUPT', { loadPlan: async () => ({ ...plan, operations: [{ ...plan.operations[0]!, source: '../a.txt' }, plan.operations[1]!] }) }],
    ['SOURCE_MISSING', { loadPlan: async () => ({ ...plan, rootPath: path.join(root, 'gone') }) }],
    ['ROOT_FORBIDDEN', { loadPlan: async () => ({ ...plan, rootPath: [root, 'dest', '..', 'dest'].join(path.sep) }) }], // not canonical
    ['STATE_CORRUPT', { loadPlan: async () => ({ ...plan, rootPath: 'relative/root' }) }],    // schema refuses a relative root
  ];
  for (const [detail, options] of cases) {
    [run] = await inspect([root, state], options);
    assert.deepEqual([run!.unfinished[0]!.state, run!.unfinished[0]!.detail], ['unknown', detail], detail);
    assert.equal(run!.unfinished[0]!.observed, null);
  }
  // On disk: plan with a different rootGrantId, then a plan whose path escapes the root (schema rejects it on read).
  const planFile = path.join(statePaths(state).plans, `${plan.id}.json`);
  await writeJsonAtomic(planFile, { ...plan, rootGrantId: '3'.repeat(64) }, OperationPlanSchema);
  [run] = await inspect([root, state]);
  assert.equal(run!.unfinished[0]!.detail, 'PLAN_MISMATCH');
  await writeJsonAtomic(planFile, { ...plan, operations: [{ ...plan.operations[0]!, source: '../../outside.txt' }, plan.operations[1]!] });
  [run] = await inspect([root, state]);
  assert.deepEqual([run!.unfinished[0]!.state, run!.unfinished[0]!.detail], ['unknown', 'STATE_CORRUPT']);
});

test('links among parent folders under the root are not followed', async (t) => {
  const { root, state } = await setup(t, { 'real/a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'dest/': '' });
  const outside = (await createFixture({ 'x/': '' }, t)).root;
  if (!await trySymlink(t, path.join(root, 'real'), path.join(root, 'alias'))) return;
  await symlink(outside, path.join(root, 'out'), 'dir');
  await symlink(outside, path.join(root, 'dest', 'deep'), 'dir');
  const plan = await makePlan(root, [{ kind: 'move', source: 'real/a.txt', destination: 'dest/a.txt' },
    { kind: 'move', source: 'b.txt', destination: 'out/b.txt' }, { kind: 'trash', source: 'c.txt' }]);
  plan.operations[0] = { ...plan.operations[0]!, source: 'alias/a.txt' };          // source parent is a link inside the root
  plan.operations[2] = { ...plan.operations[2]!, kind: 'move', destination: 'dest/deep/x/c.txt' }; // grandparent link to outside
  plan.deleteMode = 'trash'; plan.summary = { ...plan.summary, move: 3, trash: 0 };
  await savePlan(state, plan);
  await journal(state, plan.operations.map((op, i) => entry(plan, i, op.id, 'intent')));
  const [run] = await inspect([root, state, outside]);
  assert.deepEqual(run!.unfinished.map((u) => [u.state, u.detail]), [['unknown', 'LINK_REJECTED'], ['unknown', 'LINK_REJECTED'], ['unknown', 'LINK_REJECTED']]);
  assert.ok(run!.unfinished.every((u) => u.observed === null && /링크/u.test(u.action)));
});

test('inconsistent journals are reported as unknown instead of guessed', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'dest/': '' });
  const plan = await makePlan(root, ['a', 'b', 'c'].map((n) => ({ kind: 'move' as const, source: `${n}.txt`, destination: `dest/${n}.txt` })));
  await savePlan(state, plan);
  await journal(state, [entry(plan, 0, hex(1), 'intent'), entry(plan, 1, hex(1), 'done', { source: 'c.txt' }), // phases disagree
    entry(plan, 2, hex(2), 'done'),                                                                          // done without intent
    entry(plan, 3, hex(3), 'intent'), entry(plan, 4, hex(3), 'undone')]);                                   // undone closes a forward move
  let [run] = await inspect([root, state]);
  assert.deepEqual(states(run!), { [hex(1)]: 'unknown', [hex(2)]: 'unknown', [hex(3)]: 'unknown' });
  assert.ok(run!.unfinished.every((u) => u.detail === 'JOURNAL_INCONSISTENT'));
  assert.equal(run!.status, 'unfinished');

  // Entries whose run ID differs from the file name, or that mix plans, poison the whole run.
  await journal(state, [{ ...entry(plan, 0, hex(1), 'intent'), runId: 'run-00000009' }], 'run-00000003');
  await journal(state, [{ ...entry(plan, 0, hex(1), 'intent'), runId: 'run-00000004' },
    { ...entry(plan, 1, hex(2), 'intent'), runId: 'run-00000004', planId: '5'.repeat(64) }], 'run-00000004');
  const runs = await inspect([root, state]);
  for (const r of runs.slice(1)) {
    assert.equal(r.status, 'corrupt'); assert.ok(r.problem);
    assert.ok(r.unfinished.length > 0 && r.unfinished.every((u) => u.state === 'unknown' && u.detail === 'JOURNAL_INCONSISTENT'));
  }
  [run] = runs;
  assert.equal(run!.runId, RUN);
});

test('odd names in the journal folder are ignored or reported unreadable, never followed; order is deterministic', async (t) => {
  const { root, state } = await setup(t, { 'a.txt': 'a' });
  const dir = statePaths(state).journal;
  await mkdir(path.join(dir, 'dir-00000001.jsonl'), { recursive: true });
  await writeFile(path.join(dir, 'notes.txt'), 'ignored');
  await writeFile(path.join(dir, '.run-00000001.jsonl.123.abc.tmp'), 'ignored');
  await writeFile(path.join(dir, 'BAD_NAME.jsonl'), 'x');
  await writeFile(path.join(dir, 'empty-0000001.jsonl'), '');
  await writeFile(path.join(dir, 'binary-000001.jsonl'), Buffer.from([0xff, 0xfe, 0x0a]));
  const elsewhere = (await createFixture({ 'run.jsonl': '' }, t)).root;
  const linked = await trySymlink(t, path.join(elsewhere, 'run.jsonl'), path.join(dir, 'link-0000001.jsonl'), 'file');
  const runs = await inspect([root, state, elsewhere]);
  const expectedRuns: [string, string][] = [['BAD_NAME', 'unreadable'], ['binary-000001', 'unreadable'], ['dir-00000001', 'unreadable'],
    ['empty-0000001', 'clean'], ...(linked ? [['link-0000001', 'unreadable'] as [string, string]] : [])];
  assert.deepEqual(runs.map((r) => [r.runId, r.status]), expectedRuns);
  assert.ok(runs.filter((r) => r.status === 'unreadable').every((r) => r.problem && r.unfinished.length === 0 && r.planId === ''));
  assert.deepEqual(await inspect([root, state, elsewhere]), runs, 'same input, same report');
});

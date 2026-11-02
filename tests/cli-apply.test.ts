import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { ExecutionReportSchema, OperationPlanSchema } from '../packages/contracts/src/index.js';
import type { ApprovalMode, ExecutionReport, OperationPlan } from '../packages/contracts/src/index.js';
import { approvalCode } from '../packages/engine/src/index.js';
import { withRootLock } from '../packages/filesystem/src/lock.js';
import { runCli } from '../apps/cli/src/index.js';
import { createFixture, manifest } from './helpers.js';
import type { FixtureSpec, Manifest } from './helpers.js';

/*
 * CLI apply/undo/runs/recover (#10–#13 user path): real child processes, synthetic mkdtemp folders and a temp AFO_STATE_DIR
 * beside the work folder. File results are checked with the independent manifest oracle (paths, sha256), not with CLI output.
 */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Result = { status: number | null; stdout: string; stderr: string };
type PlanJson = { planId: string; plan: OperationPlan; approvalChoices: { mode: ApprovalMode; operationIds: string[]; code: string }[] };
type ApplyJson = { runId: string; report: ExecutionReport };

const baseSpec: FixtureSpec = {
  'work/a.pdf': 'pdf-a', 'work/b.jpg': 'jpg-b', 'work/clip.mp4': 'video', 'work/notes': 'no extension',
  'work/c.txt': 'same-text', 'work/c copy.txt': 'same-text', 'state/': '',
};

async function setup(t: TestContext, spec: FixtureSpec = baseSpec) {
  const { root: base } = await createFixture(spec, t);
  const dirs = { base, work: path.join(base, 'work'), state: path.join(base, 'state') };
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, AFO_STATE_DIR: dirs.state, ...extra });
  const invoke = (args: string[], extra: Record<string, string> = {}): Result => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const invokeAsync = (args: string[]): Promise<Result> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
  const plan = (...extra: string[]): PlanJson => {
    const r = invoke(['plan', dirs.work, '--json', ...extra]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as PlanJson;
    return { ...parsed, plan: OperationPlanSchema.parse(parsed.plan) };
  };
  const code = (p: PlanJson, mode: ApprovalMode): string => {
    const choice = p.approvalChoices.find((c) => c.mode === mode);
    assert.ok(choice, `plan has ${mode} operations`);
    return choice.code;
  };
  const applyJson = (r: Result): ApplyJson => {
    const parsed = JSON.parse(r.stdout) as ApplyJson; // stdout carries exactly one JSON document
    assert.deepEqual(Object.keys(parsed), ['runId', 'report']);
    return { runId: parsed.runId, report: ExecutionReportSchema.parse(parsed.report) };
  };
  return { dirs, invoke, invokeAsync, plan, code, applyJson };
}

const files = (m: Manifest): Manifest => Object.fromEntries(Object.entries(m).filter(([, e]) => e.type === 'file'));
const sha = (m: Manifest, rel: string): string => {
  const e = m[rel];
  assert.ok(e && e.type === 'file', `${rel} is a file`);
  return e.sha256;
};
const stateFiles = async (dir: string, sub: string): Promise<string[]> => readdir(path.join(dir, sub)).catch(() => []);

/** Independent oracle for an organize run: each moved op's content is at its destination and gone from its source; nothing else changed. */
function assertMoved(before: Manifest, after: Manifest, plan: OperationPlan, movedIds: Set<string>): void {
  const b = files(before); const a = files(after);
  const moved = plan.operations.filter((op) => movedIds.has(op.id));
  const sources = new Set(moved.map((op) => op.source));
  for (const op of moved) {
    assert.equal(a[op.source], undefined, `${op.source} no longer at its source`);
    assert.equal(sha(a, op.destination!), sha(b, op.source), `${op.destination} has the content of ${op.source}`);
  }
  for (const [rel, entry] of Object.entries(b)) if (!sources.has(rel)) assert.deepEqual(a[rel], entry, `${rel} unchanged`);
  assert.deepEqual(Object.keys(a).sort(), [...Object.keys(b).filter((rel) => !sources.has(rel)), ...moved.map((op) => op.destination!)].sort());
}

test('apply organize → runs → recover → undo: files really move and come back with the same hashes', async (t) => {
  const { dirs, invoke, plan, code, applyJson } = await setup(t);
  const p = plan();
  const moves = p.plan.operations.filter((op) => op.kind === 'move');
  assert.ok(moves.length >= 3);
  const before = await manifest(dirs.work);

  const r = invoke(['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'organize'), '--json']);
  assert.equal(r.status, 0, r.stderr);
  const { runId, report } = applyJson(r);
  assert.equal(report.runId, runId);
  assert.equal(report.planId, p.planId);
  assert.deepEqual(report.results.map((x) => x.status), moves.map(() => 'moved'));
  const afterApply = await manifest(dirs.work);
  assertMoved(before, afterApply, p.plan, new Set(moves.map((op) => op.id)));

  // runs: list and detail, both JSON and human; read only.
  const list = JSON.parse(invoke(['runs', '--json']).stdout) as { runs: { runId: string; mode: string; undoable: boolean; results: Record<string, number> }[] };
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0]!.runId, runId);
  assert.equal(list.runs[0]!.mode, 'organize');
  assert.equal(list.runs[0]!.undoable, true);
  assert.equal(list.runs[0]!.results.moved, moves.length);
  const human = invoke(['runs']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, new RegExp(`${runId}.*이동\\(organize\\).*undo 가능`, 'u'));
  const detail = invoke(['runs', runId]);
  assert.equal(detail.status, 0);
  for (const op of moves) assert.ok(detail.stdout.includes(`${op.source} → ${op.destination}`));
  assert.deepEqual(await manifest(dirs.work), afterApply, 'runs changes nothing');

  // recover after a normal run (no fault injection): nothing to report.
  const rec = invoke(['recover', '--json']);
  assert.equal(rec.status, 0, rec.stderr);
  assert.deepEqual(JSON.parse(rec.stdout), { checked: 1, runs: [] });
  assert.match(invoke(['recover']).stdout, /끝나지 않은 실행이 없습니다/u);

  // undo: refused without / with a wrong confirmation code, then moves everything back.
  const noCode = invoke(['undo', runId]);
  assert.equal(noCode.status, 4);
  assert.match(noCode.stderr, /--confirm <실행 ID 앞 8자>/u);
  assert.equal(invoke(['undo', runId, '--confirm', '00000000']).status, 4);
  assert.deepEqual(await manifest(dirs.work), afterApply, 'refused undo changes nothing');
  const u = invoke(['undo', runId, '--confirm', runId.slice(0, 8)]);
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, /\[되돌림\]/u);
  assert.match(u.stdout, /휴지통 이동·영구 삭제는 되돌리지 않습니다/u);
  assert.deepEqual(files(await manifest(dirs.work)), files(before), 'every file back at its original path, same hash and mtime');

  // A second undo has nothing left; recover stays empty after the undo too.
  const again = invoke(['undo', runId, '--confirm', runId.slice(0, 8)]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /되돌릴 이동 항목이 없습니다/u);
  assert.deepEqual(JSON.parse(invoke(['recover', '--json']).stdout), { checked: 1, runs: [] });
  const after = JSON.parse(invoke(['runs', '--json']).stdout) as { runs: { undos: number; undoable: boolean }[] };
  assert.equal(after.runs[0]!.undos, 1);
  assert.equal(after.runs[0]!.undoable, false);
});

test('apply refuses without the right code: no --confirm, wrong code, another mode\'s code, --yes → nothing changes', async (t) => {
  const { dirs, invoke, plan, code } = await setup(t);
  const p = plan('--delete-duplicates', 'all');
  const before = await manifest(dirs.work);

  const none = invoke(['apply', p.planId, '--mode', 'organize']);
  assert.equal(none.status, 4);
  assert.match(none.stderr, /비대화형 실행에는 --confirm <승인 코드>가 필요합니다/u);
  assert.match(none.stderr, /승인 코드: [a-f0-9]{8}/u, 'summary with the code is shown on stderr');
  assert.equal(none.stdout, '');
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--confirm', '0000000f']).status, 4);
  const other = invoke(['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'trash')]);
  assert.equal(other.status, 4);
  assert.match(other.stderr, /APPROVAL_INVALID/u);
  assert.equal(invoke(['apply', p.planId, '--mode', 'trash', '--confirm', code(p, 'organize')]).status, 4);
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--yes']).status, 2, 'no boolean consent option');
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--phrase', '영구 삭제', '--confirm', code(p, 'organize')]).status, 2);
  assert.equal(invoke(['apply', p.planId, '--mode', 'everything', '--confirm', code(p, 'organize')]).status, 2);
  assert.equal(invoke(['apply', p.planId.slice(0, 12), '--mode', 'organize']).status, 2);
  assert.equal(invoke(['apply', p.planId, '--mode', 'permanent-delete', '--confirm', code(p, 'trash'), '--phrase', '영구 삭제']).status, 4,
    'a trash plan has no permanent-delete operations (MODE_MISMATCH)');
  // --only with an operation of another kind, or an unknown ID.
  const trashId = p.plan.operations.find((op) => op.kind === 'trash')!.id;
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--only', trashId]).status, 4);
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--only', 'ffffffffffffffff']).status, 4);

  assert.deepEqual(await manifest(dirs.work), before, 'work folder untouched by every refusal');
  assert.deepEqual((await stateFiles(dirs.state, 'approvals')).filter((f) => f.endsWith('.json')), [], 'no approval was issued');
  assert.deepEqual(await stateFiles(dirs.state, 'runs'), [], 'no run was started');
});

test('the same approval code cannot run twice (4); --only runs a subset with its own code', async (t) => {
  const { dirs, invoke, plan, code, applyJson } = await setup(t);
  const p = plan();
  const moves = p.plan.operations.filter((op) => op.kind === 'move').map((op) => op.id).sort();
  const [first, ...rest] = moves;
  const before = await manifest(dirs.work);

  // Subset without a code: refused, and the summary shows the code for exactly this subset.
  const ask = invoke(['apply', p.planId, '--mode', 'organize', '--only', first!]);
  assert.equal(ask.status, 4);
  const subsetCode = approvalCode(p.planId, [first!], 'organize');
  assert.ok(ask.stderr.includes(`승인 코드: ${subsetCode}`));
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--only', first!, '--confirm', code(p, 'organize')]).status, 4,
    'the full-mode code does not approve a subset');
  const one = invoke(['apply', p.planId, '--mode', 'organize', '--only', first!, '--confirm', subsetCode, '--json']);
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(applyJson(one).report.results.map((r) => [r.opId, r.status]), [[first, 'moved']]);
  const afterOne = await manifest(dirs.work);
  assertMoved(before, afterOne, p.plan, new Set([first!]));

  // Re-using a code whose operations already ran (same subset, or the full set that includes it) → 4, nothing changes.
  const reuse = invoke(['apply', p.planId, '--mode', 'organize', '--only', first!, '--confirm', subsetCode]);
  assert.equal(reuse.status, 4);
  assert.match(reuse.stderr, /APPROVAL_USED/u);
  assert.equal(invoke(['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'organize')]).status, 4);
  assert.deepEqual(await manifest(dirs.work), afterOne);
  assert.equal((await stateFiles(dirs.state, 'runs')).filter((f) => /^[a-z0-9-]+\.json$/u.test(f)).length, 1);

  // The remaining operations are a different selection with their own code.
  const restRun = invoke(['apply', p.planId, '--mode', 'organize', '--only', rest.join(','), '--confirm', approvalCode(p.planId, rest, 'organize')]);
  assert.equal(restRun.status, 0, restRun.stderr);
  assertMoved(before, await manifest(dirs.work), p.plan, new Set(moves));
});

test('files changed after plan: changed source is not moved, an existing destination is never overwritten (3); others proceed', async (t) => {
  const { dirs, invoke, plan, code, applyJson } = await setup(t);
  const p = plan();
  const bySource = Object.fromEntries(p.plan.operations.map((op) => [op.source, op]));
  const changed = bySource['a.pdf']!; const blocked = bySource['b.jpg']!; const free = bySource['clip.mp4']!;
  await writeFile(path.join(dirs.work, 'a.pdf'), 'pdf-a edited after the plan');
  const dest = path.join(dirs.work, ...blocked.destination!.split('/'));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, 'user file already at the destination');
  const before = await manifest(dirs.work);

  const r = invoke(['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'organize'), '--json']);
  assert.equal(r.status, 3, r.stderr);
  const results = Object.fromEntries(applyJson(r).report.results.map((x) => [x.opId, x]));
  assert.equal(results[changed.id]!.status, 'failed');
  assert.equal(results[changed.id]!.errorCode, 'FILE_CHANGED');
  assert.equal(results[blocked.id]!.status, 'failed');
  assert.equal(results[blocked.id]!.errorCode, 'DEST_EXISTS');
  assert.equal(results[free.id]!.status, 'moved');

  const after = await manifest(dirs.work);
  assert.deepEqual(after['a.pdf'], before['a.pdf'], 'edited file stays where it was with the new content');
  assert.equal(after[changed.destination!], undefined);
  assert.deepEqual(after['b.jpg'], before['b.jpg'], 'source kept');
  assert.deepEqual(after[blocked.destination!], before[blocked.destination!], 'user file at the destination not overwritten');
  assert.equal(sha(after, free.destination!), sha(before, 'clip.mp4'));
  assert.equal(after['clip.mp4'], undefined);

  // Human output of the same kind of run names the failures and points to plan again.
  const text = invoke(['runs', applyJson(r).runId]).stdout;
  assert.match(text, /\[실패\].*\(FILE_CHANGED\)/u);
  assert.match(text, /\[실패\].*\(DEST_EXISTS\)/u);
});

test('permanent delete: refused without the phrase (4); with it only candidates are deleted and keepers keep their hashes', async (t) => {
  const { dirs, invoke, plan, code } = await setup(t, { ...baseSpec, 'work/d.jpg': 'jpg-b', 'work/old/b2.jpg': 'jpg-b' });
  const p = plan('--delete-mode', 'permanent', '--delete-duplicates', 'all');
  const deletes = p.plan.operations.filter((op) => op.kind === 'delete');
  assert.ok(deletes.length >= 2);
  const keepers = [...new Set(deletes.map((op) => op.keeper!))];
  const before = await manifest(dirs.work);

  const noPhrase = invoke(['apply', p.planId, '--mode', 'permanent-delete', '--confirm', code(p, 'permanent-delete')]);
  assert.equal(noPhrase.status, 4);
  assert.match(noPhrase.stderr, /되돌릴 수 없습니다/u);
  assert.match(noPhrase.stderr, /--phrase "영구 삭제"/u);
  assert.equal(invoke(['apply', p.planId, '--mode', 'permanent-delete', '--confirm', code(p, 'permanent-delete'), '--phrase', '삭제']).status, 4);
  assert.deepEqual(await manifest(dirs.work), before);

  const r = invoke(['apply', p.planId, '--mode', 'permanent-delete', '--confirm', code(p, 'permanent-delete'), '--phrase', '영구 삭제']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[영구 삭제함\]/u);
  assert.match(r.stdout, /여유 공간\(관측\): 실행 전 \d+ B → 실행 후 \d+ B/u);
  assert.match(r.stdout, /영구 삭제는 되돌릴 수 없습니다/u);
  assert.match(r.stderr, /남길 파일\(바꾸지 않음\): /u);
  const after = await manifest(dirs.work);
  for (const op of deletes) assert.equal(after[op.source], undefined, `${op.source} deleted`);
  for (const k of keepers) assert.equal(sha(after, k), sha(before, k), `keeper ${k} kept with the same hash`);
  const deleted = new Set(deletes.map((op) => op.source));
  for (const [rel, entry] of Object.entries(files(before))) if (!deleted.has(rel)) assert.deepEqual(after[rel], entry);

  const runId = (JSON.parse(invoke(['runs', '--json']).stdout) as { runs: { runId: string }[] }).runs[0]!.runId;
  const undo = invoke(['undo', runId, '--confirm', runId.slice(0, 8)]);
  assert.equal(undo.status, 1);
  assert.match(undo.stderr, /영구 삭제는 되돌릴 수 없습니다/u);
});

test('real OS trash (AFO_REAL_TRASH_TEST=1 only): one synthetic afo-test- file goes to the trash, others stay', {
  skip: process.env.AFO_REAL_TRASH_TEST === '1' ? false : 'set AFO_REAL_TRASH_TEST=1 to send one synthetic file to the real OS trash',
}, async (t) => {
  const name = `afo-test-trash-${process.pid}-${Date.now()}.txt`;
  const { dirs, invoke, plan, code, applyJson } = await setup(t, { 'work/other.txt': 'unrelated', [`work/${name}`]: `only for the AFO trash test ${name}`,
    'state/': '' });
  const p = plan('--delete-file', name);
  const trash = p.plan.operations.filter((op) => op.kind === 'trash');
  assert.deepEqual(trash.map((op) => op.source), [name], 'exactly the one synthetic afo-test- file');
  const before = await manifest(dirs.work);
  const r = invoke(['apply', p.planId, '--mode', 'trash', '--confirm', code(p, 'trash'), '--json']);
  assert.equal(r.status, 0, r.stderr);
  const { report } = applyJson(r);
  assert.deepEqual(report.results.map((x) => x.status), ['trashed']);
  assert.match(report.space.note, /확보한 공간으로 세지 않습니다/u);
  assert.equal(report.space.freeBytesBefore, null);
  const after = await manifest(dirs.work);
  assert.equal(after[name], undefined);
  assert.deepEqual(after['other.txt'], before['other.txt']);
  t.diagnostic(`trashed synthetic ${name}; this test never empties or reads the trash`);
});

test('root lock held by another run: apply exits 1 (LOCKED_BY_OTHER), changes nothing, and works after a new approval', async (t) => {
  const { dirs, invoke, plan, code } = await setup(t);
  const p = plan();
  const before = await manifest(dirs.work);
  const stat = await lstat(await realpath(dirs.work), { bigint: true });
  const blocked = await withRootLock(dirs.state, { device: String(stat.dev), inode: String(stat.ino) },
    () => Promise.resolve(invoke(['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'organize')])));
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /LOCKED_BY_OTHER/u);
  assert.match(blocked.stderr, /승인을 다시 받아야 합니다/u);
  assert.deepEqual(await manifest(dirs.work), before);
  assert.deepEqual((await stateFiles(dirs.state, 'runs')).filter((f) => f.endsWith('.json')), []);
  const ok = invoke(['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'organize')]);
  assert.equal(ok.status, 0, ok.stderr);
});

test('two concurrent apply processes on one root: one runs, the other is refused by the root lock (1) and changes nothing', async (t) => {
  const spec: FixtureSpec = { 'state/': '' };
  // Distinct sizes: no hashing, so the run time is dominated by the per-operation journal fsyncs.
  for (let i = 0; i < 300; i += 1) spec[`work/f${String(i).padStart(3, '0')}.pdf`] = `file ${i} ${'x'.repeat(i)}`;
  const { dirs, invokeAsync, plan } = await setup(t, spec);
  const p = plan();
  const ids = p.plan.operations.map((op) => op.id).sort();
  // Disjoint selections, so only the root lock (not the CLI's already-run check) can refuse one of them.
  const halves = [ids.slice(0, 150), ids.slice(150)];
  const before = await manifest(dirs.work);
  const started = Date.now();
  const results = await Promise.all(halves.map((half) =>
    invokeAsync(['apply', p.planId, '--mode', 'organize', '--only', half.join(','), '--confirm', approvalCode(p.planId, half, 'organize')])));
  t.diagnostic(`statuses: ${results.map((r) => r.status).join(',')} in ${Date.now() - started} ms`);
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 1], results.map((r) => r.stderr.trim().split('\n').at(-1)).join(' | '));
  const loser = results.findIndex((r) => r.status === 1);
  assert.match(results[loser]!.stderr, /LOCKED_BY_OTHER/u);
  assert.match(results[loser]!.stderr, /승인을 다시 받아야 합니다/u);
  assertMoved(before, await manifest(dirs.work), p.plan, new Set(halves[1 - loser]));
});

test('two concurrent apply processes with the same code: exactly one runs (the other gets 1 or 4); every file moved once', async (t) => {
  const spec: FixtureSpec = { 'state/': '' };
  for (let i = 0; i < 100; i += 1) spec[`work/g${String(i).padStart(3, '0')}.jpg`] = `image ${i} ${'y'.repeat(i)}`;
  const { dirs, invokeAsync, plan, code } = await setup(t, spec);
  const p = plan();
  const before = await manifest(dirs.work);
  const args = ['apply', p.planId, '--mode', 'organize', '--confirm', code(p, 'organize')];
  const results = await Promise.all([invokeAsync(args), invokeAsync(args)]);
  const statuses = results.map((r) => r.status).sort();
  t.diagnostic(`statuses: ${statuses.join(',')}`);
  assert.equal(statuses[0], 0);
  assert.ok(statuses[1] === 1 || statuses[1] === 4, `second is refused, got ${statuses[1]}`);
  assertMoved(before, await manifest(dirs.work), p.plan, new Set(p.plan.operations.map((op) => op.id)));
});

test('TTY: apply asks for the code (and the phrase for permanent delete); a wrong or empty answer is refused (4)', async (t) => {
  const { dirs, invoke, plan } = await setup(t, { ...baseSpec, 'work/d.jpg': 'jpg-b' });
  const p = plan('--delete-mode', 'permanent', '--delete-duplicates', 'all');
  const before = await manifest(dirs.work);
  const questions: string[] = [];
  const io = (...answers: string[]) => ({ stateDir: dirs.state, isTTY: true, warn: () => {},
    ask: (q: string) => { questions.push(q); return Promise.resolve(answers.shift() ?? ''); } });
  const choice = (mode: ApprovalMode) => p.approvalChoices.find((c) => c.mode === mode)!;

  await assert.rejects(runCli(['apply', p.planId, '--mode', 'organize'], undefined, io('')), (e: Error & { exitCode?: number }) => e.exitCode === 4);
  await assert.rejects(runCli(['apply', p.planId, '--mode', 'organize'], undefined, io('12345678')), /APPROVAL_INVALID|승인 코드가/u);
  await assert.rejects(runCli(['apply', p.planId, '--mode', 'permanent-delete'], undefined, io(choice('permanent-delete').code, '아니오')),
    /영구 삭제/u);
  assert.deepEqual(await manifest(dirs.work), before);
  assert.ok(questions.some((q) => q.includes('되돌릴 수 없습니다')), 'permanent delete asks for the phrase');

  const del = await runCli(['apply', p.planId, '--mode', 'permanent-delete'], undefined, io(choice('permanent-delete').code, '영구 삭제'));
  assert.equal(del.exitCode, 0);
  const moved = await runCli(['apply', p.planId, '--mode', 'organize'], undefined, io(choice('organize').code));
  assert.equal(moved.exitCode, 0, moved.output);
  const after = await manifest(dirs.work);
  for (const op of p.plan.operations.filter((o) => o.kind === 'delete')) assert.equal(after[op.source], undefined);
  for (const op of p.plan.operations.filter((o) => o.kind === 'move')) assert.equal(sha(after, op.destination!), sha(before, op.source));
  assert.equal(invoke(['recover', '--json']).status, 0);
});

test('usage: runs/undo/recover arguments are checked; unknown run IDs are errors, not empty successes', async (t) => {
  const { invoke } = await setup(t);
  assert.equal(invoke(['runs']).status, 0);
  assert.match(invoke(['runs']).stdout, /실행 기록이 없습니다/u);
  assert.deepEqual(JSON.parse(invoke(['recover', '--json']).stdout), { checked: 0, runs: [] });
  assert.equal(invoke(['runs', 'NOT_AN_ID']).status, 2);
  assert.equal(invoke(['runs', '00000000-0000-4000-8000-000000000000']).status, 1);
  assert.equal(invoke(['undo', '00000000-0000-4000-8000-000000000000', '--confirm', '00000000']).status, 1);
  assert.equal(invoke(['undo']).status, 0, 'undo without an ID and nothing to undo (cli-guided.test.ts covers the rest)');
  assert.equal(invoke(['recover', 'extra']).status, 2);
  assert.equal(invoke(['apply']).status, 2);
  assert.equal(invoke(['apply', 'a'.repeat(64), '--mode', 'organize', '--confirm', '00000000']).status, 4, 'unknown plan ID (PLAN_CHANGED)');
});

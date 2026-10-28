import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { OperationPlanSchema, PreviewSchema } from '../packages/contracts/src/index.js';
import type { OperationPlan, Preview } from '../packages/contracts/src/index.js';
import { approvalChoices, approvalCode } from '../packages/engine/src/index.js';
import { LAST_COPY_REASON } from '../packages/engine/src/plan.js';
import { loadSavedPlan } from '../packages/filesystem/src/approvals.js';
import { createFixture, manifest } from './helpers.js';

/* #8 CLI plan: real child processes, synthetic folders, AFO_STATE_DIR in the same temp fixture. plan writes only the state folder. */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Result = { status: number | null; stdout: string; stderr: string };
type PlanJson = { planId: string; plan: OperationPlan; approvalChoices: ReturnType<typeof approvalChoices>; reviewItems: OperationPlan['reviewItems'] };

async function setup(t: TestContext) {
  const { root: base } = await createFixture({
    'work/report.pdf': 'same-pdf', 'work/report copy.pdf': 'same-pdf', 'work/사진/a.jpg': 'same-jpg', 'work/b.jpg': 'same-jpg',
    'work/clip.mp4': 'video', 'work/notes': 'no extension', 'work/정리됨/old.jpg': 'same-jpg', 'work/정리됨/과제.pdf': 'kept',
    'state/': '',
  }, t);
  const dirs = { base, work: path.join(base, 'work'), reference: path.join(base, 'work', '정리됨'), state: path.join(base, 'state') };
  const invoke = (args: string[], state = dirs.state): Result => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: state } });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const ok = (r: Result): Result => { assert.equal(r.status, 0, r.stderr); return r; };
  const plan = (...extra: string[]): PlanJson => {
    const stdout = ok(invoke(['plan', dirs.work, '--reference', dirs.reference, '--json', ...extra])).stdout;
    const parsed = JSON.parse(stdout) as PlanJson; // stdout is one JSON document and nothing else
    assert.deepEqual(Object.keys(parsed), ['planId', 'plan', 'approvalChoices', 'reviewItems']);
    return { ...parsed, plan: OperationPlanSchema.parse(parsed.plan) };
  };
  const human = (...extra: string[]): string => ok(invoke(['plan', dirs.work, '--reference', dirs.reference, ...extra])).stdout;
  const previewJson = (): Preview =>
    PreviewSchema.parse((JSON.parse(ok(invoke(['preview', dirs.work, '--reference', dirs.reference, '--json'])).stdout) as { preview: unknown }).preview);
  return { dirs, invoke, ok, plan, human, previewJson };
}
const ids = (p: OperationPlan): string[] => p.operations.map((op) => op.id).sort();
const bySource = (p: OperationPlan) => Object.fromEntries(p.operations.map((op) => [op.source, op]));

test('plan: saved plan equals the output; keepers stay; reference files are never operations; work root unchanged', async (t) => {
  const { dirs, plan, human } = await setup(t);
  const before = await manifest(dirs.work);
  const out = plan('--delete-duplicates', 'all');
  assert.equal(out.planId, out.plan.id);
  assert.deepEqual(out.reviewItems, out.plan.reviewItems);

  // Stored in <state>/plans/<planId>.json and loadSavedPlan returns exactly what was printed.
  await access(path.join(dirs.state, 'plans', `${out.planId}.json`));
  const saved = await loadSavedPlan(dirs.state, out.planId);
  assert.ok(saved);
  assert.deepEqual(saved.plan, out.plan);
  assert.deepEqual(out.approvalChoices, approvalChoices(saved.plan));
  for (const c of out.approvalChoices) assert.equal(c.code, approvalCode(out.planId, c.operationIds, c.mode));
  assert.ok((await readdir(path.join(dirs.state, 'plans'))).some((f) => /^latest-[a-f0-9]{64}\.json$/u.test(f)), 'latest index for this root');

  // Each selected duplicate group keeps its keeper: the keeper is no operation, is listed as kept and still exists.
  const ops = bySource(out.plan);
  const deletes = out.plan.operations.filter((op) => op.kind === 'trash');
  assert.equal(deletes.length, 2, 'one candidate per group (pdf pair; jpg pair outside the reference)');
  assert.deepEqual(deletes.map((op) => path.extname(op.source)).sort(), ['.jpg', '.pdf']);
  for (const op of deletes) {
    assert.ok(op.keeper !== null);
    assert.equal(ops[op.keeper], undefined, `keeper ${op.keeper} is not an operation`);
    assert.ok(out.plan.reviewItems.some((r) => r.source === op.keeper && r.status === 'keep'));
    await access(path.join(dirs.work, ...op.keeper.split('/')));
    assert.equal(op.expected.sha256 !== null, true);
  }
  assert.equal(out.plan.deleteMode, 'trash');
  assert.deepEqual(out.plan.summary, { move: 1, trash: 2, delete: 0, logicalBytes: out.plan.operations.reduce((n, op) => n + op.expected.size, 0) });

  // Reference files (정리됨/) are kept as review items and never become operations.
  assert.ok(!out.plan.operations.some((op) => op.source.startsWith('정리됨/')));
  assert.deepEqual(out.plan.reviewItems.filter((r) => r.source.startsWith('정리됨/')).map((r) => r.status), ['keep', 'keep']);

  const text = human('--delete-duplicates', 'all');
  assert.match(text, /계획 ID: [a-f0-9]{64}/u);
  assert.match(text, /만료: \d{4}-\d{2}-\d{2}T/u);
  assert.match(text, /확보량 아님/u);
  assert.match(text, /남길 파일: /u);
  assert.match(text, /organize \(이동 \d+개\): [a-f0-9]{8}/u);
  assert.match(text, /trash \(휴지통 2개\): [a-f0-9]{8}/u);
  assert.match(text, /실행: apply [a-f0-9]{64} --mode <방식>/u);
  assert.match(text, /이 plan 명령은 파일을 옮기거나 지우지 않았습니다/u);
  assert.match(text, /\[유지\] 2개: 참고한 기존 파일을 보존합니다/u);
  assert.deepEqual(await manifest(dirs.work), before, 'plan never writes the work root');
});

test('plan: same input gives the same operation IDs; a changed file shows only its changed operation', async (t) => {
  const { dirs, plan, human } = await setup(t);
  const first = plan();
  const second = plan();
  assert.notEqual(first.planId, second.planId, 'time and session are part of the plan');
  assert.deepEqual(ids(second.plan), ids(first.plan), 'same files → same operation IDs across processes');

  const same = human();
  assert.match(same, /그대로 \d+개\(목록 생략\), 새로 추가·바뀐 작업 0개, 빠진 작업 0개/u);
  assert.match(same, /\(모두 이전 계획과 같음\)/u);
  assert.ok(!first.plan.operations.some((op) => same.includes(op.id)), 'unchanged operations are not listed again');

  const latest = plan();
  const oldClip = bySource(latest.plan)['clip.mp4']!;
  await writeFile(path.join(dirs.work, 'clip.mp4'), 'video, now longer');
  const changed = human();
  const now = plan();
  const newClip = bySource(now.plan)['clip.mp4']!;
  assert.notEqual(newClip.id, oldClip.id);
  assert.match(changed, /그대로 \d+개\(목록 생략\), 새로 추가·바뀐 작업 1개, 빠진 작업 1개/u);
  assert.ok(changed.includes(`${newClip.id} 이동 clip.mp4 → 영상/clip.mp4`), changed);
  assert.ok(changed.includes(`[빠짐] ${oldClip.id}`), changed);
  for (const op of latest.plan.operations.filter((o) => o.source !== 'clip.mp4')) assert.ok(!changed.includes(op.id), `${op.source} unchanged, not listed`);
});

test('plan: permanent mode says it cannot be undone and needs the confirm phrase; picks by group hash and by file', async (t) => {
  const { dirs, plan, human, previewJson } = await setup(t);
  const before = await manifest(dirs.work);
  const text = human('--delete-mode', 'permanent', '--delete-duplicates', 'all');
  assert.match(text, /삭제 방식: 영구 삭제\(permanent\) — 되돌릴 수 없습니다/u);
  assert.match(text, /\[영구 삭제 — 되돌릴 수 없음\] 2개/u);
  assert.match(text, /permanent-delete \(영구 삭제 2개\): [a-f0-9]{8} — 되돌릴 수 없습니다\. 실행할 때 확인 문구 "영구 삭제"도 입력해야 합니다\./u);
  const permanent = plan('--delete-mode', 'permanent', '--delete-duplicates', 'all');
  assert.ok(permanent.plan.operations.filter((op) => op.kind !== 'move').every((op) => op.kind === 'delete'));
  assert.deepEqual(permanent.approvalChoices.map((c) => c.mode), ['organize', 'permanent-delete']);

  const pdf = previewJson().duplicates.find((g) => g.suggestedKeep.endsWith('.pdf'))!;
  const picked = plan('--delete-duplicates', pdf.sha256.slice(0, 12), '--delete-file', 'NOTES');
  const deletes = picked.plan.operations.filter((op) => op.kind === 'trash');
  assert.deepEqual(deletes.map((op) => [op.source, op.keeper]).sort(), [...pdf.candidates.map((c) => [c, pdf.suggestedKeep]), ['notes', null]].sort());
  assert.deepEqual(await manifest(dirs.work), before);
});

test('plan: one-off --move is applied to the plan and marked as this plan only', async (t) => {
  const { plan, human } = await setup(t);
  assert.match(human('--move', 'notes=메모'), /이동 notes → 메모\/notes \(사용자 수정, 이번 계획에만 적용\)/u);
  const out = plan('--move', 'notes=메모');
  assert.equal(bySource(out.plan)['notes']?.destination, '메모/notes');
  assert.equal(bySource(plan().plan)['notes'], undefined, 'not remembered: the next plan without --move leaves notes for review');
});

test('plan: refusals and exit codes (docs/CLI.md); nothing is written into the work root', async (t) => {
  const { dirs, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  const run = (...args: string[]): Result => invoke(['plan', dirs.work, ...args]);
  for (const args of [['--delete-mode', 'shred'], ['--remember'], ['--delete-duplicates', 'xyz'], ['--execute'],
    ['--profile', 'p.json', '--no-saved-rules'], ['extra-positional']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^AFO 오류/u);
  }
  const unknownGroup = run('--delete-duplicates', 'deadbeef');
  assert.equal(unknownGroup.status, 1);
  assert.match(unknownGroup.stderr, /^AFO 오류\[KEEPER_INVALID\]/u);
  const reference = run('--reference', dirs.reference, '--delete-file', '정리됨/과제.pdf');
  assert.equal(reference.status, 1);
  assert.match(reference.stderr, /^AFO 오류\[ROOT_FORBIDDEN\]/u);
  const missing = run('--delete-file', 'nope.txt');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^AFO 오류\[SOURCE_MISSING\]/u);

  // State folder inside the work root is refused before anything is written.
  const inside = path.join(dirs.work, 'afo-state');
  const conflict = invoke(['plan', dirs.work], inside);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /^AFO 오류\[STATE_DIR_CONFLICT\]/u);
  await assert.rejects(access(inside));
  assert.deepEqual(await manifest(dirs.work), before);
  assert.deepEqual(await readdir(dirs.state), [], 'refused plans store nothing');
});

test('plan: picking every copy of one content needs --delete-last-copy; without it exit 1 and nothing is stored', async (t) => {
  const { dirs, invoke, plan, human } = await setup(t);
  const before = await manifest(dirs.work);
  const both = ['--delete-file', 'report.pdf', '--delete-file', 'report copy.pdf'];
  const refused = invoke(['plan', dirs.work, ...both]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /^AFO 오류\[KEEPER_INVALID\]: 모든 사본이 삭제됩니다: .*--delete-last-copy/u);
  assert.equal(refused.stdout, '');
  assert.deepEqual(await readdir(dirs.state), [], 'a refused plan stores nothing');
  const flagOnly = invoke(['plan', dirs.work, '--delete-last-copy']);
  assert.equal(flagOnly.status, 2, flagOnly.stderr);
  assert.match(flagOnly.stderr, /--delete-file과 함께/u);

  const out = plan(...both, '--delete-last-copy', '--delete-mode', 'permanent');
  const deletes = out.plan.operations.filter((op) => op.kind === 'delete');
  assert.deepEqual(deletes.map((op) => [op.source, op.keeper]).sort(), [['report copy.pdf', null], ['report.pdf', null]]);
  assert.ok(deletes.every((op) => op.reason === LAST_COPY_REASON));
  const text = human(...both, '--delete-last-copy');
  assert.match(text, /경고: --delete-last-copy로 같은 내용의 마지막 사본까지 지우는 작업 2개/u);
  // One copy of the pair (the other stays) and a unique file need no flag.
  assert.equal(invoke(['plan', dirs.work, '--delete-file', 'report.pdf', '--delete-file', 'clip.mp4']).status, 0);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('plan builds from the analysis scan: the CLI plan module never scans or hashes on its own', async () => {
  // Regression guard for the second scan/hash that used to run between analysis and buildPlan (double I/O, race window).
  const source = await readFile(fileURLToPath(new URL('../apps/cli/src/plan.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /\b(scanRoot|hashCandidates|scanFolder|analyzeRoot)\b/u);
  assert.match(source, /analysis\.scan|\{ preview, scan \} = analysis/u);
});

test('plan: bound to the saved profile revision; a --profile file that is not the saved profile is refused', async (t) => {
  const { root: base } = await createFixture({
    'reference/과제/물리/물리_1.pdf': 'r1', 'reference/과제/물리/물리_2.pdf': 'r2', 'work/물리_새보고서.pdf': 'w1', 'work/IMG_1.jpg': 'w2', 'state/': '',
  }, t);
  const [reference, work, state] = ['reference', 'work', 'state'].map((d) => path.join(base, d)) as [string, string, string];
  const invoke = (...args: string[]): Result => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: state } });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const before = { reference: await manifest(reference), work: await manifest(work) };
  const draft = invoke('suggest-rules', reference, '--json');
  assert.equal(draft.status, 0, draft.stderr);
  const draftFile = path.join(base, 'draft.json');
  await writeFile(draftFile, draft.stdout);
  const ruleIds = (JSON.parse(draft.stdout) as { rules: { id: string }[] }).rules.map((r) => r.id);
  assert.equal(invoke('rules', 'save', draftFile, '--select', ruleIds.join(',')).status, 0);

  const first = JSON.parse(invoke('plan', work, '--json').stdout) as PlanJson;
  const stored = (JSON.parse(invoke('rules', 'list', '--json').stdout) as { profile: { id: string; revision: number } }).profile;
  assert.deepEqual([first.plan.profileId, first.plan.profileRevision], [stored.id, stored.revision]);
  assert.equal(bySource(first.plan)['물리_새보고서.pdf']?.destination, '과제/물리/물리_새보고서.pdf');

  assert.equal(invoke('rules', 'disable-all').status, 0);
  const off = invoke('plan', work);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /개인 규칙\(프로필 또는 revision\)이 이전 계획과 다릅니다/u);
  assert.match(off.stdout, /\[빠짐\] [a-f0-9]{16} 이동 물리_새보고서\.pdf → 과제\/물리\/물리_새보고서\.pdf/u);

  const confirmed = invoke('confirm-rules', draftFile, '--select', ruleIds.join(','));
  const file = path.join(base, 'confirmed.json');
  await writeFile(file, confirmed.stdout);
  const refused = invoke('plan', work, '--profile', file);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^AFO 오류\[PROFILE_CHANGED\]: 계획과 승인은 저장된 개인 규칙에만 묶입니다/u);
  assert.deepEqual({ reference: await manifest(reference), work: await manifest(work) }, before);
});

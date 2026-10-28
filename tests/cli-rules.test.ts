import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { PreviewSchema, ProfileSchema, RuleProfileV2Schema } from '../packages/contracts/src/index.js';
import type { Preview, RuleProfile } from '../packages/contracts/src/index.js';
import { run, exitCodeOf } from '../apps/cli/src/index.js';
import { createFixture, manifest } from './helpers.js';

/* #18 CLI: real child processes, synthetic folders, AFO_STATE_DIR in the same temp fixture. No command here moves files. */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Result = { status: number | null; stdout: string; stderr: string };

async function setup(t: TestContext) {
  const { root: base } = await createFixture({
    'reference/과제/물리/물리_1.pdf': 'r1', 'reference/과제/물리/물리_2.pdf': 'r2',
    'reference/과제/수학/수학_1.pdf': 'r3', 'reference/과제/수학/수학_2.pdf': 'r4',
    'reference/사진/여행1.jpg': 'r5', 'reference/사진/여행2.jpg': 'r6',
    'work/물리_새보고서.pdf': 'w1', 'work/수학_숙제.pdf': 'w2', 'work/IMG_1.jpg': 'w3', 'work/메모.txt': 'w4', 'state/': '',
  }, t);
  const dirs = { base, reference: path.join(base, 'reference'), work: path.join(base, 'work'), state: path.join(base, 'state') };
  const invoke = (...args: string[]): Result => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: dirs.state } });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const pristine = { reference: await manifest(dirs.reference), work: await manifest(dirs.work) };
  /** Reference and work folders must be byte-for-byte unchanged after every step. */
  const unchanged = async (): Promise<void> => {
    assert.deepEqual(await manifest(dirs.reference), pristine.reference);
    assert.deepEqual(await manifest(dirs.work), pristine.work);
  };
  const ok = (r: Result): Result => { assert.equal(r.status, 0, r.stderr); return r; };
  const preview = (...extra: string[]): { preview: Preview; profile: { source: string }; remembered?: { correctionId: string }[] } => {
    const parsed = JSON.parse(ok(invoke('preview', dirs.work, '--json', ...extra)).stdout) as
      { preview: unknown; profile: { source: string }; remembered?: { correctionId: string }[] };
    return { ...parsed, preview: PreviewSchema.parse(parsed.preview) };
  };
  const dest = (p: Preview): Record<string, string | null> => Object.fromEntries(p.items.map((i) => [i.source, i.destination]));
  return { dirs, invoke, unchanged, ok, preview, dest, profileFile: path.join(dirs.state, 'profiles', 'active.json') };
}
const DEFAULT = { 'IMG_1.jpg': '이미지/IMG_1.jpg', '메모.txt': '문서/메모.txt', '물리_새보고서.pdf': '문서/물리_새보고서.pdf', '수학_숙제.pdf': '문서/수학_숙제.pdf' };
const PERSONAL = { ...DEFAULT, '물리_새보고서.pdf': '과제/물리/물리_새보고서.pdf', '수학_숙제.pdf': '과제/수학/수학_숙제.pdf' };

test('rules end to end: suggest → save → auto-apply → restart → disable/enable → --move once/--remember → forget → reset', async (t) => {
  const { dirs, invoke, unchanged, ok, preview, dest, profileFile } = await setup(t);

  const suggested = ok(invoke('suggest-rules', dirs.reference));
  const draft: RuleProfile = ProfileSchema.parse(JSON.parse(suggested.stdout));
  assert.equal(draft.status, 'draft'); assert.equal(draft.rules.length, 3);
  assert.match(suggested.stderr, /참고 폴더 'reference'에서 규칙 후보 3개/u);
  assert.ok(!suggested.stderr.includes(dirs.base), 'human summary shows the folder label only');
  const ruleFor = (dir: string): string => draft.rules.find((r) => r.targetDirectory === dir)!.id;
  const [physics, math] = [ruleFor('과제/물리'), ruleFor('과제/수학')];
  const draftFile = path.join(dirs.base, 'draft.json');
  await writeFile(draftFile, suggested.stdout);
  await unchanged();

  // Without an explicit selection nothing is saved (usage error 2).
  assert.equal(invoke('rules', 'save', draftFile).status, 2);
  assert.equal(invoke('rules', 'save', draftFile, '--select', '').status, 2);
  assert.equal(invoke('rules', 'save', draftFile, '--select', `${physics},`).status, 2);
  assert.equal(invoke('rules', 'save', draftFile, '--select', 'no-such-rule').status, 1);
  await assert.rejects(stat(profileFile));
  assert.equal(JSON.parse(ok(invoke('rules', 'list', '--json')).stdout).state, 'none');
  assert.deepEqual(dest(preview().preview), DEFAULT);

  // Save only the two chosen rules (the photo rule stays unconfirmed).
  const saved = ok(invoke('rules', 'save', draftFile, '--select', `${physics},${math}`));
  assert.match(saved.stdout, /선택한 규칙 2개를 확인해 앱 로컬 상태에 저장했습니다/u);
  const listed = JSON.parse(ok(invoke('rules', 'list', '--json')).stdout) as { state: string; profile: unknown };
  const profile = RuleProfileV2Schema.parse(listed.profile);
  assert.equal(listed.state, 'active');
  assert.deepEqual(profile.rules.map((r) => r.id).sort(), [physics, math].sort());
  assert.equal(profile.referenceRootLabel, 'reference');
  const listText = ok(invoke('rules', 'list')).stdout;
  assert.match(listText, /근거 예시\(전체 2개 중 2개\): 과제\/물리\/물리_1\.pdf, 과제\/물리\/물리_2\.pdf/u);
  assert.match(listText, /\[켜짐\]/u);
  for (const text of [listText, JSON.stringify(listed), await readFile(profileFile, 'utf8')])
    assert.ok(!text.includes(dirs.base), 'no absolute reference path in list output or saved state');

  // Applied by default, and identical after a process restart.
  const first = ok(invoke('preview', dirs.work, '--json'));
  const firstParsed = JSON.parse(first.stdout) as { preview: Preview; profile: { source: string; revision: number } };
  assert.deepEqual(dest(firstParsed.preview), PERSONAL);
  assert.equal(firstParsed.profile.source, 'saved');
  assert.equal(firstParsed.preview.profileRevision, profile.revision);
  assert.deepEqual(JSON.parse(ok(invoke('preview', dirs.work, '--json')).stdout), firstParsed);
  const text = ok(invoke('preview', dirs.work)).stdout;
  assert.match(text, /개인 규칙: 저장된 프로필 적용/u);
  assert.ok(!text.includes(dirs.base));
  assert.deepEqual(dest(preview('--no-saved-rules').preview), DEFAULT);
  await unchanged();

  // One rule off → that file falls back to the default rule; back on → personal again.
  assert.match(ok(invoke('rules', 'disable', physics)).stdout, /껐습니다/u);
  assert.deepEqual(dest(preview().preview), { ...PERSONAL, '물리_새보고서.pdf': '문서/물리_새보고서.pdf' });
  assert.match(ok(invoke('rules', 'disable', physics)).stdout, /이미 꺼져/u);
  ok(invoke('rules', 'enable', physics));
  assert.deepEqual(dest(preview().preview), PERSONAL);
  assert.equal(invoke('rules', 'disable', 'no-such-rule').status, 1);
  ok(invoke('rules', 'disable-all'));
  const off = preview();
  assert.deepEqual(dest(off.preview), DEFAULT); assert.equal(off.preview.profileRevision, null);
  ok(invoke('rules', 'enable-all'));
  assert.deepEqual(dest(preview().preview), PERSONAL);
  await unchanged();

  // --move without --remember: this preview only, nothing stored.
  const before = await readFile(profileFile, 'utf8');
  const once = preview('--move', '메모.txt=메모함');
  const memo = once.preview.items.find((i) => i.source === '메모.txt')!;
  assert.equal(memo.destination, '메모함/메모.txt'); assert.equal(memo.reasonCode, 'USER_OVERRIDE');
  assert.match(ok(invoke('preview', dirs.work, '--move', '메모.txt=메모함')).stdout, /메모\.txt → 메모함\/메모\.txt \(이번만 적용\)/u);
  assert.equal(await readFile(profileFile, 'utf8'), before);
  assert.deepEqual(dest(preview().preview), PERSONAL);

  // --remember: stored as a saved correction and applied by the next process.
  const remembered = preview('--move', '메모.txt=메모함', '--remember');
  assert.equal(remembered.remembered?.length, 1);
  const correctionId = remembered.remembered![0]!.correctionId;
  const next = preview();
  assert.deepEqual(dest(next.preview), { ...PERSONAL, '메모.txt': '메모함/메모.txt' });
  assert.equal(next.preview.items.find((i) => i.source === '메모.txt')!.reasonCode, 'SAVED_CORRECTION');
  assert.match(ok(invoke('rules', 'list')).stdout, new RegExp(`\\[${correctionId}\\] 파일 이름 '메모\\.txt' → 메모함`, 'u'));
  await unchanged();

  // Saving reference rules again keeps the explicit correction.
  ok(invoke('rules', 'save', draftFile, '--select', physics));
  assert.deepEqual(dest(preview().preview), { ...PERSONAL, '수학_숙제.pdf': '문서/수학_숙제.pdf', '메모.txt': '메모함/메모.txt' });
  ok(invoke('rules', 'save', draftFile, '--select', `${physics},${math}`));

  ok(invoke('rules', 'forget', correctionId));
  assert.deepEqual(dest(preview().preview), PERSONAL);
  assert.equal(invoke('rules', 'forget', correctionId).status, 1);

  // Reset needs explicit confirmation outside a TTY; refusals change nothing.
  const kept = await readFile(profileFile, 'utf8');
  const refused = invoke('rules', 'reset');
  assert.equal(refused.status, 2); assert.match(refused.stderr, /--confirm reset/u);
  assert.equal(invoke('rules', 'reset', '--confirm', 'yes').status, 4);
  assert.equal(await readFile(profileFile, 'utf8'), kept);
  assert.deepEqual(dest(preview().preview), PERSONAL);
  ok(invoke('rules', 'reset', '--confirm', 'reset'));
  const cleared = preview();
  assert.deepEqual(dest(cleared.preview), DEFAULT); assert.equal(cleared.profile.source, 'none');
  assert.equal(JSON.parse(ok(invoke('rules', 'list', '--json')).stdout).state, 'none');
  await unchanged();
});

test('damaged saved profile: preview warns and uses default rules, edits refuse, nothing is overwritten', async (t) => {
  const { dirs, invoke, unchanged, ok, preview, dest, profileFile } = await setup(t);
  const suggested = ok(invoke('suggest-rules', dirs.reference, '--json'));
  assert.equal(suggested.stderr, '', '--json keeps stderr quiet');
  const draftFile = path.join(dirs.base, 'draft.json');
  await writeFile(draftFile, suggested.stdout);
  ok(invoke('rules', 'save', draftFile, '--select', ProfileSchema.parse(JSON.parse(suggested.stdout)).rules[0]!.id));
  await writeFile(profileFile, '{ "formatVersion": 2, "state": "active", "profile": { "id": 1 } }');
  const damaged = await readFile(profileFile, 'utf8');

  const shown = invoke('preview', dirs.work);
  assert.equal(shown.status, 0);
  assert.match(shown.stderr, /경고: 저장된 개인 규칙 프로필이 손상돼 적용하지 않았습니다/u);
  assert.match(shown.stdout, /저장된 프로필 손상으로 적용하지 않음/u);
  const json = preview();
  assert.equal(json.profile.source, 'corrupt'); assert.deepEqual(dest(json.preview), DEFAULT);
  assert.equal(JSON.parse(ok(invoke('rules', 'list', '--json')).stdout).state, 'corrupt');
  const edit = invoke('rules', 'disable-all');
  assert.equal(edit.status, 1); assert.match(edit.stderr, /^AFO 오류\[STATE_CORRUPT\]: /u);
  assert.equal(invoke('preview', dirs.work, '--move', '메모.txt=메모함', '--remember').status, 1);
  assert.equal(invoke('rules', 'reset').status, 2);
  assert.equal(await readFile(profileFile, 'utf8'), damaged);
  await unchanged();
});

test('preview option errors are usage errors (2) or input errors (1) and change nothing', async (t) => {
  const { dirs, invoke, unchanged } = await setup(t);
  for (const args of [['--move', '메모.txt'], ['--move', '메모.txt=../밖'], ['--move', '메모.txt=.숨김'], ['--remember'],
    ['--move', '메모.txt=a', '--move', '메모.txt=b'], ['--move', '메모.txt=a', '--remember', '--no-saved-rules'],
    ['--select', 'x'], ['--confirm', 'reset']]) {
    const r = invoke('preview', dirs.work, ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.equal(invoke('preview', dirs.work, '--move', '없는파일.txt=a').status, 1);
  assert.equal(invoke('rules').status, 2);
  assert.equal(invoke('rules', 'enable').status, 2);
  assert.equal(invoke('rules', 'list', 'extra').status, 2);
  assert.equal(invoke('suggest-rules', dirs.reference, '--select', 'x').status, 2);
  await assert.rejects(stat(path.join(dirs.state, 'profiles', 'active.json')));
  await unchanged();
});

test('reset in a TTY asks y/N; anything but yes keeps the profile (exit 4)', async (t) => {
  const { dirs, invoke, ok, profileFile } = await setup(t);
  const suggested = ok(invoke('suggest-rules', dirs.reference, '--json'));
  const draftFile = path.join(dirs.base, 'draft.json');
  await writeFile(draftFile, suggested.stdout);
  ok(invoke('rules', 'save', draftFile, '--select', ProfileSchema.parse(JSON.parse(suggested.stdout)).rules[0]!.id));
  const kept = await readFile(profileFile, 'utf8');
  const questions: string[] = [];
  const io = (answer: string) => ({ stateDir: dirs.state, isTTY: true, warn: () => {},
    ask: (q: string) => { questions.push(q); return Promise.resolve(answer); } });
  const declined = await run(['rules', 'reset'], undefined, io('')).then(() => null, (e: unknown) => e);
  assert.equal(exitCodeOf(declined), 4);
  assert.match(questions[0]!, /규칙 1개와 저장한 수정 0개를 모두 잊습니다.*\[y\/N\]/u);
  assert.equal(await readFile(profileFile, 'utf8'), kept);
  assert.match(await run(['rules', 'reset'], undefined, io('y')), /초기화했습니다/u);
  assert.equal(JSON.parse(await run(['rules', 'list', '--json'], undefined, io('')) ).state, 'none');
});

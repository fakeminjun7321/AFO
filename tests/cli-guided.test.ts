import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { errorLine, exitCodeOf, runCli } from '../apps/cli/src/index.js';
import { cleanDroppedPath } from '../apps/cli/src/guided.js';
import { haeyo } from '../apps/cli/src/words.js';
import { createFixture, manifest } from './helpers.js';
import type { FixtureSpec, Manifest } from './helpers.js';

/*
 * Guided `afo` (no arguments on a TTY) and `afo undo` without a run ID. TTY questions are answered in-process through runCli's io
 * (no pty in child processes); file results are checked with the independent manifest oracle, never with CLI output.
 * Synthetic mkdtemp folders and a temp AFO_STATE_DIR only. The real OS trash is used only with AFO_REAL_TRASH_TEST=1.
 */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Answer = string | ((screen: string) => string);

const baseSpec: FixtureSpec = {
  'work/a.pdf': 'pdf-a', 'work/b.jpg': 'jpg-b', 'work/clip.mp4': 'video', 'work/notes': 'no extension',
  'work/c.txt': 'same-text', 'work/c copy.txt': 'same-text', 'state/': '',
};
// Default rules, written out independently of the product: where each file must end up after "1) 폴더별로 정리하기".
const expectedMoves: Record<string, string> = { 'a.pdf': '문서/a.pdf', 'b.jpg': '이미지/b.jpg', 'clip.mp4': '영상/clip.mp4',
  'c.txt': '문서/c.txt', 'c copy.txt': '문서/c copy.txt' };

async function setup(t: TestContext, spec: FixtureSpec = baseSpec) {
  const { root } = await createFixture(spec, t);
  const dirs = { work: path.join(root, 'work'), state: path.join(root, 'state') };
  /** A scripted TTY session: answers in order; a function answer reads what was shown so far (stderr screen). */
  const session = (...answers: Answer[]) => {
    const lines: string[] = []; const questions: string[] = [];
    const io = { stateDir: dirs.state, isTTY: true, warn: (l: string) => { lines.push(l); },
      ask: (q: string) => {
        questions.push(q); lines.push(q);
        const a = answers.shift();
        if (a === undefined) return Promise.reject(new Error(`unexpected question: ${q}`));
        return Promise.resolve(typeof a === 'function' ? a(lines.join('\n')) : a);
      } };
    return { io, screen: () => lines.join('\n'), questions };
  };
  const invoke = (args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, AFO_STATE_DIR: dirs.state }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  return { root, dirs, session, invoke };
}
const ORGANIZE = '이대로 정리할까요? 나중에 afo undo로 되돌릴 수 있어요. (Y/n): ';
const trashQuestion = (n: number): string => `이 사본 ${n}개를 휴지통으로 보낼까요? afo undo로는 되돌리지 않아요. (y/N): `;
const UNDO = '되돌릴까요? (Y/n): ';
const NO_CODE = '계속하려면 아래 코드를';
/** An answer that first checks the question just asked is `question` and that no approval code is shown, then answers `answer`. */
const at = (question: string, answer: string) => (screen: string): string => {
  assert.ok(screen.endsWith(question), `asked: ${question}`);
  assert.ok(!screen.includes(NO_CODE), 'no code to type in the guided flow');
  return answer;
};
/** "y" to the organize question (the old "type the shown code"). */
const approvalShown = at(ORGANIZE, 'y');
/** "y" to `afo undo` in a terminal (the old "type the shown undo code"). */
const undoShown = at(UNDO, 'y');
/** These whole lines appear on the screen consecutively, in this order. */
const assertLines = (screen: string, lines: string[]): void => {
  assert.ok(`\n${screen}\n`.includes(`\n${lines.join('\n')}\n`), `expected consecutive lines:\n${lines.join('\n')}\n--- screen:\n${screen}`);
};
const files = (m: Manifest): Manifest => Object.fromEntries(Object.entries(m).filter(([, e]) => e.type === 'file'));
const sha = (m: Manifest, rel: string): string | undefined => { const e = m[rel]; return e?.type === 'file' ? e.sha256 : undefined; };
const stopOf = async (p: Promise<unknown>): Promise<{ exit: number; line: string }> => {
  try { await p; } catch (error) { return { exit: exitCodeOf(error), line: errorLine(error) }; }
  assert.fail('expected the guided flow to stop with an error');
};
const exitOf = async (p: Promise<unknown>): Promise<number> => (await stopOf(p)).exit;

test('dragged folder text is cleaned: quotes, macOS backslash escapes, surrounding spaces, ~/ (Windows backslashes stay)', () => {
  const home = '/Users/someone';
  assert.equal(cleanDroppedPath("'/tmp/my files/2026 과제' ", home, 'darwin'), '/tmp/my files/2026 과제');
  assert.equal(cleanDroppedPath('"/tmp/my files/a\\ b"', home, 'darwin'), '/tmp/my files/a\\ b', 'quoted text is literal');
  assert.equal(cleanDroppedPath('  /tmp/my\\ files/\\(1\\)\\ 정리  ', home, 'darwin'), '/tmp/my files/(1) 정리');
  assert.equal(cleanDroppedPath('~/AFO\\ test', home, 'darwin'), path.join(home, 'AFO test'));
  assert.equal(cleanDroppedPath('~', home, 'darwin'), home);
  assert.equal(cleanDroppedPath('C:\\Users\\a\\AFO 테스트', home, 'win32'), 'C:\\Users\\a\\AFO 테스트');
  assert.equal(cleanDroppedPath('"C:\\AFO Test"', home, 'win32'), 'C:\\AFO Test');
  assert.equal(cleanDroppedPath('   ', home, 'darwin'), '');
});

test('guided: a rejected folder is explained and asked again; three failures stop with 1; empty input quits with 0', async (t) => {
  const { dirs, session } = await setup(t);
  const before = await manifest(dirs.work);
  const retry = session(path.join(dirs.work, 'missing'), path.join(dirs.work, 'a.pdf'), `'${dirs.work}'`, '4');
  const quit = await runCli([], undefined, retry.io);
  assert.equal(quit.exitCode, 0);
  assert.match(quit.output, /그만뒀어요\. 아무것도 바꾸지 않았어요/u);
  assert.equal(retry.questions.filter((q) => q.includes('끌어다 놓고')).length, 3);
  assert.equal((retry.screen().match(/이 폴더는 정리할 수 없어요: /gu) ?? []).length, 2);
  assert.match(retry.screen(), /파일 6개를 살펴봤어요/u);

  const fail = session(path.join(dirs.work, 'x'), path.join(dirs.work, 'y'), path.join(dirs.work, 'z'));
  assert.deepEqual(await stopOf(runCli([], undefined, fail.io)), { exit: 1, line: '폴더를 3번 열지 못해 그만둘게요. 아무것도 바꾸지 않았어요.' });
  assert.match(fail.screen(), /이 폴더는 정리할 수 없어요: 선택한 폴더를 찾거나 읽을 수 없어요\./u, 'the service sentence in 해요체');
  const empty = session('');
  assert.equal((await runCli([], undefined, empty.io)).exitCode, 0);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('guided: menu 1 → typed code really moves files (independent manifest), then `afo undo` without an ID restores them', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  // Quoted with a trailing space, as some terminals paste a dropped folder.
  const s = session(`'${dirs.work}' `, '1', '', approvalShown);
  const result = await runCli([], undefined, s.io);
  assert.equal(result.exitCode, 0, result.output);
  // Folders most first, ties by name; review reasons as short names (the full sentence is only in 3) 자세히 보기).
  // The folder tree as it will look: root name, folders most first (ties by name), two example names each.
  assertLines(s.screen(), ['  폴더별로 정리할 수 있는 파일: 5개 — 정리하면 이렇게 돼요:', '    work/',
    '    ├─ 문서/ 3개 (예: a.pdf, c copy.txt, …)', '    ├─ 영상/ 1개 (예: clip.mp4)', '    └─ 이미지/ 1개 (예: b.jpg)',
    '  직접 확인이 필요한 파일: 1개 — 확장자 없음 1']);
  assert.doesNotMatch(s.screen(), /문서 3 · /u, 'the old one-line tally is gone');
  assert.match(s.screen(), /^AFO 파일 정리 도우미예요\. 파일을 옮기기 전에 무엇을 할지 보여 주고 꼭 물어봐요\. \(Ctrl\+C로 언제든 그만둘 수 있어요\)$/mu);
  assert.match(s.screen(), /^ {2}5\) 내 정리 방식 알려 주기\(잘 정리해 둔 폴더를 참고해요\)$/mu);
  assert.match(s.screen(), /직접 확인이 필요한 파일: 1개 — 확장자 없음 1\n/u);
  assert.match(s.screen(), /같은 내용의 중복 파일: 1묶음\(휴지통으로 보낼 수 있는 사본 1개\) — 예: 남길 파일 'c\.txt', 휴지통 후보 'c copy\.txt'/u);
  assert.match(s.screen(), /경로를 붙여 넣어도 돼요/u);
  assert.match(s.screen(), /^ {5}같은 내용의 사본 1개도 함께 옮겨요\. 먼저 2\)로 정리할 수도 있어요\.$/mu, 'O12 under menu 1');
  assert.match(s.screen(), /2\) 중복 파일을 휴지통으로 보내기\(휴지통에서 다시 꺼낼 수 있어요\. afo undo로는 되돌리지 않아요\) — 사본 1개/u);
  assert.match(s.screen(), /저장된 내 정리 규칙이 없어[^\n]* 잘 정리해 둔 폴더가 있으면 5\)로 그 방식을 따라 할 수 있어요\./u);
  assert.match(s.screen(), /1\) 폴더별로 정리하기\(되돌릴 수 있어요\) — 파일 5개/u);
  assert.match(result.output, /^정리를 마쳤어요\.$/mu, 'no run ID in the headline');
  assert.doesNotMatch(result.output, /실행 ID/u);
  assert.match(result.output, /옮김 5 · 건너뜀 0 · 실패 0/u);
  assert.match(result.output, /되돌리려면: afo undo/u);
  assert.match(result.output, /\n다음에도 afo만 입력하고 Enter를 누르면 이 폴더를 같은 방식으로 정리해요\.\n정리 기록은 afo runs로 볼 수 있어요\.$/u,
    'no rules: no "내 정리 규칙" sentence');

  const moved = await manifest(dirs.work);
  for (const [source, destination] of Object.entries(expectedMoves)) {
    assert.equal(moved[source], undefined, `${source} is gone from its original path`);
    assert.equal(sha(moved, destination), sha(before, source), `${destination} has the content of ${source}`);
  }
  assert.deepEqual(moved.notes, before.notes, 'the file that needs review is untouched');
  assert.equal(Object.keys(files(moved)).length, Object.keys(files(before)).length);

  // Same run cannot be repeated with the same code (existing apply rule), and runs shows it as undoable.
  assert.match(invoke(['runs']).stdout, /undo 가능/u);
  const undo = session(undoShown);
  const undone = await runCli(['undo'], undefined, undo.io);
  assert.equal(undone.exitCode, 0, undone.output);
  // Short screen: local time, file list without operation IDs, no ISO timestamps.
  assert.match(undo.screen(), /^\d{1,2}월 \d{1,2}일 (오전|오후) \d{1,2}:\d{2}에 정리한 파일 5개를 원래 자리로 되돌릴까요\?$/mu);
  assert.match(undo.screen(), /^  문서\/a\.pdf → a\.pdf$/mu);
  assert.deepEqual(undo.questions, [UNDO], 'one yes/no question, no code');
  assert.doesNotMatch(undo.screen(), /[0-9a-f]{16}|\d{4}-\d{2}-\d{2}T/u);
  assert.match(undone.output, /^되돌렸어요: 5개 · 건너뜀 0$/mu);
  assert.match(undone.output, /정리할 때 만든 빈 폴더 3개도 지웠어요/u);
  assert.deepEqual(await manifest(dirs.work), before, 'files and folders exactly as before (paths, hashes, mtimes; no leftover folders)');
  const again = await runCli(['undo'], undefined, session().io);
  assert.equal(again.exitCode, 0);
  assert.match(again.output, /되돌릴 수 있는 정리 기록이 없어요/u);
});

test('guided: "n" stops with 4, three unrecognised answers stop with 2, trash Enter means no; nothing changes, no approval or run', async (t) => {
  // Was "a wrong or empty code stops with 4": the typed code became a yes/no question; the same stops and the same oracles.
  const { dirs, session } = await setup(t);
  const before = await manifest(dirs.work);
  const no = session(dirs.work, '1', '', at(ORGANIZE, 'n'));
  assert.deepEqual(await stopOf(runCli([], undefined, no.io)), { exit: 4, line: '정리하지 않았어요. 아무것도 바꾸지 않았어요.' },
    'no "AFO 오류:" prefix for a stop the user chose');
  const noTrash = session(dirs.work, '2', at(trashQuestion(1), 'n'));
  assert.deepEqual(await stopOf(runCli([], undefined, noTrash.io)), { exit: 4, line: '휴지통으로 보내지 않았어요. 아무것도 바꾸지 않았어요.' });
  assert.match(noTrash.screen(), /이 사본들을 휴지통으로 보낼게요\(1개, 남길 파일은 그대로\)/u);
  assert.match(noTrash.screen(), /^  c copy\.txt \(같은 내용의 'c\.txt' 파일은 남겨요\)$/mu, 'the copy goes, the original stays');
  // The trash is not undone by afo undo: Enter is "no" there (organize's Enter is "yes", tested elsewhere).
  const enterTrash = session(dirs.work, '2', at(trashQuestion(1), ''));
  assert.deepEqual(await stopOf(runCli([], undefined, enterTrash.io)), { exit: 4, line: '휴지통으로 보내지 않았어요. 아무것도 바꾸지 않았어요.' });
  const garbled = session(dirs.work, '1', '', at(ORGANIZE, '00000000'), 'maybe', '1');
  assert.deepEqual(await stopOf(runCli([], undefined, garbled.io)), { exit: 2, line: '답을 알아듣지 못해 그만둘게요. 아무것도 바꾸지 않았어요.' });
  assert.equal(garbled.questions.filter((q) => q === ORGANIZE).length, 3, 'asked three times');
  assert.equal((garbled.screen().match(/y\(네\) 또는 n\(아니요\)으로 답해 주세요\./gu) ?? []).length, 2);
  const garbledTrash = session(dirs.work, '2', 'ㅁ', 'x', 'ok');
  assert.equal(await exitOf(runCli([], undefined, garbledTrash.io)), 2);
  assert.deepEqual(await manifest(dirs.work), before);
  assert.deepEqual(await readdir(path.join(dirs.state, 'approvals')).catch(() => []), [], 'no approval was issued');
  assert.deepEqual(await readdir(path.join(dirs.state, 'runs')).catch(() => []), [], 'nothing ran');
  assert.ok(!(await readdir(dirs.state)).includes('guided.json'), 'a declined run is not remembered as the last folder');
});

test('guided: menu items without work are shown as "할 일 없음" and cannot be chosen; 3) lists the classification', async (t) => {
  const { dirs, session } = await setup(t, { 'work/notes.pdf.exe': 'compound extension', 'work/문서/a.pdf': 'already placed', 'state/': '' });
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '1', '2', '3', '4');
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0);
  assert.match(s.screen(), /1\) 폴더별로 정리하기\(되돌릴 수 있어요\) — 할 일 없음/u);
  assert.match(s.screen(), /2\) 중복 파일을 휴지통으로 보내기 — 할 일 없음/u);
  assert.equal((s.screen().match(/그 작업은 할 일이 없어요/gu) ?? []).length, 2);
  assertLines(s.screen(), ['  폴더별로 정리할 수 있는 파일: 0개', '  그대로 둘 파일: 1개 — 이미 정리된 위치 1']);
  assert.match(s.screen(), /^ {2}\[확인 필요\] notes\.pdf\.exe — 확장자가 여러 개$/mu);
  assert.match(s.screen(), /^ {2}\[그대로\] 문서\/a\.pdf — 이미 정리된 위치$/mu);
  assert.ok(!s.screen().includes('계속하려면 아래 코드를'), 'no code is offered');
  const stubborn = session(dirs.work, '1', '9', '1');
  assert.deepEqual(await stopOf(runCli([], undefined, stubborn.io)), { exit: 2, line: '번호를 알아듣지 못해 그만둘게요. 아무것도 바꾸지 않았어요.' });
  assert.equal((stubborn.screen().match(/1~5 중에서 골라 주세요\./gu) ?? []).length, 1);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('guided: Ctrl+C at a question cancels with 130 and changes nothing; no TTY means help, never questions', async (t) => {
  const { dirs, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  let asked = 0;
  const abort = (q: string): Promise<string> => {
    asked += 1;
    if (q === ORGANIZE) return Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    return Promise.resolve(q.includes('끌어다') ? dirs.work : '1');
  };
  assert.deepEqual(await stopOf(runCli([], undefined, { stateDir: dirs.state, isTTY: true, warn: () => {}, ask: abort })),
    { exit: 130, line: '그만뒀어요(Ctrl+C). 아무것도 바꾸지 않았어요.' }, 'before running, stated definitely');
  assert.equal(asked, 4, 'folder, menu, unknown files, yes/no');
  assert.deepEqual(await readdir(path.join(dirs.state, 'approvals')).catch(() => []), [], 'no approval was issued');
  // Cancel during the analysis (pre-aborted signal): the same message instead of AFO 오류[CANCELLED].
  const aborted = AbortSignal.abort();
  assert.deepEqual(await stopOf(runCli([], aborted, { stateDir: dirs.state, isTTY: true, warn: () => {},
    ask: () => Promise.resolve(dirs.work) })), { exit: 130, line: '그만뒀어요(Ctrl+C). 아무것도 바꾸지 않았어요.' });
  assert.deepEqual(await manifest(dirs.work), before);

  const help = await runCli([], undefined, { stateDir: dirs.state, isTTY: false, warn: () => {},
    ask: () => assert.fail('no question without a TTY') });
  assert.equal(help.exitCode, 0);
  assert.match(help.output, /afo {2,}안내를 따라 폴더 정리하기/u);
  const child = invoke([]);
  assert.equal(child.status, 0);
  assert.match(child.stdout, /자주 쓰는 명령/u);
  assert.match(child.stdout, /afo help --all/u);
});

test('undo without an ID: no TTY needs --confirm of the latest undoable run (else 4); nothing to undo is 0', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const none = invoke(['undo']);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /되돌릴 수 있는 정리 기록이 없어요/u);
  const before = await manifest(dirs.work);
  assert.equal((await runCli([], undefined, session(dirs.work, '1', '', approvalShown).io)).exitCode, 0);
  const moved = await manifest(dirs.work);
  const refused = invoke(['undo']);
  assert.equal(refused.status, 4);
  assert.match(refused.stderr, /--confirm/u);
  assert.deepEqual(await manifest(dirs.work), moved);
  const runId = (JSON.parse(invoke(['runs', '--json']).stdout) as { runs: { runId: string }[] }).runs.at(-1)!.runId;
  assert.equal(invoke(['undo', '--confirm', 'ffffffff']).status, 4);
  const ok = invoke(['undo', '--confirm', runId.slice(0, 8)]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(files(await manifest(dirs.work)), files(before));
});

test('entry point works through a symlink, as `npm link` installs it (no global install in tests)', async (t) => {
  const { root, dirs } = await setup(t);
  const link = path.join(root, 'afo');
  await symlink(cli, link);
  const r = spawnSync(process.execPath, [link, 'help'], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AFO_STATE_DIR: dirs.state } });
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(String(r.stdout), /자주 쓰는 명령/u);
  const undo = spawnSync(process.execPath, [link, 'undo'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, AFO_STATE_DIR: dirs.state } });
  assert.equal(undo.status, 0, String(undo.stderr));
  assert.match(String(undo.stdout), /되돌릴 수 있는 정리 기록이 없어요/u);
});

test('guided menu 2 (AFO_REAL_TRASH_TEST=1 only): one synthetic afo-test- duplicate goes to the real OS trash, the keeper stays', {
  skip: process.env.AFO_REAL_TRASH_TEST === '1' ? false : 'set AFO_REAL_TRASH_TEST=1 to send one synthetic file to the real OS trash',
}, async (t) => {
  const tag = `afo-test-guided-${process.pid}-${Date.now()}`;
  const { dirs, session } = await setup(t, { [`work/${tag}.txt`]: `dup ${tag}`, [`work/${tag} copy.txt`]: `dup ${tag}`,
    'work/other.pdf': 'unrelated', 'state/': '' });
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '2', 'y');
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(s.questions.at(-1), trashQuestion(1), 'the trash question (y/N), not the organize one');
  assert.match(r.output, /휴지통으로 보냄 1 · 건너뜀 0 · 실패 0/u);
  const after = await manifest(dirs.work);
  const pair = [`${tag}.txt`, `${tag} copy.txt`];
  assert.equal(pair.filter((p) => after[p] !== undefined).length, 1, 'exactly one copy remains');
  for (const p of pair) if (after[p] !== undefined) assert.deepEqual(after[p], before[p], 'the keeper is unchanged');
  assert.deepEqual(after['other.pdf'], before['other.pdf'], 'organize was not chosen: other files stay');
  t.diagnostic(`trashed one synthetic ${tag} copy; this test never empties or reads the trash`);
});

test('D1: files kept because of reference protection say so in the summary and in 3) (reference folder = work folder)', async (t) => {
  const { dirs, session, invoke } = await setup(t, { 'work/과제/물리/물리_1.pdf': 'r1', 'work/과제/물리/물리_2.pdf': 'r2', 'state/': '' });
  const suggested = invoke(['suggest-rules', dirs.work, '--json']);
  assert.equal(suggested.status, 0, suggested.stderr);
  const draftFile = path.join(path.dirname(dirs.state), 'draft.json');
  await writeFile(draftFile, suggested.stdout);
  const rule = (JSON.parse(suggested.stdout) as { rules: { id: string }[] }).rules[0]!;
  assert.equal(invoke(['rules', 'save', draftFile, '--select', rule.id]).status, 0);
  await writeFile(path.join(dirs.work, '물리_새보고서.pdf'), 'new');
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '3', '4');
  assert.equal((await runCli([], undefined, s.io)).exitCode, 0);
  assert.match(s.screen(), /그대로 둘 파일: 3개 — 참고 폴더 보호 3\n/u);
  assert.match(s.screen(), /^ {2}\[그대로\] 물리_새보고서\.pdf — 참고 폴더 보호$/mu);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('haeyo: reused 합니다체 sentences become 해요체 on the guided screens; unknown endings stay', () => {
  assert.equal(haeyo('선택한 폴더를 찾거나 읽을 수 없습니다.'), '선택한 폴더를 찾거나 읽을 수 없어요.');
  assert.equal(haeyo('일반 폴더를 직접 선택해야 합니다(파일·링크·바로가기 불가).'), '일반 폴더를 직접 선택해야 해요(파일·링크·바로가기 불가).');
  assert.equal(haeyo('홈 전체, 디스크 루트와 시스템 폴더는 분석 대상이 아닙니다.'), '홈 전체, 디스크 루트와 시스템 폴더는 분석 대상이 아니에요.');
  assert.equal(haeyo('목적지에 이미 파일이 있어 덮어쓰지 않았습니다.'), '목적지에 이미 파일이 있어 덮어쓰지 않았어요.');
  assert.equal(haeyo('되돌렸습니다(원래 위치로 이동). 폴더 1개를 다시 만들었습니다.'), '되돌렸어요(원래 위치로 이동). 폴더 1개를 다시 만들었어요.');
  assert.equal(haeyo('개발 프로젝트 내부는 분석하지 않습니다.'), '개발 프로젝트 내부는 분석하지 않아요.');
  assert.equal(haeyo('기타/검토 대상입니다. 임시 경로입니다.'), '기타/검토 대상이에요. 임시 경로예요.');
  assert.equal(haeyo('상태 폴더와 작업 폴더가 겹칩니다.'), '상태 폴더와 작업 폴더가 겹쳐요.');
  assert.equal(haeyo('그대로예요. Done.'), '그대로예요. Done.');
});

/* ---- `afo <폴더>`, the remembered folder, the folder tree, menu 5 and `afo undo`'s yes/no (the yes/no guided flow). ---- */
const FOLDER_Q = '정리할 폴더를 이 창으로 끌어다 놓고 Enter를 누르세요(경로를 붙여 넣어도 돼요, 그냥 Enter는 종료): ';
const LAST_Q = '정리할 폴더를 이 창으로 끌어다 놓고 Enter를 누르세요(그냥 Enter는 지난번 폴더, q는 종료): ';
const MENU = '번호를 입력하세요: ';
const SAVE_Q = '이 방식을 저장해서 이번 정리와 다음 정리에 쓸까요? (Y/n): ';
const REF_Q = '정리된 폴더(그냥 Enter는 돌아가기): ';
/** Exit code of a CLI call that may return (exitCode) or throw (exitCodeOf). */
const exitAny = async (p: Promise<{ exitCode: number }>): Promise<number> => { try { return (await p).exitCode; } catch (e) { return exitCodeOf(e); } };
const stateHas = async (stateDir: string, name: string): Promise<boolean> => (await readdir(stateDir)).includes(name);
/** Every file of `before` is at its expected new path (or unchanged when not listed) with the same content; nothing else appeared. */
function assertMoved(before: Manifest, after: Manifest, moves: Record<string, string>): void {
  const names = (m: Manifest) => Object.keys(files(m)).sort();
  assert.deepEqual(names(after), names(before).map((rel) => moves[rel] ?? rel).sort());
  for (const rel of names(before)) assert.equal(sha(after, moves[rel] ?? rel), sha(before, rel), rel);
}

test('afo <폴더>: a TTY starts at the summary (no folder question) and organizes on y; no TTY equals preview; a non-folder word is 2', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  // Outside a terminal it is exactly `preview <폴더>`: same stdout and exit, no question, nothing changed or approved.
  const piped = invoke([dirs.work]);
  const preview = invoke(['preview', dirs.work]);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.status, preview.status);
  assert.equal(piped.stdout, preview.stdout);
  assert.ok(!piped.stderr.includes('끌어다 놓고') && !piped.stderr.includes(MENU));
  assert.deepEqual(await manifest(dirs.work), before);
  for (const name of ['approvals', 'runs', 'guided.json']) assert.ok(!await stateHas(dirs.state, name), `no ${name} after a preview`);

  // A word that is not an existing folder (or a file) stays a usage error, in a TTY too, and asks nothing.
  assert.equal(await exitAny(runCli(['nosuchword'], undefined, session().io)), 2);
  assert.equal(await exitAny(runCli([path.join(dirs.work, 'a.pdf')], undefined, session().io)), 2, 'a file is not a folder');
  assert.equal(invoke(['nosuchword']).status, 2);

  const s = session('1', '', approvalShown);
  const r = await runCli([dirs.work], undefined, s.io);
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(s.questions[0], MENU, 'the first question is the menu');
  assert.ok(!s.questions.some((q) => q.includes('끌어다 놓고')), 'no folder question');
  assert.match(s.screen(), /파일 6개를 살펴봤어요/u);
  assertMoved(before, await manifest(dirs.work), expectedMoves);
});

test('last folder: after a run, Enter reuses it (really organizes a new file); q quits 0; a deleted folder is not offered', async (t) => {
  const { root, dirs, session } = await setup(t);
  assert.equal((await runCli([], undefined, session(dirs.work, '1', '', approvalShown).io)).exitCode, 0);
  assert.ok(await stateHas(dirs.state, 'guided.json'), 'remembered after the run');
  await writeFile(path.join(dirs.work, 'new.pdf'), 'new pdf');
  const start = await manifest(dirs.work);

  const quit = session(at(LAST_Q, 'q'));
  const q = await runCli([], undefined, quit.io);
  assert.equal(q.exitCode, 0);
  assert.equal(q.output, '그만뒀어요. 아무것도 바꾸지 않았어요.');
  assert.match(quit.screen(), new RegExp(`^지난번에 정리한 폴더: ${dirs.work.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
  assert.deepEqual(await manifest(dirs.work), start);

  const again = session(at(LAST_Q, ''), '1', '', approvalShown);
  const r = await runCli([], undefined, again.io);
  assert.equal(r.exitCode, 0, r.output);
  assert.deepEqual(again.questions.filter((x) => x.includes('끌어다 놓고')), [LAST_Q], 'asked once, Enter took the last folder');
  assertMoved(start, await manifest(dirs.work), { 'new.pdf': '문서/new.pdf' });

  // A remembered folder that no longer exists is not offered: the usual question, and Enter quits.
  const other = path.join(root, 'other');
  await mkdir(other); await writeFile(path.join(other, 'z.pdf'), 'z');
  assert.equal((await runCli([], undefined, session(other, '1', approvalShown).io)).exitCode, 0);
  await rm(other, { recursive: true });
  const gone = session(at(FOLDER_Q, ''));
  assert.equal((await runCli([], undefined, gone.io)).exitCode, 0);
  assert.ok(!gone.screen().includes('지난번에 정리한 폴더'));
  assert.equal(gone.questions.length, 1);
});

test('summary tree: root name, ├─/└─ rows most first then by name, counts and two examples, "… 폴더 N개 더" past 8 folders', async (t) => {
  const { dirs, session } = await setup(t, { 'work/a.pdf': '1', 'work/b.pdf': '2', 'work/c.pdf': '3', 'work/p.png': '4', 'work/q.png': '5',
    'work/v.mp4': '6', 'work/m.mp3': '7', 'work/z.zip': '8', 'work/s.dmg': '9', 'work/d.psd': '10', 'work/f.ttf': '11', 'work/e.epub': '12',
    'work/x.py': '13', 'work/j.json': '14', 'state/': '' });
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '4');
  assert.equal((await runCli([], undefined, s.io)).exitCode, 0);
  // 11 default folders: 문서 3, 이미지 2, then the nine 1-file folders by name (code point order); 8 rows, then the rest counted.
  assertLines(s.screen(), ['  폴더별로 정리할 수 있는 파일: 14개 — 정리하면 이렇게 돼요:', '    work/',
    '    ├─ 문서/ 3개 (예: a.pdf, b.pdf, …)', '    ├─ 이미지/ 2개 (예: p.png, q.png)', '    ├─ 글꼴/ 1개 (예: f.ttf)',
    '    ├─ 데이터/ 1개 (예: j.json)', '    ├─ 디자인/ 1개 (예: d.psd)', '    ├─ 설치/ 1개 (예: s.dmg)', '    ├─ 압축/ 1개 (예: z.zip)',
    '    ├─ 영상/ 1개 (예: v.mp4)', '    └─ … 폴더 3개 더']);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('menu 5: rules from a tidy reference folder are shown, y saves them, the re-analysis and the next run use them; reference untouched', async (t) => {
  const { root, dirs, session, invoke } = await setup(t, { 'ref/과제/물리/물리_1주차.pdf': 'r1', 'ref/과제/물리/물리_2주차.pdf': 'r2',
    'ref/과제/영어/영어_1.pdf': 'r3', 'ref/과제/영어/영어_2.pdf': 'r4', 'ref/사진/a.jpg': 'r5', 'ref/사진/b.jpg': 'r6',
    'work/물리_3주차.pdf': 'w1', 'work/영어_숙제.pdf': 'w2', 'work/보고서.pdf': 'w3', 'work/photo.jpg': 'w4', 'state/': '' });
  const ref = path.join(root, 'ref');
  const refBefore = await manifest(ref);
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '5', `'${ref}' `, at(SAVE_Q, 'y'), '1', approvalShown);
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0, r.output);
  assert.deepEqual(s.questions, [FOLDER_Q, MENU, REF_Q, SAVE_Q, MENU, ORGANIZE]);
  assertLines(s.screen(), ['찾은 정리 방식 3개:', '  모든 .jpg 파일 → 사진/ (예: a.jpg, b.jpg)',
    "  이름에 '물리'가 들어간 .pdf 파일 → 과제/물리/ (예: 물리_1주차.pdf, 물리_2주차.pdf)",
    "  이름에 '영어'가 들어간 .pdf 파일 → 과제/영어/ (예: 영어_1.pdf, 영어_2.pdf)", '참고한 폴더의 파일은 옮기거나 지우지 않아요.']);
  assert.match(s.screen(), /^저장했어요: 내 정리 규칙 3개\./mu);
  assert.match(s.screen(), /^내 정리 규칙을 적용해 다시 살펴봤어요:\n파일 4개를 살펴봤어요/mu);
  assert.match(s.screen(), /^ {4}├─ 과제\/물리\/ 1개 \(예: 물리_3주차\.pdf\)$/mu, 'the tree after re-analysis uses the saved rules');
  assert.match(r.output, /다음에도 afo만 입력하고 Enter를 누르면 이 폴더를 같은 방식으로 정리해요\. 저장한 내 정리 규칙도 계속 적용돼요\./u);
  assertMoved(before, await manifest(dirs.work), { '물리_3주차.pdf': '과제/물리/물리_3주차.pdf', '영어_숙제.pdf': '과제/영어/영어_숙제.pdf',
    '보고서.pdf': '문서/보고서.pdf', 'photo.jpg': '사진/photo.jpg' });
  assert.deepEqual(await manifest(ref), refBefore, 'reference files byte-identical (paths, hashes, mtimes)');

  // Saved like `rules save --select <all>`: visible to `rules list --json`, and a new process applies them to a new file.
  const listed = JSON.parse(invoke(['rules', 'list', '--json']).stdout) as { state: string; profile: { rules: { extension: string;
    keyword: string | null; targetDirectory: string }[] } };
  assert.equal(listed.state, 'active');
  assert.deepEqual(listed.profile.rules.map((x) => [x.extension, x.keyword, x.targetDirectory]).sort(),
    [['.jpg', null, '사진'], ['.pdf', '물리', '과제/물리'], ['.pdf', '영어', '과제/영어']]);
  await writeFile(path.join(dirs.work, '물리_4주차.pdf'), 'w5');
  const p = invoke(['preview', dirs.work, '--json']);
  assert.equal(p.status, 0, p.stderr);
  const items = (JSON.parse(p.stdout) as { preview: { items: { source: string; destination: string | null }[] } }).preview.items;
  assert.equal(items.find((i) => i.source === '물리_4주차.pdf')?.destination, '과제/물리/물리_4주차.pdf');
  assert.deepEqual(await manifest(ref), refBefore);
});

test('menu 5: n saves nothing; Enter at the folder question goes back; no usable pattern or a bad folder says so; all change nothing', async (t) => {
  const { root, dirs, session, invoke } = await setup(t, { 'ref/사진/a.jpg': 'r1', 'ref/사진/b.jpg': 'r2',
    'flat/x.pdf': 'f1', 'flat/a/y.pdf': 'f2', 'flat/b/z.jpg': 'f3', 'work/photo.jpg': 'w1', 'state/': '' });
  const ref = path.join(root, 'ref'); const flat = path.join(root, 'flat');
  const start = { work: await manifest(dirs.work), ref: await manifest(ref), flat: await manifest(flat) };
  const unchangedAll = async () => {
    assert.deepEqual(await manifest(dirs.work), start.work);
    assert.deepEqual(await manifest(ref), start.ref);
    assert.deepEqual(await manifest(flat), start.flat);
    assert.equal(JSON.parse(invoke(['rules', 'list', '--json']).stdout).state, 'none', 'no rules saved');
    for (const name of ['approvals', 'runs', 'guided.json']) assert.ok(!await stateHas(dirs.state, name), `no ${name}`);
  };
  const no = session(dirs.work, '5', ref, at(SAVE_Q, 'n'), '4');
  assert.equal((await runCli([], undefined, no.io)).exitCode, 0);
  assert.match(no.screen(), /^찾은 정리 방식 1개:$/mu);
  assert.match(no.screen(), /^저장하지 않았어요\.$/mu);
  assert.ok(!no.screen().includes('다시 살펴봤어요'));
  assert.equal(no.questions.filter((q) => q === MENU).length, 2, 'back to the menu');
  await unchangedAll();

  const back = session(dirs.work, '5', at(REF_Q, ''), '4');
  assert.equal((await runCli([], undefined, back.io)).exitCode, 0);
  assert.deepEqual(back.questions, [FOLDER_Q, MENU, REF_Q, MENU]);

  const none = session(dirs.work, '5', flat, '5', path.join(root, 'missing'), '4');
  assert.equal((await runCli([], undefined, none.io)).exitCode, 0);
  assert.match(none.screen(), /^같은 방식으로 놓인 파일이 2개 이상인 곳을 찾지 못해 규칙을 만들지 않았어요\. 기본 분류를 그대로 써요\.$/mu);
  assert.match(none.screen(), /^이 폴더는 참고할 수 없어요: /mu);
  assert.ok(!none.questions.includes(SAVE_Q));
  await unchangedAll();

  // After saving rules in this run, "n" at the organize question says the rule stays and files are unchanged.
  let line = '';
  try { await runCli([], undefined, session(dirs.work, '5', ref, 'y', '1', at(ORGANIZE, 'n')).io); }
  catch (error) { line = `${exitCodeOf(error)} ${errorLine(error)}`; }
  assert.equal(line, '4 정리하지 않았어요. 파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요).');
  assert.deepEqual(await manifest(dirs.work), start.work);
  assert.deepEqual(await manifest(ref), start.ref);
  assert.deepEqual(await readdir(path.join(dirs.state, 'approvals')).catch(() => []), []);
  assert.deepEqual(await readdir(path.join(dirs.state, 'runs')).catch(() => []), []);
});

test('afo undo in a TTY: n stops with 4 and three unclear answers with 2 (nothing moved back, run records unchanged); Enter restores', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  assert.equal((await runCli([], undefined, session(dirs.work, '1', '', approvalShown).io)).exitCode, 0);
  const moved = await manifest(dirs.work);
  const runs = path.join(dirs.state, 'runs');
  const records = await manifest(runs);

  const no = session(at(UNDO, 'n'));
  assert.deepEqual(await stopOf(runCli(['undo'], undefined, no.io)), { exit: 4, line: '되돌리지 않았어요. 아무것도 바꾸지 않았어요.' });
  assert.ok(!no.screen().includes(NO_CODE), 'no code line on the yes/no screen');
  const unclear = session(at(UNDO, '12345678'), 'x', 'z');
  assert.deepEqual(await stopOf(runCli(['undo'], undefined, unclear.io)), { exit: 2, line: '답을 알아듣지 못해 그만둘게요. 아무것도 바꾸지 않았어요.' });
  assert.deepEqual(await manifest(dirs.work), moved, 'nothing moved back');
  assert.deepEqual(await manifest(runs), records, 'run records unchanged');

  // `undo <ID>` keeps the typed code, also in a terminal: an empty answer is 4.
  const runId = (JSON.parse(invoke(['runs', '--json']).stdout) as { runs: { runId: string }[] }).runs.at(-1)!.runId;
  const byId = session(at('확인 코드 8자를 입력하세요(빈 입력은 취소): ', ''));
  assert.equal(await exitAny(runCli(['undo', runId], undefined, byId.io)), 4);
  assert.deepEqual(await manifest(dirs.work), moved);

  const yes = session(at(UNDO, ''));
  const r = await runCli(['undo'], undefined, yes.io);
  assert.equal(r.exitCode, 0, r.output);
  assert.deepEqual(await manifest(dirs.work), before, 'Enter (default yes) restores every file and folder');
});

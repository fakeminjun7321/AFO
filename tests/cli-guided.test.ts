import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { exitCodeOf, runCli } from '../apps/cli/src/index.js';
import { cleanDroppedPath } from '../apps/cli/src/guided.js';
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
const approvalShown = (screen: string): string => {
  const m = /계속하려면 아래 코드를 입력하세요: ([a-f0-9]{8})/u.exec(screen);
  assert.ok(m, 'the approval code is shown before asking');
  return m[1]!;
};
const undoShown = (screen: string): string => {
  const m = /확인 코드: (\S{8}) \(실행 ID 앞 8자\)/u.exec(screen);
  assert.ok(m, 'the undo code is shown before asking');
  return m[1]!;
};
const files = (m: Manifest): Manifest => Object.fromEntries(Object.entries(m).filter(([, e]) => e.type === 'file'));
const sha = (m: Manifest, rel: string): string | undefined => { const e = m[rel]; return e?.type === 'file' ? e.sha256 : undefined; };
const exitOf = async (p: Promise<unknown>): Promise<number> => {
  try { await p; } catch (error) { return exitCodeOf(error); }
  assert.fail('expected the guided flow to stop with an error');
};

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
  assert.equal(await exitOf(runCli([], undefined, fail.io)), 1);
  const empty = session('');
  assert.equal((await runCli([], undefined, empty.io)).exitCode, 0);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('guided: menu 1 → typed code really moves files (independent manifest), then `afo undo` without an ID restores them', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  // Quoted with a trailing space, as some terminals paste a dropped folder.
  const s = session(`'${dirs.work}' `, '1', approvalShown);
  const result = await runCli([], undefined, s.io);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(s.screen(), /폴더별로 정리할 수 있는 파일: 5개/u);
  assert.match(s.screen(), /직접 확인이 필요한 파일: 1개/u);
  assert.match(s.screen(), /같은 내용의 중복 파일: 1묶음/u);
  assert.match(s.screen(), /저장된 내 정리 규칙이 없어/u);
  assert.match(s.screen(), /1\) 폴더별로 정리하기\(되돌릴 수 있어요\) — 파일 5개/u);
  assert.match(result.output, /옮김 5 · 건너뜀 0 · 실패 0/u);
  assert.match(result.output, /되돌리려면: afo undo/u);

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
  assert.match(undo.screen(), /가장 최근에 정리한 기록을 되돌려요/u);
  assert.deepEqual(files(await manifest(dirs.work)), files(before), 'same paths, hashes and modification times as before');
  const again = await runCli(['undo'], undefined, session().io);
  assert.equal(again.exitCode, 0);
  assert.match(again.output, /되돌릴 수 있는 정리 기록이 없어요/u);
});

test('guided: a wrong or empty code stops with 4 and changes nothing; no approval is recorded', async (t) => {
  const { dirs, session } = await setup(t);
  const before = await manifest(dirs.work);
  const wrong = session(dirs.work, '1', '00000000');
  assert.equal(await exitOf(runCli([], undefined, wrong.io)), 4);
  const wrongTrash = session(dirs.work, '2', '00000000');
  assert.equal(await exitOf(runCli([], undefined, wrongTrash.io)), 4);
  assert.match(wrongTrash.screen(), /이 사본들을 휴지통으로 보낼게요\(1개, 남길 파일은 그대로\)/u);
  const empty = session(dirs.work, '1', '');
  assert.equal(await exitOf(runCli([], undefined, empty.io)), 4);
  assert.deepEqual(await manifest(dirs.work), before);
  assert.deepEqual(await readdir(path.join(dirs.state, 'approvals')).catch(() => []), [], 'no approval was issued');
  assert.deepEqual(await readdir(path.join(dirs.state, 'runs')).catch(() => []), [], 'nothing ran');
});

test('guided: menu items without work are shown as "할 일 없음" and cannot be chosen; 3) lists the classification', async (t) => {
  const { dirs, session } = await setup(t, { 'work/notes': 'no extension', 'work/문서/a.pdf': 'already placed', 'state/': '' });
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '1', '2', '3', '4');
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0);
  assert.match(s.screen(), /1\) 폴더별로 정리하기\(되돌릴 수 있어요\) — 할 일 없음/u);
  assert.match(s.screen(), /2\) 중복 파일을 휴지통으로 보내기 — 할 일 없음/u);
  assert.equal((s.screen().match(/그 작업은 할 일이 없어요/gu) ?? []).length, 2);
  assert.match(s.screen(), /\[확인 필요\] notes — /u);
  assert.match(s.screen(), /\[그대로\] 문서\/a\.pdf/u);
  assert.ok(!s.screen().includes('계속하려면 아래 코드를'), 'no code is offered');
  const stubborn = session(dirs.work, '1', '9', '1');
  assert.equal(await exitOf(runCli([], undefined, stubborn.io)), 2);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('guided: Ctrl+C at a question cancels with 130 and changes nothing; no TTY means help, never questions', async (t) => {
  const { dirs, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  let asked = 0;
  const abort = (q: string): Promise<string> => {
    asked += 1;
    if (q.includes('코드')) return Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    return Promise.resolve(q.includes('끌어다') ? dirs.work : '1');
  };
  assert.equal(await exitOf(runCli([], undefined, { stateDir: dirs.state, isTTY: true, warn: () => {}, ask: abort })), 130);
  assert.equal(asked, 3);
  assert.deepEqual(await manifest(dirs.work), before);

  const help = await runCli([], undefined, { stateDir: dirs.state, isTTY: false, warn: () => {},
    ask: () => assert.fail('no question without a TTY') });
  assert.equal(help.exitCode, 0);
  assert.match(help.output, /가장 쉬운 사용법: afo 를 입력하고 안내를 따르세요/u);
  const child = invoke([]);
  assert.equal(child.status, 0);
  assert.match(child.stdout, /가장 쉬운 사용법/u);
  assert.match(child.stdout, /세부 명령/u);
});

test('undo without an ID: no TTY needs --confirm of the latest undoable run (else 4); nothing to undo is 0', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const none = invoke(['undo']);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /되돌릴 수 있는 정리 기록이 없어요/u);
  const before = await manifest(dirs.work);
  assert.equal((await runCli([], undefined, session(dirs.work, '1', approvalShown).io)).exitCode, 0);
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
  const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AFO_STATE_DIR: dirs.state } });
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(String(r.stdout), /가장 쉬운 사용법/u);
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
  const s = session(dirs.work, '2', approvalShown);
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /휴지통으로 보냄 1 · 건너뜀 0 · 실패 0/u);
  const after = await manifest(dirs.work);
  const pair = [`${tag}.txt`, `${tag} copy.txt`];
  assert.equal(pair.filter((p) => after[p] !== undefined).length, 1, 'exactly one copy remains');
  for (const p of pair) if (after[p] !== undefined) assert.deepEqual(after[p], before[p], 'the keeper is unchanged');
  assert.deepEqual(after['other.pdf'], before['other.pdf'], 'organize was not chosen: other files stay');
  t.diagnostic(`trashed one synthetic ${tag} copy; this test never empties or reads the trash`);
});

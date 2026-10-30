import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { errorLine, exitCodeOf, runCli } from '../apps/cli/src/index.js';
import { loadProfile } from '../packages/filesystem/src/profiles.js';
import { createFixture, manifest } from './helpers.js';
import type { FixtureSpec, Manifest } from './helpers.js';

/*
 * Guided `afo` → 1) 폴더별로 정리하기 with files the default table does not know. Answers go in through runCli's io; file results are
 * checked with the independent manifest, never with CLI output. Synthetic mkdtemp folders and a temp AFO_STATE_DIR only.
 */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Answer = string | ((screen: string) => string);
const spec: FixtureSpec = {
  'work/a.pdf': 'pdf', 'work/data.xyz': 'x1', 'work/sub/more.xyz': 'x2', 'work/b.qqq': 'q', 'work/메모': 'memo',
  'work/movie.mp4.part': 'partial', 'state/': '',
};
const QUESTION = '번호를 입력하세요(그냥 Enter는 3): ';

async function setup(t: TestContext, files: FixtureSpec = spec) {
  const { root } = await createFixture(files, t);
  const dirs = { root, work: path.join(root, 'work'), state: path.join(root, 'state') };
  const session = (...answers: Answer[]) => {
    const lines: string[] = []; const questions: string[] = [];
    const io = { stateDir: dirs.state, isTTY: true, warn: (l: string) => { lines.push(l); },
      ask: (q: string) => {
        questions.push(q); lines.push(q);
        const a = answers.shift();
        if (a === undefined) return Promise.reject(new Error(`unexpected question: ${q}`));
        return Promise.resolve(typeof a === 'function' ? a(lines.join('\n')) : a);
      } };
    return { io, screen: () => lines.join('\n'), questions, left: () => answers.length };
  };
  const invoke = (args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, AFO_STATE_DIR: dirs.state }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  return { dirs, session, invoke };
}
const code = (screen: string): string => {
  const m = /계속하려면 아래 코드를 입력하세요: ([a-f0-9]{8})/u.exec(screen);
  assert.ok(m, 'the approval code is shown before asking');
  return m[1]!;
};
const undoCode = (screen: string): string => /계속하려면 아래 코드를 입력하세요: (\S{8})/u.exec(screen)![1]!;
const sha = (m: Manifest, rel: string): string | undefined => { const e = m[rel]; return e?.type === 'file' ? e.sha256 : undefined; };
/** Every file of `before` is at its expected new path (or unchanged when not listed) with the same content; nothing else appeared. */
function assertMoved(before: Manifest, after: Manifest, moves: Record<string, string>): void {
  const files = (m: Manifest) => Object.keys(m).filter((k) => m[k]!.type === 'file').sort();
  const expected = files(before).map((rel) => moves[rel] ?? rel).sort();
  assert.deepEqual(files(after), expected);
  for (const rel of files(before)) assert.equal(sha(after, moves[rel] ?? rel), sha(before, rel), rel);
}

test('guided unknown 1) all to 기타: one question, really moved (manifest), the unfinished download stays, afo undo restores', async (t) => {
  const { dirs, session } = await setup(t);
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '1', '1', code);
  const result = await runCli([], undefined, s.io);
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(s.left(), 0);
  const screen = s.screen();
  assert.match(screen, /1\) 폴더별로 정리하기\(되돌릴 수 있어요\) — 파일 1개\n {5}종류를 모르는 파일 4개는 어디로 옮길지 이어서 물어봐요\./u);
  assert.match(screen, /^종류를 모르는 파일이 있어요: \.xyz 2개\(예: data\.xyz\), \.qqq 1개\(예: b\.qqq\), 확장자 없음 1개\(예: 메모\)$/mu);
  assert.match(screen, /^ {2}1\) 모두 '기타' 폴더로 옮기기\n {2}2\) 확장자마다 폴더 정하기\n {2}3\) 그대로 두기\(기본\)$/mu);
  assert.match(screen, /^다운로드 중일 수 있는 파일 1개\(예: movie\.mp4\.part\)는 그대로 둬요\.$/mu);
  assert.match(screen, /직접 확인이 필요한 파일: 5개 — 종류를 모르는 확장자 3 · 다운로드 중일 수 있음 1 · 확장자 없음 1/u);
  assert.match(screen, /이렇게 정리할게요\(파일 5개, 덮어쓰지 않아요\):/u);
  assert.ok(!s.questions.some((q) => q.includes('다음에도')), '1) asks no "다음에도" question');
  assert.match(result.output, /옮김 5 · 건너뜀 0 · 실패 0/u);

  const moved = await manifest(dirs.work);
  assertMoved(before, moved, { 'a.pdf': '문서/a.pdf', 'data.xyz': '기타/data.xyz', 'sub/more.xyz': '기타/more.xyz', 'b.qqq': '기타/b.qqq',
    '메모': '기타/메모' });
  assert.deepEqual(moved['movie.mp4.part'], before['movie.mp4.part'], 'unfinished download untouched (same hash and mtime)');
  assert.equal(await loadProfile({ stateDir: dirs.state }), null, 'nothing saved');

  const undo = session(undoCode);
  assert.equal((await runCli(['undo'], undefined, undo.io)).exitCode, 0);
  assert.deepEqual(await manifest(dirs.work), before, 'every file and folder as before');
});

test('guided unknown 2) per extension: bad folder names asked again, "다음에도" saved for .xyz only, applied by a new process', async (t) => {
  const { dirs, session, invoke } = await setup(t);
  const before = await manifest(dirs.work);
  // .xyz: hidden, "..", then "데이터/" (trailing slash is fine) + save y; .qqq: Enter keeps it; 확장자 없음: 메모함 (no save question).
  const s = session(dirs.work, '1', '2', '.숨김', '../위로', '데이터/', 'y', '', '메모함', code);
  const result = await runCli([], undefined, s.io);
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(s.left(), 0, 'exactly the expected questions were asked');
  const asked = s.questions.filter((q) => q.includes('어느 폴더로'));
  assert.deepEqual(asked, [
    "'.xyz' 파일 2개를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): ",
    "'.xyz' 파일 2개를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): ",
    "'.xyz' 파일 2개를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): ",
    "'.qqq' 파일 1개를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): ",
    '확장자 없는 파일 1개를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): ']);
  assert.equal((s.screen().match(/그 이름은 폴더로 쓸 수 없어요/gu) ?? []).length, 2);
  assert.deepEqual(s.questions.filter((q) => q.includes('다음에도')), ["다음에도 '.xyz' 파일은 '데이터' 폴더로 정리할까요? (y/N): "],
    'no save question for no extension, nor for a kept extension');
  assert.match(s.screen(), /저장했어요: 다음에도 '\.xyz' 파일은 '데이터' 폴더로 정리해요\./u);

  assertMoved(before, await manifest(dirs.work), { 'a.pdf': '문서/a.pdf', 'data.xyz': '데이터/data.xyz', 'sub/more.xyz': '데이터/more.xyz',
    '메모': '메모함/메모' });

  // The saved correction is an extension match (keyword null), visible to `rules list`, and a new process applies it to a new file.
  const profile = await loadProfile({ stateDir: dirs.state });
  assert.ok(profile !== null && profile.status !== 'corrupt');
  assert.deepEqual(profile.corrections.map((c) => [c.match, c.targetDirectory]),
    [[{ type: 'keyword', extension: '.xyz', keyword: null }, '데이터']]);
  const fresh = path.join(dirs.root, 'fresh');
  await mkdir(fresh); await writeFile(path.join(fresh, '새 자료.XYZ'), 'n'); await writeFile(path.join(fresh, 'other.qqq'), 'o');
  await writeFile(path.join(fresh, '노트'), 'n2');
  const p = invoke(['preview', fresh, '--json']);
  assert.equal(p.status, 0, p.stderr);
  const items = (JSON.parse(p.stdout) as { preview: { items: { source: string; destination: string | null; reasonCode: string }[] } }).preview.items;
  assert.deepEqual(Object.fromEntries(items.map((i) => [i.source, [i.destination, i.reasonCode]])), {
    '새 자료.XYZ': ['데이터/새 자료.XYZ', 'SAVED_CORRECTION'], 'other.qqq': [null, 'UNKNOWN_EXTENSION'], '노트': [null, 'NO_EXTENSION'] });
  assert.match(invoke(['rules', 'list']).stdout, /\.xyz → 데이터/u);
});

test('guided unknown 3) / Enter keeps them: only known files move; three bad folder names keep that extension; nothing saved', async (t) => {
  const { dirs, session } = await setup(t);
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '1', '', code);
  assert.equal((await runCli([], undefined, s.io)).exitCode, 0);
  assert.match(s.screen(), /종류를 모르는 파일 4개는 그대로 둬요\./u);
  assert.deepEqual(s.questions.filter((q) => q.includes('어느 폴더로') || q.includes('다음에도')), []);
  assertMoved(before, await manifest(dirs.work), { 'a.pdf': '문서/a.pdf' });
  assert.equal(await loadProfile({ stateDir: dirs.state }), null);

  const other = await setup(t, { 'work/x.xyz': 'x', 'work/y.pdf': 'y', 'state/': '' });
  const start = await manifest(other.dirs.work);
  const stubborn = other.session(other.dirs.work, '1', '2', '/절대', 'a/../b', '.git', code);
  assert.equal((await runCli([], undefined, stubborn.io)).exitCode, 0);
  assert.match(stubborn.screen(), /'\.xyz' 파일 1개는 그대로 둘게요\./u);
  assert.ok(!stubborn.questions.some((q) => q.includes('다음에도')));
  assertMoved(start, await manifest(other.dirs.work), { 'y.pdf': '문서/y.pdf' });
});

test('guided unknown: a folder with only unknown files can choose 1); keeping them changes nothing; bad answers stop with 2', async (t) => {
  const { dirs, session } = await setup(t, { 'work/data.xyz': 'x', 'work/메모': 'm', 'state/': '' });
  const before = await manifest(dirs.work);
  const s = session(dirs.work, '1', '3');
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0);
  assert.match(s.screen(), /1\) 폴더별로 정리하기\(되돌릴 수 있어요\) — 종류를 모르는 파일 2개\(옮길 곳을 물어봐요\)/u);
  assert.equal(r.output, '옮길 파일이 없어요. 아무것도 바꾸지 않았어요.');
  assert.ok(!s.screen().includes('계속하려면 아래 코드를'));
  const bad = session(dirs.work, '1', '9', '8', '7');
  let stopped: { exit: number; line: string } | undefined;
  try { await runCli([], undefined, bad.io); } catch (error) { stopped = { exit: exitCodeOf(error), line: errorLine(error) }; }
  assert.deepEqual(stopped, { exit: 2, line: '번호를 알아듣지 못해 그만둘게요. 아무것도 바꾸지 않았어요.' });
  assert.equal(bad.questions.filter((q) => q === QUESTION).length, 3);
  assert.deepEqual(await manifest(dirs.work), before);
});

test('non-interactive plan is unchanged: unknown files stay review, the unfinished download is review with its own reason', async (t) => {
  const { dirs, invoke } = await setup(t);
  const r = invoke(['plan', dirs.work, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { plan: { operations: { source: string }[] }; reviewItems: { source: string; reason: string }[] };
  assert.deepEqual(out.plan.operations.map((o) => o.source), ['a.pdf']);
  assert.deepEqual(out.reviewItems.map((i) => i.source).sort(), ['b.qqq', 'data.xyz', 'movie.mp4.part', 'sub/more.xyz', '메모'].sort());
  assert.match(out.reviewItems.find((i) => i.source === 'movie.mp4.part')!.reason, /다운로드가 끝나지 않은 파일일 수 있어/u);
});

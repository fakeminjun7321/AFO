/*
 * Verifier: guided `afo` (no arguments on a TTY) and `afo undo` without a run ID, driven through a REAL pseudo-terminal.
 * The built CLI (node dist/apps/cli/src/index.js) runs as a child of a small Python pty driver (pty.fork): stdin/stdout/stderr
 * are a pty, Enter is "\r" and Ctrl+C is the byte 0x03 handled by the terminal line discipline / readline, as for a person.
 * File results come from an independent manifest written here (lstat without following links: type, size, mtime ns, sha256).
 * Product functions are not used as an oracle; expected destinations are written by hand.
 * Synthetic data only: each test makes its own mkdtemp(os.tmpdir()) base with a fake HOME and a temp AFO_STATE_DIR.
 * The real OS trash is used only with AFO_REAL_TRASH_TEST=1, for one synthetic `afo-test-` copy; the trash is never read or emptied.
 * Skipped with a reason on Windows (no POSIX pty) and when python3 with the pty module is unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileSnapshot } from '../packages/contracts/src/index.js';
import { findDuplicates, hasCopyMark, pathKey } from '../packages/engine/src/index.js';

const CLI = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const REAL_HOME = homedir();

function ptySkip(): string | false {
  if (process.platform === 'win32') return 'Windows에는 POSIX pty가 없어 실제 TTY 검증을 하지 않습니다(Windows: 미검증).';
  const probe = spawnSync('python3', ['-I', '-c', 'import os, pty, select; os.close(os.openpty()[0])'], { encoding: 'utf8', timeout: 10_000 });
  return probe.status === 0 ? false : 'python3(pty 모듈)이 없어 실제 TTY 검증을 건너뜁니다.';
}
const SKIP = ptySkip();
const realTrash = process.env['AFO_REAL_TRASH_TEST'] === '1' && process.platform === 'darwin';

// ---------- pty driver (Python, standard library only) ----------
// steps: wait for `expect` (regex on ANSI-stripped output, searched after the previous match), then type `send`.
// `{1}` in send is replaced by group 1 of the latest match that had groups (none of the current steps needs it).
const DRIVER = String.raw`import json, os, pty, re, select, sys, time
spec = json.load(open(sys.argv[1], encoding='utf-8'))
ansi = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>]')
def clean(b):
    return ansi.sub('', b.decode('utf-8', 'replace')).replace('\r', '')
pid, fd = pty.fork()
if pid == 0:
    try:
        if spec.get('stdout_file'):
            f = os.open(spec['stdout_file'], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.dup2(f, 1); os.close(f)
        os.chdir(spec['cwd']); os.execve(spec['argv'][0], spec['argv'], spec['env'])
    finally:
        os._exit(127)
buf = b''; pos = 0; eof = False; failed = None; sent = []; groups = ()
deadline = time.time() + spec.get('timeout', 60)
def pump(wait):
    global buf, eof
    r, _, _ = select.select([fd], [], [], wait)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            d = b''
        if not d: eof = True
        buf += d
for i, step in enumerate(spec['steps']):
    rx = re.compile(step['expect'])
    while True:
        m = rx.search(clean(buf), pos)
        if m or eof or time.time() > deadline: break
        pump(0.1)
    if not m:
        failed = {'step': i, 'expect': step['expect']}; break
    pos = m.end()
    if m.groups(): groups = m.groups()
    if 'send' in step:
        time.sleep(0.15)
        text = step['send']
        for g, v in enumerate(groups, 1): text = text.replace('{%d}' % g, v or '')
        sent.append(text)
        os.write(fd, text.encode('utf-8'))
while not eof and time.time() < deadline: pump(0.2)
timed_out = not eof
if timed_out:
    try: os.kill(pid, 9)
    except OSError: pass
_, status = os.waitpid(pid, 0)
print(json.dumps({'exit': os.waitstatus_to_exitcode(status), 'timedOut': timed_out, 'failed': failed, 'sent': sent,
                  'transcript': clean(buf)}, ensure_ascii=False))
`;

// ---------- independent manifest ----------
interface Entry { type: 'file' | 'dir' | 'symlink' | 'other'; size: string; mtimeNs: string; sha256: string | null; target?: string }
type Snap = Record<string, Entry>;
async function snap(root: string): Promise<Snap> {
  const out: Snap = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const abs = path.join(dir, name); const key = rel ? `${rel}/${name}` : name;
      const st = await lstat(abs, { bigint: true });
      const type = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'other';
      out[key] = { type, size: type === 'file' ? String(st.size) : '', mtimeNs: type === 'dir' ? '' : String(st.mtimeNs),
        sha256: type === 'file' ? createHash('sha256').update(await readFile(abs)).digest('hex') : null,
        ...(type === 'symlink' ? { target: await readlink(abs) } : {}) };
      if (type === 'dir') await walk(abs, key);
    }
  };
  await walk(root, '');
  return out;
}
const filesOf = (s: Snap): Snap => Object.fromEntries(Object.entries(s).filter(([, e]) => e.type !== 'dir'));
const exists = async (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
/** State folder parts that only an approval or a run may create. */
async function writesOf(state: string): Promise<string[]> {
  const found: string[] = [];
  for (const d of ['approvals', 'runs', 'journal']) if (await exists(path.join(state, d))) for (const f of await readdir(path.join(state, d))) found.push(`${d}/${f}`);
  return found;
}

// ---------- fixture and runners ----------
const WORK_NAME = '내 과제 📁 2026';
type Spec = Record<string, string>;
interface Step { expect: string; send?: string }
interface PtyResult { exit: number; timedOut: boolean; failed: { step: number; expect: string } | null; sent: string[]; transcript: string; stdout: string }

async function setup(t: TestContext, spec: Spec) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'afo-verify-guided-')));
  const rel = path.relative(REAL_HOME, base);
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), 'synthetic base must not be inside the real home');
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); const state = path.join(base, 'state'); const work = path.join(home, WORK_NAME);
  await mkdir(work, { recursive: true }); await mkdir(state);
  for (const [p, content] of Object.entries(spec)) {
    const abs = path.join(work, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const driver = path.join(base, 'ptydrive.py');
  await writeFile(driver, DRIVER);
  const env: Record<string, string> = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, AFO_STATE_DIR: state,
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TMPDIR: tmpdir(), TZ: 'Asia/Seoul' };
  let n = 0;
  /** One interactive session in a real pty. argv defaults to `node <cli>`; extra are the CLI arguments. */
  const pty = async (steps: Step[], extra: string[] = [], argv: string[] = [process.execPath, CLI]): Promise<PtyResult> => {
    n += 1;
    const specFile = path.join(base, `spec-${n}.json`); const stdoutFile = path.join(base, `stdout-${n}.txt`);
    await writeFile(specFile, JSON.stringify({ argv: [...argv, ...extra], env, cwd: base, steps, timeout: 60, stdout_file: stdoutFile }));
    const r = spawnSync('python3', ['-I', driver, specFile], { encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, `pty driver failed: ${String(r.stderr)}`);
    const parsed = JSON.parse(String(r.stdout)) as Omit<PtyResult, 'stdout'>;
    const stdout = await readFile(stdoutFile, 'utf8').catch(() => '');
    assert.equal(parsed.timedOut, false, `session timed out:\n${parsed.transcript}`);
    assert.equal(parsed.failed, null, `expected text not shown (${JSON.stringify(parsed.failed)}):\n${parsed.transcript}`);
    return { ...parsed, stdout };
  };
  /** Non-TTY child process (stdin ignored), same env. */
  const plain = (args: string[], cmd: string[] = [process.execPath, CLI]) => {
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), ...args], { encoding: 'utf8', timeout: 60_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  return { base, home, state, work, env, pty, plain };
}

// Prompts as shown on screen.
const FOLDER = '끌어다 놓고 Enter를 누르세요\\(경로를 붙여 넣어도 돼요, 그냥 Enter는 종료\\): ';
const MENU = '번호를 입력하세요: ';
// The guided confirmations are yes/no now (the approval is still issued internally with the plan's code): organize defaults to yes,
// the trash to no; `afo undo` in a terminal asks yes/no too. No code is shown or typed on these screens.
const ORGANIZE = '이대로 정리할까요\\? 나중에 afo undo로 되돌릴 수 있어요\\. \\(Y/n\\): ';
const TRASH = '이 사본 \\d+개를 휴지통으로 보낼까요\\? afo undo로는 되돌리지 않아요\\. \\(y/N\\): ';
const UNDO = '되돌릴까요\\? \\(Y/n\\): ';
/** The folder question once a guided run has executed in this state folder (the remembered folder is offered with Enter). */
const LAST = '끌어다 놓고 Enter를 누르세요\\(그냥 Enter는 지난번 폴더, q는 종료\\): ';
const UNCLEAR = '답을 알아듣지 못해 그만둘게요\\. 아무것도 바꾸지 않았어요\\.';
const ENTER = '\r'; const CTRL_C = '\x03';
// default-3: after menu 1 the unknown 'notes' (no extension) is asked about; Enter keeps it where it is.
const KEEP_UNKNOWN: Step = { expect: '번호를 입력하세요\\(그냥 Enter는 3\\): ', send: ENTER };

const BASE: Spec = { 'a.pdf': 'pdf-a', 'b.jpg': 'jpg-b', 'clip.mp4': 'video', 'notes': 'no extension', 'c.txt': 'same-text', 'c copy.txt': 'same-text' };
// Default rules written out by hand: where each file must be after "1) 폴더별로 정리하기".
const MOVES: Record<string, string> = { 'a.pdf': '문서/a.pdf', 'b.jpg': '이미지/b.jpg', 'clip.mp4': '영상/clip.mp4', 'c.txt': '문서/c.txt', 'c copy.txt': '문서/c copy.txt' };

async function newPlanRoot(state: string, seen: Set<string>): Promise<string> {
  const plans = (await readdir(path.join(state, 'plans'))).filter((f) => /^[0-9a-f]{64}\.json$/u.test(f) && !seen.has(f));
  assert.equal(plans.length, 1, 'exactly one new plan was saved');
  seen.add(plans[0]!);
  return (JSON.parse(await readFile(path.join(state, 'plans', plans[0]!), 'utf8')) as { plan: { rootPath: string } }).plan.rootPath;
}

test('pty: five dragged-folder spellings (quotes, "\\ " + trailing space, ~/ with a fake HOME, raw Korean/space/emoji) open the same folder', { skip: SKIP }, async (t) => {
  const { home, state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  const escaped = work.replace(/([ ()'"&])/gu, '\\$1');
  const inputs = { singleQuoted: `'${work}'`, doubleQuotedTrailingSpace: `"${work}"  `, backslashTrailingSpace: `${escaped} `,
    tildeFakeHome: `~/${WORK_NAME.replace(/ /gu, '\\ ')}`, rawWithSpaces: `  ${work}` };
  assert.ok(work.startsWith(home));
  const seen = new Set<string>();
  for (const [label, typed] of Object.entries(inputs)) {
    const r = await pty([{ expect: FOLDER, send: typed + ENTER }, { expect: '파일 6개를 살펴봤어요\\. \\(아직 아무것도 바꾸지 않았어요\\)' },
      { expect: MENU, send: `1${ENTER}` }, KEEP_UNKNOWN, { expect: ORGANIZE, send: `n${ENTER}` }]);
    assert.equal(r.exit, 4, `${label}: "n" refuses with 4\n${r.transcript}`);
    assert.ok(!r.transcript.includes('이 폴더는 정리할 수 없어요'), `${label}: accepted at once`);
    assert.equal((await newPlanRoot(state, seen)).normalize('NFC'), work.normalize('NFC'), `${label}: plan bound to the same real folder`);
  }
  assert.deepEqual(await snap(work), before, 'no file changed');
  assert.deepEqual(await writesOf(state), [], 'no approval, run or journal written');
});

test('pty: missing folder, the (fake) home itself and a file path are explained and asked again; 3 failures exit 1 with no change', { skip: SKIP }, async (t) => {
  const { state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  const r = await pty([
    { expect: FOLDER, send: `${path.join(work, '없는 폴더')}${ENTER}` }, { expect: '이 폴더는 정리할 수 없어요: 선택한 폴더를 찾거나 읽을 수 없어요' },
    { expect: FOLDER, send: `~${ENTER}` }, { expect: '이 폴더는 정리할 수 없어요: 홈 전체' },
    { expect: FOLDER, send: `'${path.join(work, 'a.pdf')}'${ENTER}` }, { expect: '이 폴더는 정리할 수 없어요: 일반 폴더를 직접 선택해야 해요' },
    { expect: '폴더를 3번 열지 못해 그만둘게요\\. 아무것도 바꾸지 않았어요\\.' }]);
  assert.equal(r.exit, 1, r.transcript);
  assert.equal((r.transcript.match(/끌어다 놓고/gu) ?? []).length, 3, 'asked exactly three times');
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await readdir(state), [], 'state folder untouched');
});

test('pty: "n", trash Enter and three unclear answers (menu 1 and 2) run nothing: exit 4/2, files, approvals/ and runs/ unchanged', { skip: SKIP }, async (t) => {
  // Was "wrong code and empty code": the typed code became a yes/no; the same refusals with the same oracles.
  const { state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  const cases: [string, string[], number, RegExp][] = [
    ['1', ['n'], 4, /정리하지 않았어요\. 아무것도 바꾸지 않았어요\./u],
    ['1', ['아니요'], 4, /정리하지 않았어요\. 아무것도 바꾸지 않았어요\./u],
    ['2', ['n'], 4, /휴지통으로 보내지 않았어요\. 아무것도 바꾸지 않았어요\./u],
    ['2', [''], 4, /휴지통으로 보내지 않았어요\. 아무것도 바꾸지 않았어요\./u],   // Enter is "no" for the trash
    ['1', ['00000000', 'abcdefgh-x', 'ffffffff'], 2, new RegExp(UNCLEAR, 'u')],
    ['2', ['ffffffff', 'yess', '?'], 2, new RegExp(UNCLEAR, 'u')],
  ];
  for (const [menu, answers, exit, message] of cases) {
    const question = menu === '1' ? ORGANIZE : TRASH;
    const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: menu + ENTER }, ...(menu === '1' ? [KEEP_UNKNOWN] : []),
      ...answers.map((a) => ({ expect: question, send: a + ENTER })), { expect: message.source }]);
    assert.equal(r.exit, exit, `menu ${menu} answers ${JSON.stringify(answers)}\n${r.transcript}`);
    assert.match(r.transcript, message);
    assert.ok(!r.transcript.includes('계속하려면 아래 코드를'), 'no code is shown');
    assert.equal(r.stdout, '', 'nothing on stdout when nothing ran');
    assert.deepEqual(await snap(work), before);
    assert.deepEqual(await writesOf(state), []);
  }
  assert.ok(!await exists(path.join(state, 'guided.json')), 'a refused run is not remembered as the last folder');
});

test('pty: menu 1 + y really moves files; a new `afo undo` process (Ctrl+C, n, unclear answers, then y) restores the manifest', { skip: SKIP }, async (t) => {
  const { state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work.replace(/ /gu, '\\ ')} ${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, KEEP_UNKNOWN,
    { expect: '이렇게 정리할게요\\(파일 5개, 덮어쓰지 않아요\\):' }, { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  // Result goes to stdout; questions and screens do not.
  assert.match(r.stdout, /정리를 마쳤어요\.\n {2}옮김 5 · 건너뜀 0 · 실패 0\n되돌리려면: afo undo\n/u);
  assert.match(r.stdout, /\n다음에도 afo만 입력하고 Enter를 누르면 이 폴더를 같은 방식으로 정리해요\.\n정리 기록은 afo runs로 볼 수 있어요\.\n?$/u);
  assert.ok(!r.stdout.includes('실행 ID'), 'no run ID in the result');
  assert.ok(!r.stdout.includes('번호를 입력하세요') && !r.stdout.includes('끌어다'), 'questions are not on stdout');
  const moved = await snap(work);
  for (const [source, destination] of Object.entries(MOVES)) {
    assert.equal(moved[source], undefined, `${source} left its original path`);
    assert.equal(moved[destination]?.sha256, before[source]!.sha256, `${destination} has the content of ${source}`);
    assert.equal(moved[destination]?.mtimeNs, before[source]!.mtimeNs, `${destination} keeps the modification time`);
  }
  assert.deepEqual(moved['notes'], before['notes'], 'the review file is untouched');
  assert.equal(Object.keys(filesOf(moved)).length, Object.keys(filesOf(before)).length, 'no file added or lost');
  assert.equal((await readdir(path.join(state, 'runs'))).length > 0, true);

  const cancelled = await pty([{ expect: '정리한 파일 5개를 원래 자리로 되돌릴까요\\?' }, { expect: UNDO, send: CTRL_C }], ['undo']);
  assert.equal(cancelled.exit, 130, cancelled.transcript);
  assert.deepEqual(await snap(work), moved, 'Ctrl+C at the undo question changes nothing');

  const runRecords = await snap(path.join(state, 'runs'));
  const wrong = await pty([{ expect: UNDO, send: `n${ENTER}` }, { expect: '되돌리지 않았어요\\. 아무것도 바꾸지 않았어요\\.' }], ['undo']);
  assert.equal(wrong.exit, 4, wrong.transcript);
  assert.ok(!wrong.transcript.includes('계속하려면 아래 코드를'), 'no code on the undo screen');
  const unclear = await pty([{ expect: UNDO, send: `00000000${ENTER}` }, { expect: UNDO, send: `x${ENTER}` }, { expect: UNDO, send: `q${ENTER}` },
    { expect: UNCLEAR }], ['undo']);
  assert.equal(unclear.exit, 2, unclear.transcript);
  assert.deepEqual(await snap(work), moved);
  assert.deepEqual(await snap(path.join(state, 'runs')), runRecords, 'n / unclear answers write no run record');

  const undo = await pty([{ expect: UNDO, send: `y${ENTER}` }], ['undo']);
  assert.equal(undo.exit, 0, undo.transcript);
  const after = await snap(work);
  assert.deepEqual(filesOf(after), filesOf(before), 'same paths, sha256 and mtime as before');
  assert.deepEqual(after, before, 'files and folders as before: the empty folders the run created are removed (1cde928)');

  const again = await pty([], ['undo']);
  assert.equal(again.exit, 0);
  assert.match(again.stdout, /되돌릴 수 있는 정리 기록이 없어요\. 아무것도 바꾸지 않았어요\./u);
});

test('pty: menu 4, empty menu answer and empty first answer quit with 0; Ctrl+C at each question exits 130; no change', { skip: SKIP }, async (t) => {
  const { state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  const quits: [string, Step[]][] = [
    ['empty first answer', [{ expect: FOLDER, send: ENTER }]],
    ['menu 4', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `4${ENTER}` }]],
    ['empty menu answer', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: ENTER }]],
  ];
  for (const [label, steps] of quits) {
    const r = await pty(steps);
    assert.equal(r.exit, 0, `${label}\n${r.transcript}`);
    assert.match(r.stdout, /그만뒀어요\. 아무것도 바꾸지 않았어요\./u, label);
  }
  const cancels: [string, Step[]][] = [
    ['folder question', [{ expect: FOLDER, send: CTRL_C }]],
    ['folder question after typing', [{ expect: FOLDER, send: `${work}${CTRL_C}` }]],
    ['menu question', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: CTRL_C }]],
    ['menu after 3)', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: CTRL_C }]],
    ['yes/no question (organize)', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, KEEP_UNKNOWN, { expect: ORGANIZE, send: CTRL_C }]],
    ['yes/no question (trash)', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` }, { expect: TRASH, send: CTRL_C }]],
  ];
  for (const [label, steps] of cancels) {
    const r = await pty(steps);
    assert.equal(r.exit, 130, `${label}\n${r.transcript}`);
    assert.match(r.transcript, /그만뒀어요\(Ctrl\+C\)\. 아무것도 (바꾸지|되돌리지) 않았어요\./u, label);
    assert.deepEqual(await snap(work), before, label);
    assert.deepEqual(await writesOf(state), [], label);
  }
});

test('pty: menu items without work show "할 일 없음" and cannot be chosen; three unknown answers exit 2', { skip: SKIP }, async (t) => {
  // No duplicates: 2 is not selectable, 1 is.
  const noDup = await setup(t, { 'a.pdf': 'one', 'b.jpg': 'two' });
  const r1 = await noDup.pty([{ expect: FOLDER, send: `${noDup.work}${ENTER}` },
    { expect: '1\\) 폴더별로 정리하기\\(되돌릴 수 있어요\\) — 파일 2개\\n {2}2\\) 중복 파일을 휴지통으로 보내기 — 할 일 없음' },
    { expect: MENU, send: `2${ENTER}` }, { expect: '그 작업은 할 일이 없어요\\. 다른 번호를 골라 주세요\\.' }, { expect: MENU, send: `4${ENTER}` }]);
  assert.equal(r1.exit, 0, r1.transcript);
  assert.ok(!r1.transcript.includes('계속하려면 아래 코드를') && !r1.transcript.includes('이대로 정리할까요'));
  assert.match(r1.transcript, /같은 내용의 중복 파일: 0묶음/u);

  // Nothing to organize (already placed + needs review) and no duplicates: neither 1 nor 2 can be chosen.
  const idle = await setup(t, { 'notes.pdf.exe': 'compound extension', '문서/a.pdf': 'already placed' });
  const before = await snap(idle.work);
  const r2 = await idle.pty([{ expect: FOLDER, send: `${idle.work}${ENTER}` },
    { expect: '1\\) 폴더별로 정리하기\\(되돌릴 수 있어요\\) — 할 일 없음\\n {2}2\\) 중복 파일을 휴지통으로 보내기 — 할 일 없음' },
    { expect: MENU, send: `1${ENTER}` }, { expect: '그 작업은 할 일이 없어요' }, { expect: MENU, send: `2${ENTER}` },
    { expect: '그 작업은 할 일이 없어요' }, { expect: MENU, send: `4${ENTER}` }]);
  assert.equal(r2.exit, 0, r2.transcript);
  const r3 = await idle.pty([{ expect: FOLDER, send: `${idle.work}${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, { expect: MENU, send: `9${ENTER}` },
    { expect: MENU, send: `1${ENTER}` }, { expect: '번호를 알아듣지 못해 그만둘게요\\. 아무것도 바꾸지 않았어요\\.' }]);
  assert.equal(r3.exit, 2, r3.transcript);
  assert.ok(!r3.transcript.includes('계속하려면 아래 코드를') && !r3.transcript.includes('이대로 정리할까요'));
  assert.match(r3.transcript, /1~5 중에서 골라 주세요\./u);
  assert.deepEqual(await snap(idle.work), before);
  assert.deepEqual(await writesOf(idle.state), []);
});

const REFERENCE: Spec = { '정리함/과제/물리/물리_1.pdf': 'r1', '정리함/과제/물리/물리_2.pdf': 'r2', '정리함/과제/수학/수학_1.pdf': 'r3',
  '정리함/과제/수학/수학_2.pdf': 'r4', '정리함/메모장.txt': 'r5' };
const REF_FILES = Object.keys(REFERENCE);

/** suggest-rules on the reference folder, then rules save of the physics rule only (non-TTY commands, same temp state). */
function savePhysicsRule(plain: (args: string[]) => { status: number | null; stdout: string; stderr: string }, reference: string, draftFile: string): Promise<void> {
  const suggested = plain(['suggest-rules', reference, '--json']);
  assert.equal(suggested.status, 0, suggested.stderr);
  const draft = JSON.parse(suggested.stdout) as { rules: { id: string; targetDirectory: string }[] };
  const physics = draft.rules.find((r) => r.targetDirectory === '과제/물리');
  assert.ok(physics, suggested.stdout);
  return writeFile(draftFile, suggested.stdout).then(() => {
    const saved = plain(['rules', 'save', draftFile, '--select', physics.id]);
    assert.equal(saved.status, 0, saved.stderr);
  });
}

test('pty: saved personal rules — none/applied/disabled are stated; reference files are kept; new files follow the confirmed rule', { skip: SKIP }, async (t) => {
  // The reference folder (정리함) sits inside the work folder: its files are reference files and must never move.
  const { state, work, pty, plain } = await setup(t, { ...REFERENCE, '물리_새보고서.pdf': 'w1', '수학_숙제.pdf': 'w2' });
  const none = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `4${ENTER}` }]);
  assert.match(none.transcript, /저장된 내 정리 규칙이 없어 기본 분류\(문서·이미지·영상 등\)를 썼어요\./u);

  await savePhysicsRule(plain, path.join(work, '정리함'), path.join(path.dirname(state), 'draft.json'));
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: '저장된 내 정리 규칙을 적용했어요\\.' },
    { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, { expect: ORGANIZE, send: ENTER }]);   // Enter = yes (organize)
  assert.equal(r.exit, 0, r.transcript);
  assert.match(r.transcript, /폴더별로 정리할 수 있는 파일: 2개 — 정리하면 이렇게 돼요:/u);
  assert.match(r.stdout, /저장한 내 정리 규칙도 계속 적용돼요\./u);
  assert.match(r.transcript, /그대로 둘 파일: 5개/u);
  assert.match(r.transcript, /\[정리\] 물리_새보고서\.pdf → 과제\/물리\/물리_새보고서\.pdf/u, 'confirmed rule applied');
  assert.match(r.transcript, /\[정리\] 수학_숙제\.pdf → 문서\/수학_숙제\.pdf/u, 'unconfirmed math rule not applied');
  for (const p of REF_FILES) assert.match(r.transcript, new RegExp(`\\[그대로\\] ${p.replace(/[.]/gu, '\\.')}`, 'u'));
  const after = await snap(work);
  for (const p of REF_FILES) assert.deepEqual(after[p], before[p], `reference file ${p} unchanged`);
  assert.equal(after['과제/물리/물리_새보고서.pdf']?.sha256, before['물리_새보고서.pdf']!.sha256);
  assert.equal(after['문서/수학_숙제.pdf']?.sha256, before['수학_숙제.pdf']!.sha256);
  assert.equal(after['물리_새보고서.pdf'], undefined);

  assert.equal(plain(['rules', 'disable-all']).status, 0);
  // After a guided run the folder is remembered: the question offers it, and Enter takes it.
  const off = await pty([{ expect: `지난번에 정리한 폴더: ${work.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n` }, { expect: LAST, send: ENTER },
    { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `4${ENTER}` }]);
  assert.equal(off.exit, 0, off.transcript);
  assert.match(off.transcript, /내 정리 규칙이 꺼져 있어 기본 분류를 썼어요\./u);
  // Rules off: the moved file would now go to 문서/ by default, but reference files stay protected.
  assert.match(off.transcript, /\[정리\] 과제\/물리\/물리_새보고서\.pdf → 문서\/물리_새보고서\.pdf/u);
  for (const p of REF_FILES) assert.match(off.transcript, new RegExp(`\\[그대로\\] ${p.replace(/[.]/gu, '\\.')}`, 'u'), `${p} still protected`);
  assert.deepEqual(await snap(work), after, 'quitting changed nothing');
});

// D1 (fixed): with the reference folder = the work folder, every file (also ones added after saving the rule) is kept as a reference
// file; the summary and 3) now name that reason ("참고 폴더 보호").
test('pty: the guided summary says when files are kept because they are reference files', { skip: SKIP }, async (t) => {
  const { state, work, pty, plain } = await setup(t, { '과제/물리/물리_1.pdf': 'r1', '과제/물리/물리_2.pdf': 'r2', '과제/수학/수학_1.pdf': 'r3' });
  await savePhysicsRule(plain, work, path.join(path.dirname(state), 'draft.json'));
  await writeFile(path.join(work, '물리_새보고서.pdf'), 'w1');
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `4${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.deepEqual(await snap(work), before);
  assert.match(r.transcript, /그대로 둘 파일: 4개/u, 'observed: the new file is kept too (whole reference folder protected)');
  assert.match(r.transcript, /그대로 둘 파일: 4개 — 참고 폴더 보호 4\n/u, 'the summary names reference protection as the reason');
  assert.match(r.transcript, /\[그대로\] 물리_새보고서\.pdf — 참고 폴더 보호/u, '3) gives the reason per file');
});

test('pty: honest wording — "아직 아무것도 바꾸지 않았어요" before running, no permanent delete in the menu, trash is not shown as freed space', { skip: SKIP }, async (t) => {
  const { work, pty } = await setup(t, BASE);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `2${ENTER}` },
    { expect: TRASH, send: ENTER }]);
  assert.equal(r.exit, 4, 'Enter is "no" for the trash');
  assert.match(r.transcript, /파일 6개를 살펴봤어요\. \(아직 아무것도 바꾸지 않았어요\)/u);
  assert.match(r.transcript, /자세히 보기 — 분류 결과\(아직 아무것도 바꾸지 않았어요\):/u);
  assert.match(r.transcript, /이 사본들을 휴지통으로 보낼게요\(1개, 남길 파일은 그대로\):\n {2}c copy\.txt \(같은 내용의 'c\.txt' 파일은 남겨요\)/u);
  assert.match(r.transcript, /AFO 파일 정리 도우미예요\. 파일을 옮기기 전에 무엇을 할지 보여 주고 꼭 물어봐요\. \(Ctrl\+C로 언제든 그만둘 수 있어요\)/u);
  assert.match(r.transcript, /이 사본 1개를 휴지통으로 보낼까요\? afo undo로는 되돌리지 않아요\. \(y\/N\): /u);
  assert.match(r.transcript, /휴지통으로 보내지 않았어요\. 아무것도 바꾸지 않았어요\./u);
  for (const banned of ['영구', '확보', '공간', ' B ', 'bytes']) assert.ok(!r.transcript.includes(banned), `no '${banned}' in the guided screens`);
});

test('pty: real symlink to the entry point (as npm link installs it) runs directly — help without a TTY, guided with a TTY', { skip: SKIP }, async (t) => {
  const { base, work, pty, plain } = await setup(t, BASE);
  const link = path.join(base, 'bin', 'afo');
  await mkdir(path.dirname(link));
  await symlink(CLI, link);
  await chmod(link, 0o755); // follows the link: the built entry file becomes executable, as npm link does
  assert.match((await readFile(CLI, 'utf8')).split('\n')[0]!, /^#!\/usr\/bin\/env node$/u, 'shebang');
  const help = plain(['help'], [link]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /afo {2,}안내를 따라 폴더 정리하기/u);
  const noArgs = plain([], [link]);
  assert.equal(noArgs.status, 0);
  assert.match(noArgs.stdout, /자주 쓰는 명령/u, 'no TTY and no arguments: help, never questions');
  assert.ok(!noArgs.stderr.includes('끌어다'));
  const before = await snap(work);
  const r = await pty([{ expect: 'AFO 파일 정리 도우미예요' }, { expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `4${ENTER}` }], [], [link]);
  assert.equal(r.exit, 0, r.transcript);
  assert.deepEqual(await snap(work), before);
});

test('pty: `afo <폴더>` opens that folder at once (no folder question), organizes on Enter (default yes); a pipe gets the preview', { skip: SKIP }, async (t) => {
  const { state, work, pty, plain } = await setup(t, BASE);
  const before = await snap(work);
  const piped = plain([work]);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stdout, plain(['preview', work]).stdout, 'no TTY: the same output as preview');
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await writesOf(state), []);
  const r = await pty([{ expect: '파일 6개를 살펴봤어요' }, { expect: MENU, send: `1${ENTER}` }, KEEP_UNKNOWN, { expect: ORGANIZE, send: ENTER }], [work]);
  assert.equal(r.exit, 0, r.transcript);
  assert.ok(!r.transcript.includes('끌어다 놓고'), 'no folder question');
  const moved = await snap(work);
  for (const [source, destination] of Object.entries(MOVES)) {
    assert.equal(moved[source], undefined, `${source} left its original path`);
    assert.equal(moved[destination]?.sha256, before[source]!.sha256, `${destination} has the content of ${source}`);
  }
  assert.deepEqual(moved['notes'], before['notes']);
});

test('pty: menu 2 sends one synthetic afo-test- copy to the real OS trash and keeps the keeper (AFO_REAL_TRASH_TEST=1, macOS)', {
  skip: SKIP || (realTrash ? false : 'AFO_REAL_TRASH_TEST=1(macOS)일 때만 합성 사본 1개를 실제 휴지통으로 보냅니다.'),
}, async (t) => {
  const tag = `afo-test-guided-pty-${process.pid}-${Date.now()}`;
  const { work, pty } = await setup(t, { [`${tag}.txt`]: `dup ${tag}`, [`${tag} copy.txt`]: `dup ${tag}`, 'other.pdf': 'unrelated' });
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` },
    { expect: '이 사본들을 휴지통으로 보낼게요\\(1개, 남길 파일은 그대로\\):' }, { expect: TRASH, send: `y${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.match(r.stdout, /휴지통 보내기를 마쳤어요\.\n {2}휴지통으로 보냄 1 · 건너뜀 0 · 실패 0/u);
  assert.match(r.stdout, /afo undo로는 되돌리지 않아요/u);
  assert.ok(!/확보|공간/u.test(r.transcript), 'trash is not reported as freed space');
  const after = await snap(work);
  const pair = [`${tag}.txt`, `${tag} copy.txt`];
  assert.equal(pair.filter((p) => after[p] !== undefined).length, 1, 'exactly one copy remains');
  for (const p of pair) if (after[p] !== undefined) assert.deepEqual(after[p], before[p], 'keeper unchanged');
  assert.deepEqual(after['other.pdf'], before['other.pdf']);
  t.diagnostic(`trashed one synthetic ${tag} copy; the trash is never read or emptied`);
});

// =====================================================================================================================
// Re-verification of b1ae8ff (1cde928 + b1ae8ff): keeper rule, undo removing only the empty folders the run created, wording.
// =====================================================================================================================

// ---------- R-K: default keeper of a duplicate group (engine is the system under test; expectations written by hand) ----------
const HASH = 'b'.repeat(64);
const fileSnap = (relativePath: string, i: number): FileSnapshot => ({ id: (i + 1).toString(16).padStart(64, '0'), relativePath, size: 7,
  modifiedNs: '1', device: '1', inode: String(100 + i), sha256: HASH });
function keeperOf(paths: string[], protectedPaths: string[] = []): { keep: string; candidates: string[] } {
  const { duplicates } = findDuplicates(paths.map(fileSnap), new Set(protectedPaths.map(pathKey)));
  assert.equal(duplicates.length, 1, paths.join(' | '));
  return { keep: duplicates[0]!.suggestedKeep, candidates: [...duplicates[0]!.candidates].sort() };
}
function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i]!, ...rest];
}
// [group, expected keeper, protected paths] — written by hand from the stated order: protected → no copy mark → shallower → shorter → path.
const KEEPER_TABLE: [string[], string, string[]?][] = [
  [['보고서 (1).pdf', '보고서.pdf'], '보고서.pdf'],
  [['보고서 - Copy.pdf', '보고서.pdf', '보고서 - Copy (2).pdf'], '보고서.pdf'],                // Windows (English)
  [['보고서 - 복사본 (2).pdf', '보고서 - 복사본.pdf', '보고서.pdf'], '보고서.pdf'],              // Windows (Korean)
  [['사진 복사본 2.jpg', '사진 복사본.jpg', '사진.jpg'], '사진.jpg'],                            // Finder (Korean)
  [['photo copy 2.jpg', 'photo copy.jpg', 'photo.jpg'], 'photo.jpg'],                          // Finder (English)
  [['archive (1).tar.gz', 'archive.tar.gz'], 'archive.tar.gz'],
  [['v1.2 (1).pdf', 'v1.2.pdf'], 'v1.2.pdf'],
  [['copy.txt', 'copy (1).txt'], 'copy.txt'],                                                 // looks like a mark, is the base name
  [['사본.txt', '사본 (1).txt'], '사본.txt'],
  [['(1)보고서 (1).pdf', '(1)보고서.pdf'], '(1)보고서.pdf'],                                     // "(1)" at the start is not a mark
  [['a (1).pdf', 'a (2).pdf'], 'a (1).pdf'],                                                  // both marked: same depth/length → path order
  [['깊은/곳/원본.pdf', '원본 (1).pdf'], '깊은/곳/원본.pdf'],                                    // no mark beats shallower
  [['x/y/z.pdf', 'z.pdf', 'x/z.pdf'], 'z.pdf'],                                               // shallower
  [['최종보고서.pdf', '보고서.pdf'], '보고서.pdf'],                                              // shorter name
  [['b.pdf', 'a.pdf'], 'a.pdf'],                                                              // path order
  [['보고서.pdf', '참고/보고서 (1).pdf'], '참고/보고서 (1).pdf', ['참고/보고서 (1).pdf']],          // protected first, even with a mark
  [['보고서.pdf', '사진 사본.pdf'.normalize('NFD')], '보고서.pdf'],                              // NFD mark is still a mark
];

test('R-K1 keeper table (hand-written): no copy mark > shallower > shorter > path order; protected first; any input order', () => {
  for (const [group, keep, prot = []] of KEEPER_TABLE) {
    const expected = { keep, candidates: group.filter((p) => p !== keep && !prot.includes(p)).sort() };
    for (const order of permutations(group)) assert.deepEqual(keeperOf(order, prot), expected, `${order.join(' | ')}`);
  }
  for (const name of ['copy.txt', '사본.txt', '(1)보고서.pdf', '복사본.pdf', 'photocopy.pdf', 'a(1).pdf', 'a (0).pdf', 'a (100).pdf', 'file.copy.txt'])
    assert.equal(hasCopyMark(name), false, `not a mark: ${name}`);
  for (const name of ['archive (1).tar.gz', 'a copy.tar.gz', 'X - Copy (12).PDF', 'notes (3)', '사진복사본.jpg'])
    assert.equal(hasCopyMark(name), true, `mark: ${name}`);
  const five = ['다운로드 (2).pdf', 'x/다운로드.pdf', '다운로드 copy.pdf', '다운로드.pdf', 'y/z/다운로드.pdf'];
  for (const order of permutations(five)) assert.equal(keeperOf(order).keep, '다운로드.pdf'); // all 120 orders
});

type Plain = (args: string[]) => { status: number | null; stdout: string; stderr: string };
type PlanOps = { plan: { operations: { kind: string; source: string; keeper: string | null }[] } };
const trashPairs = (r: { status: number | null; stdout: string; stderr: string }): string[] => {
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as PlanOps).plan.operations.filter((op) => op.kind === 'trash').map((op) => `${op.source} <- ${op.keeper}`).sort();
};

test('R-K2 keeper through the CLI on real files: plan --delete-duplicates all and the guided trash list keep the unmarked/protected file', { skip: SKIP }, async (t) => {
  const { state, work, pty, plain } = await setup(t, { '보고서.pdf': 'R', '보고서 (1).pdf': 'R', '받은/보고서 copy.pdf': 'R',
    'archive (1).tar.gz': 'Z', 'archive.tar.gz': 'Z', 'copy (1).txt': 'C', 'copy.txt': 'C',
    '정리함/과제/물리/물리_1.pdf': 'r1', '정리함/과제/물리/물리_2.pdf': 'r2', '정리함/원본.hwp': 'P', '원본.hwp': 'P' });
  const before = await snap(work);
  assert.deepEqual(trashPairs(plain(['plan', work, '--delete-duplicates', 'all', '--json'])), ['archive (1).tar.gz <- archive.tar.gz',
    'copy (1).txt <- copy.txt', '받은/보고서 copy.pdf <- 보고서.pdf', '보고서 (1).pdf <- 보고서.pdf', '정리함/원본.hwp <- 원본.hwp'].sort());
  // The keeper may still be picked for deletion explicitly while another copy remains (no KEEPER_INVALID).
  assert.equal(plain(['plan', work, '--delete-file', '보고서.pdf', '--json']).status, 0);

  // Saved rules from 정리함/ (reference inside the work folder): its files are protected and not even hashed (analyzeRoot excludes
  // protected paths), so the 원본.hwp pair disappears instead of "protected copy = keeper". Neither copy is offered for the trash.
  await savePhysicsRule(plain, path.join(work, '정리함'), path.join(path.dirname(state), 'draft-k.json'));
  const withRef = trashPairs(plain(['plan', work, '--delete-duplicates', 'all', '--json']));
  assert.deepEqual(withRef, ['archive (1).tar.gz <- archive.tar.gz', 'copy (1).txt <- copy.txt', '받은/보고서 copy.pdf <- 보고서.pdf',
    '보고서 (1).pdf <- 보고서.pdf'].sort());

  const g = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` }, { expect: TRASH, send: ENTER }]);
  assert.equal(g.exit, 4, g.transcript);
  assert.match(g.transcript, / {2}보고서 \(1\)\.pdf \(같은 내용의 '보고서\.pdf' 파일은 남겨요\)/u);
  assert.match(g.transcript, / {2}archive \(1\)\.tar\.gz \(같은 내용의 'archive\.tar\.gz' 파일은 남겨요\)/u);
  assert.ok(!g.transcript.includes('원본.hwp ('), 'reference copies are not in the trash list');
  assert.deepEqual(await snap(work), before);
});

// ---------- R-U: undo removes only empty folders the run itself created ----------
/** Non-TTY plan + apply (organize) with the code from plan --json; returns the run ID. */
function organize(plain: Plain, work: string, extra: string[] = []): string {
  const p = plain(['plan', work, ...extra, '--json']);
  assert.equal(p.status, 0, p.stderr);
  const parsed = JSON.parse(p.stdout) as { planId: string; approvalChoices: { mode: string; code: string }[] };
  const code = parsed.approvalChoices.find((c) => c.mode === 'organize')!.code;
  const a = plain(['apply', parsed.planId, '--mode', 'organize', '--confirm', code, '--json']);
  assert.equal(a.status, 0, a.stderr);
  return (JSON.parse(a.stdout) as { runId: string }).runId;
}
const runFile = (state: string, runId: string): string => path.join(state, 'runs', `${runId}.json`);
async function editRun(state: string, runId: string, edit: (r: Record<string, unknown>) => void): Promise<void> {
  const r = JSON.parse(await readFile(runFile(state, runId), 'utf8')) as Record<string, unknown>;
  edit(r);
  await writeFile(runFile(state, runId), JSON.stringify(r, null, 2));
}

test('R-U1 undo: created folders removed deepest first; pre-existing folders (also empty) kept; user content and replaced folders kept', { skip: SKIP }, async (t) => {
  const { base, state, work, pty, plain } = await setup(t, { 'a.pdf': 'A', 'memo.txt': 'M', 'b.jpg': 'B', 'clip.mp4': 'V', 'song.mp3': 'S',
    'x.zip': 'Z', 'setup.dmg': 'D', 'readme.md': 'R' });
  await mkdir(path.join(work, '문서')); await mkdir(path.join(work, '빈폴더'));  // pre-existing, empty
  const outside = path.join(base, 'outside'); await mkdir(outside);
  const start = await snap(work);
  const runId = organize(plain, work, ['--move', 'a.pdf=깊은/폴더/안', '--move', 'readme.md=DS폴더']);
  const record = JSON.parse(await readFile(runFile(state, runId), 'utf8')) as { createdDirectories?: { path: string }[] };
  assert.deepEqual((record.createdDirectories ?? []).map((d) => d.path).sort(),
    ['DS폴더', '깊은', '깊은/폴더', '깊은/폴더/안', '설치', '압축', '영상', '음악', '이미지'].sort(), 'only folders this run created; 문서/ existed');

  // The user changes things before undo.
  await writeFile(path.join(work, '영상', '내 메모.txt'), 'user');                          // file added
  await mkdir(path.join(work, '음악', '앨범'));                                            // subfolder added
  await writeFile(path.join(work, 'DS폴더', '.DS_Store'), 'finder');                       // hidden file added
  await writeFile(path.join(work, 'x.zip'), 'new user file');                              // original path taken → partial failure
  await rename(path.join(work, '설치'), path.join(work, '설치.old'));                       // same-name folder replaced by another folder
  await mkdir(path.join(work, '설치')); await rename(path.join(work, '설치.old', 'setup.dmg'), path.join(work, '설치', 'setup.dmg'));
  await rmdir(path.join(work, '설치.old'));
  await rename(path.join(work, '이미지'), path.join(outside, '이미지-target'));             // replaced by a symlink to outside
  await symlink(path.join(outside, '이미지-target'), path.join(work, '이미지'));
  const beforeUndo = await snap(work); const outsideBefore = await snap(outside);

  const u = await pty([{ expect: UNDO, send: `y${ENTER}` }], ['undo']);
  assert.equal(u.exit, 3, u.transcript);   // b.jpg (link in path) and x.zip (original path taken) are not moved back
  const after = await snap(work);
  for (const d of ['깊은', '깊은/폴더', '깊은/폴더/안']) assert.equal(after[d], undefined, `${d} removed (empty, created by the run)`);
  for (const p of ['a.pdf', 'memo.txt', 'clip.mp4', 'song.mp3', 'setup.dmg', 'readme.md']) assert.equal(after[p]?.sha256, start[p]!.sha256, `${p} back`);
  assert.deepEqual(after['문서'], start['문서'], 'pre-existing empty 문서/ kept');
  assert.deepEqual(after['빈폴더'], start['빈폴더'], 'untouched pre-existing empty folder kept');
  assert.deepEqual(after['영상/내 메모.txt'], beforeUndo['영상/내 메모.txt']);
  assert.equal(after['음악/앨범']?.type, 'dir');
  assert.deepEqual(after['DS폴더/.DS_Store'], beforeUndo['DS폴더/.DS_Store']);
  assert.deepEqual(after['x.zip'], beforeUndo['x.zip'], 'user file at the original path untouched');
  assert.deepEqual(after['압축/x.zip'], beforeUndo['압축/x.zip'], 'not moved back; its folder kept (not empty)');
  assert.equal(after['설치']?.type, 'dir', 'replaced 설치/ kept (not the folder the run made)');
  assert.deepEqual(after['이미지'], beforeUndo['이미지'], 'symlink kept');
  assert.deepEqual(await snap(outside), outsideBefore, 'nothing changed behind the symlink');
  const changedKeys = Object.keys({ ...beforeUndo, ...after }).filter((k) => JSON.stringify(beforeUndo[k]) !== JSON.stringify(after[k])).sort();
  assert.deepEqual(changedKeys, ['a.pdf', 'clip.mp4', 'memo.txt', 'readme.md', 'setup.dmg', 'song.mp3', 'DS폴더/readme.md', '깊은', '깊은/폴더',
    '깊은/폴더/안', '깊은/폴더/안/a.pdf', '문서/memo.txt', '설치/setup.dmg', '영상/clip.mp4', '음악/song.mp3'].sort(), 'only the undone moves and 3 folders changed');
  assert.match(u.stdout, /정리할 때 만든 빈 폴더 3개도 지웠어요\./u);
  assert.match(u.stdout, /정리할 때 만든 폴더 6개는 그대로 뒀어요:/u);
  for (const k of ['영상', '음악', 'DS폴더', '압축']) assert.match(u.stdout, new RegExp(`\\n {2}${k} — 안에 다른 항목이 있어 그대로 뒀어요\\.`, 'u'));
  for (const k of ['설치', '이미지']) assert.match(u.stdout, new RegExp(`\\n {2}${k} — 정리할 때 만든 폴더가 아니게 바뀌어 그대로 뒀어요\\.`, 'u'));
  t.diagnostic(u.stdout);
});

test('R-U2 undo with tampered createdDirectories (outside, "..", root itself, absolute, via link, wrong identity) deletes nothing', { skip: SKIP }, async (t) => {
  const cases: [string, { path: string; device: string; inode: string }, boolean][] = [
    ['..', { path: '..', device: '1', inode: '1' }, false],
    ['parent escape', { path: '영상/../..', device: '1', inode: '1' }, false],
    ['root itself (empty path)', { path: '', device: '1', inode: '1' }, false],
    ['root itself (".")', { path: '.', device: '1', inode: '1' }, false],
    ['absolute outside', { path: 'OUTSIDE_ABS', device: 'DEV', inode: 'INO' }, false],
    ['through a link to outside', { path: 'link/empty', device: 'DEV', inode: 'INO' }, true],
    ['the link itself', { path: 'link', device: 'DEV', inode: 'INO' }, true],
    ['created folder, wrong inode', { path: '영상', device: 'VDEV', inode: '1' }, true],
    // Not in the packet's list: a forged entry naming a pre-existing EMPTY folder with its real dev/ino (needs write access to the
    // state folder). Observed and reported (R1); only that empty folder may change, no file.
    ['pre-existing empty folder, real identity', { path: '빈폴더', device: 'EDEV', inode: 'EINO' }, true],
  ];
  for (const [label, tamper, readable] of cases) {
    const { base, state, work, pty, plain } = await setup(t, { 'clip.mp4': 'V', 'notes': 'n' });
    const outside = path.join(base, 'outside'); await mkdir(path.join(outside, 'empty'), { recursive: true });
    await symlink(outside, path.join(work, 'link'));
    await mkdir(path.join(work, '빈폴더'));
    const both = async () => ({ work: await snap(work), outside: await snap(outside) });
    const start = await both();
    const runId = organize(plain, work);
    const o = await lstat(path.join(outside, 'empty'), { bigint: true }); const v = await lstat(path.join(work, '영상'), { bigint: true });
    const e = await lstat(path.join(work, '빈폴더'), { bigint: true });
    await editRun(state, runId, (r) => {
      r['createdDirectories'] = [{ path: tamper.path === 'OUTSIDE_ABS' ? path.join(outside, 'empty') : tamper.path,
        device: { DEV: String(o.dev), VDEV: String(v.dev), EDEV: String(e.dev) }[tamper.device] ?? tamper.device,
        inode: { INO: String(o.ino), EINO: String(e.ino) }[tamper.inode] ?? tamper.inode }];
    });
    const moved = await both();
    const u = await pty(readable ? [{ expect: UNDO, send: `y${ENTER}` }] : [], ['undo']);
    const after = await both();
    assert.deepEqual(after.outside, start.outside, `${label}: outside unchanged`);
    if (!readable) {
      // The record fails the contract: the whole undo is refused (files stay where they were moved), nothing is removed.
      assert.equal(u.exit, 0, `${label}\n${u.transcript}`);
      assert.match(u.transcript, /읽을 수 없는 실행 기록 1개는 건너뛰었어요/u, label);
      assert.deepEqual(after, moved, `${label}: nothing changed`);
      const direct = plain(['undo', runId, '--confirm', runId.slice(0, 8)]);
      assert.equal(direct.status, 1, `${label}: undo <ID> refuses\n${direct.stderr}`);
      assert.deepEqual(await both(), moved, `${label}: nothing changed (undo <ID>)`);
    } else if (tamper.device === 'EDEV') {
      assert.equal(u.exit, 0, `${label}\n${u.transcript}`);
      assert.deepEqual(filesOf(after.work), filesOf(start.work), `${label}: every file back, no file touched`);
      t.diagnostic(`R1 ${label}: 빈폴더 ${after.work['빈폴더'] ? 'kept' : 'REMOVED'}; stdout: ${u.stdout.replace(/\n/gu, ' / ')}`);
    } else {
      assert.equal(u.exit, 0, `${label}\n${u.transcript}`);
      assert.deepEqual(after.work['빈폴더'], start.work['빈폴더'], `${label}: pre-existing empty folder kept`);
      assert.deepEqual(after.work['link'], start.work['link'], `${label}: link kept`);
      assert.equal(after.work['clip.mp4']?.sha256, start.work['clip.mp4']!.sha256, `${label}: file back`);
      assert.equal(after.work['영상']?.type, 'dir', `${label}: 영상/ not in the (tampered) list or identity differs → kept`);
      assert.match(u.stdout, /그대로 뒀어요/u, `${label}\n${u.stdout}`);
      t.diagnostic(`${label}: ${u.stdout.replace(/\n/gu, ' / ')}`);
    }
  }
});

test('R-U3 older run record (no createdDirectories): undo works, no folder removed; a folder still used by a later run is kept', { skip: SKIP }, async (t) => {
  const { state, work, pty, plain } = await setup(t, { 'clip.mp4': 'V', 'a.pdf': 'A' });
  const start = await snap(work);
  const runId = organize(plain, work);
  await editRun(state, runId, (r) => { delete r['createdDirectories']; });
  const u = await pty([{ expect: UNDO, send: `y${ENTER}` }], ['undo']);
  assert.equal(u.exit, 0, u.transcript);
  const after = await snap(work);
  assert.deepEqual(filesOf(after), filesOf(start), 'files back');
  assert.equal(after['영상']?.type, 'dir'); assert.equal(after['문서']?.type, 'dir');
  assert.deepEqual(await readdir(path.join(work, '영상')), []);
  t.diagnostic(`older record, afo undo stdout: ${u.stdout.replace(/\n/gu, ' / ')}`);

  const s2 = await setup(t, { 'clip.mp4': 'V' });
  const first = organize(s2.plain, s2.work);
  await writeFile(path.join(s2.work, 'second.mp4'), 'V2');
  organize(s2.plain, s2.work);
  const direct = s2.plain(['undo', first, '--confirm', first.slice(0, 8)]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /이 실행이 만든 폴더를 그대로 둠: 영상 — 안에 다른 항목이 있어 그대로 뒀습니다\./u);
  const s2after = await snap(s2.work);
  assert.equal(s2after['영상/second.mp4']?.type, 'file'); assert.equal(s2after['clip.mp4']?.type, 'file');
});

// ---------- R-W: wording ----------
test('R-W guided wording: no "AFO 오류" on user stops (codes kept), 해요체, trash note, copy hint, short IDs, short undo screen in local time', { skip: SKIP }, async (t) => {
  const { state, work, pty } = await setup(t, BASE);
  const stops: [string, Step[], number][] = [
    ['organize n', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, KEEP_UNKNOWN, { expect: ORGANIZE, send: `n${ENTER}` }], 4],
    ['trash Enter', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` }, { expect: TRASH, send: ENTER }], 4],
    ['3 unclear yes/no', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` }, { expect: TRASH, send: `00000000${ENTER}` },
      { expect: TRASH, send: `maybe${ENTER}` }, { expect: TRASH, send: `ok${ENTER}` }], 2],
    ['3 bad folders', [{ expect: FOLDER, send: `/없음1${ENTER}` }, { expect: FOLDER, send: `/없음2${ENTER}` }, { expect: FOLDER, send: `/없음3${ENTER}` }], 1],
    ['3 bad answers', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `9${ENTER}` }, { expect: MENU, send: `8${ENTER}` }, { expect: MENU, send: `7${ENTER}` }], 2],
    ['Ctrl+C', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: CTRL_C }], 130],
    ['undo n', [], 4],
  ];
  const screens: string[] = [];
  for (const [label, steps, code] of stops) {
    if (label === 'undo n') continue; // run after a real organize below
    const r = await pty(steps);
    assert.equal(r.exit, code, `${label}\n${r.transcript}`);
    assert.ok(!r.transcript.includes('AFO 오류'), `${label}: no "AFO 오류" prefix\n${r.transcript}`);
    screens.push(r.transcript);
  }
  const s = screens[0]!;
  assert.match(s, /2\) 중복 파일을 휴지통으로 보내기\(휴지통에서 다시 꺼낼 수 있어요\. afo undo로는 되돌리지 않아요\) — 사본 1개/u);
  assert.match(s, /\n {5}같은 내용의 사본 1개도 함께 옮겨요\. 먼저 2\)로 정리할 수도 있어요\./u);
  assert.match(s, /휴지통으로 보낼 수 있는 사본 1개/u);
  assert.match(s, /직접 확인이 필요한 파일: 1개 — 확장자 없음 1\n/u);

  const ok = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, KEEP_UNKNOWN, { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(ok.exit, 0, ok.transcript);
  assert.match(ok.stdout, /^정리를 마쳤어요\.\n/u, 'short headline, no run ID');
  assert.match(ok.stdout, /정리 기록은 afo runs로 볼 수 있어요\./u);
  assert.ok(!ok.stdout.includes('실행 ID'));
  const runId = (await readdir(path.join(state, 'runs'))).find((f) => /^[0-9a-f-]{36}\.json$/u.test(f))!.slice(0, -5);
  const started = (JSON.parse(await readFile(runFile(state, runId), 'utf8')) as { startedAt: string }).startedAt;
  const noCode = await pty([{ expect: UNDO, send: `n${ENTER}` }], ['undo']);
  assert.equal(noCode.exit, 4, noCode.transcript);
  assert.ok(!noCode.transcript.includes('AFO 오류'), noCode.transcript);
  assert.match(noCode.transcript, /되돌리지 않았어요\. 아무것도 바꾸지 않았어요\./u);
  const u = await pty([{ expect: UNDO, send: `y${ENTER}` }], ['undo']);
  assert.equal(u.exit, 0, u.transcript);
  // Local time (TZ=Asia/Seoul = UTC+9, written out by hand); no operation IDs, ISO timestamps or full run IDs on screen.
  const kst = new Date(Date.parse(started) + 9 * 3600_000);
  const h = kst.getUTCHours(); const hour12 = h % 12 === 0 ? 12 : h % 12;
  const when = `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${h < 12 ? '오전' : '오후'} ${hour12}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
  assert.ok(u.transcript.includes(`${when}에 정리한 파일 5개를 원래 자리로 되돌릴까요?`), `local time '${when}'\n${u.transcript}`);
  assert.ok(!/\b[0-9a-f]{16}\b/u.test(u.transcript), 'no operation IDs');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/u.test(u.transcript), 'no ISO timestamps');
  assert.ok(!u.transcript.includes(runId), 'no full run ID');
  assert.match(u.stdout, /^되돌렸어요: 5개 · 건너뜀 0\n정리할 때 만든 빈 폴더 3개도 지웠어요\./u);
  screens.push(ok.transcript, noCode.transcript, u.transcript);
  // 해요체: no 합니다체 sentence endings left on these guided/undo screens.
  const formal = screens.flatMap((sc) => sc.split('\n')).filter((l) => /니다([.)(:,]|$)/u.test(l));
  assert.deepEqual(formal, [], `합니다체 left:\n${formal.join('\n')}`);
  t.diagnostic(`undo screen:\n${u.transcript.split('\n').slice(0, 12).join('\n')}`);
});

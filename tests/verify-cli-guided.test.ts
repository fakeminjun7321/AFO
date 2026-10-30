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
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// `{1}` in send is replaced by group 1 of the latest match that had groups (e.g. the approval code shown on screen).
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
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TMPDIR: tmpdir() };
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
const FOLDER = '끌어다 놓고 Enter를 누르세요\\(그냥 Enter는 종료\\): ';
const MENU = '번호를 입력하세요: ';
const CODE = '계속하려면 아래 코드를 입력하세요: ([a-f0-9]{8})\\n코드\\(그냥 Enter는 취소\\): ';
const UNDO = '확인 코드: (\\S{8}) \\(실행 ID 앞 8자\\)\\n확인 코드 8자를 입력하세요\\(빈 입력은 취소\\): ';
const ENTER = '\r'; const CTRL_C = '\x03';

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
      { expect: MENU, send: `1${ENTER}` }, { expect: CODE, send: ENTER }]);
    assert.equal(r.exit, 4, `${label}: empty code refuses with 4\n${r.transcript}`);
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
    { expect: FOLDER, send: `${path.join(work, '없는 폴더')}${ENTER}` }, { expect: '이 폴더는 정리할 수 없어요: 선택한 폴더를 찾거나 읽을 수 없습니다' },
    { expect: FOLDER, send: `~${ENTER}` }, { expect: '이 폴더는 정리할 수 없어요: 홈 전체' },
    { expect: FOLDER, send: `'${path.join(work, 'a.pdf')}'${ENTER}` }, { expect: '이 폴더는 정리할 수 없어요: 일반 폴더를 직접 선택해야 합니다' },
    { expect: '폴더를 3번 열지 못해 그만둘게요\\. 아무것도 바꾸지 않았어요\\.' }]);
  assert.equal(r.exit, 1, r.transcript);
  assert.equal((r.transcript.match(/끌어다 놓고/gu) ?? []).length, 3, 'asked exactly three times');
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await readdir(state), [], 'state folder untouched');
});

test('pty: wrong code and empty code (menu 1 and 2) run nothing: exit 4, files, approvals/ and runs/ unchanged', { skip: SKIP }, async (t) => {
  const { state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  for (const [menu, typed] of [['1', '00000000'], ['1', ''], ['2', 'ffffffff'], ['2', ''], ['1', 'abcdefgh-x']] as const) {
    const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: menu + ENTER }, { expect: CODE, send: typed + ENTER }]);
    assert.equal(r.exit, 4, `menu ${menu} code '${typed}'\n${r.transcript}`);
    assert.match(r.transcript, typed === '' ? /코드를 입력하지 않아 실행하지 않았어요\. 아무것도 바꾸지 않았어요\./u
      : /코드가 맞지 않아 실행하지 않았어요\. 아무것도 바꾸지 않았어요\./u);
    assert.equal(r.stdout, '', 'nothing on stdout when nothing ran');
    assert.deepEqual(await snap(work), before);
    assert.deepEqual(await writesOf(state), []);
  }
});

test('pty: menu 1 + shown code really moves files; a new `afo undo` process (Ctrl+C first, then the code) restores the manifest', { skip: SKIP }, async (t) => {
  const { state, work, pty } = await setup(t, BASE);
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work.replace(/ /gu, '\\ ')} ${ENTER}` }, { expect: MENU, send: `1${ENTER}` },
    { expect: '이렇게 정리할게요\\(파일 5개, 덮어쓰지 않아요\\):' }, { expect: CODE, send: `{1}${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  // Result goes to stdout; questions and screens do not.
  assert.match(r.stdout, /정리를 마쳤어요\. \(실행 ID [0-9a-f-]+\)\n {2}옮김 5 · 건너뜀 0 · 실패 0\n되돌리려면: afo undo/u);
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

  const cancelled = await pty([{ expect: '가장 최근에 정리한 기록을 되돌려요: ' }, { expect: UNDO, send: CTRL_C }], ['undo']);
  assert.equal(cancelled.exit, 130, cancelled.transcript);
  assert.deepEqual(await snap(work), moved, 'Ctrl+C at the undo question changes nothing');

  const wrong = await pty([{ expect: UNDO, send: `00000000${ENTER}` }], ['undo']);
  assert.equal(wrong.exit, 4, wrong.transcript);
  assert.deepEqual(await snap(work), moved);

  const undo = await pty([{ expect: UNDO, send: `{1}${ENTER}` }], ['undo']);
  assert.equal(undo.exit, 0, undo.transcript);
  const after = await snap(work);
  assert.deepEqual(filesOf(after), filesOf(before), 'same paths, sha256 and mtime as before');
  for (const dir of ['문서', '이미지', '영상']) assert.deepEqual(await readdir(path.join(work, dir)), [], `${dir}/ is left empty (not deleted)`);

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
    ['code question (organize)', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, { expect: CODE, send: CTRL_C }]],
    ['code question (trash)', [{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` }, { expect: CODE, send: CTRL_C }]],
  ];
  for (const [label, steps] of cancels) {
    const r = await pty(steps);
    assert.equal(r.exit, 130, `${label}\n${r.transcript}`);
    assert.match(r.transcript, /취소했습니다\(Ctrl\+C\)\. 실행 전이었다면 아무것도 바꾸지 않았습니다\./u, label);
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
  assert.ok(!r1.transcript.includes('계속하려면 아래 코드를'));
  assert.match(r1.transcript, /같은 내용의 중복 파일: 0묶음/u);

  // Nothing to organize (already placed + needs review) and no duplicates: neither 1 nor 2 can be chosen.
  const idle = await setup(t, { 'notes': 'no extension', '문서/a.pdf': 'already placed' });
  const before = await snap(idle.work);
  const r2 = await idle.pty([{ expect: FOLDER, send: `${idle.work}${ENTER}` },
    { expect: '1\\) 폴더별로 정리하기\\(되돌릴 수 있어요\\) — 할 일 없음\\n {2}2\\) 중복 파일을 휴지통으로 보내기 — 할 일 없음' },
    { expect: MENU, send: `1${ENTER}` }, { expect: '그 작업은 할 일이 없어요' }, { expect: MENU, send: `2${ENTER}` },
    { expect: '그 작업은 할 일이 없어요' }, { expect: MENU, send: `4${ENTER}` }]);
  assert.equal(r2.exit, 0, r2.transcript);
  const r3 = await idle.pty([{ expect: FOLDER, send: `${idle.work}${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, { expect: MENU, send: `9${ENTER}` },
    { expect: MENU, send: `1${ENTER}` }, { expect: '번호를 알아듣지 못해 그만둘게요\\. 아무것도 바꾸지 않았어요\\.' }]);
  assert.equal(r3.exit, 2, r3.transcript);
  assert.ok(!r3.transcript.includes('계속하려면 아래 코드를'));
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
    { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `1${ENTER}` }, { expect: CODE, send: `{1}${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.match(r.transcript, /폴더별로 정리할 수 있는 파일: 2개/u);
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
  const off = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `4${ENTER}` }]);
  assert.match(off.transcript, /내 정리 규칙이 꺼져 있어 기본 분류를 썼어요\./u);
  // Rules off: the moved file would now go to 문서/ by default, but reference files stay protected.
  assert.match(off.transcript, /\[정리\] 과제\/물리\/물리_새보고서\.pdf → 문서\/물리_새보고서\.pdf/u);
  for (const p of REF_FILES) assert.match(off.transcript, new RegExp(`\\[그대로\\] ${p.replace(/[.]/gu, '\\.')}`, 'u'), `${p} still protected`);
  assert.deepEqual(await snap(work), after, 'quitting changed nothing');
});

// OBS-DEFECT (todo, does not fail the run): the summary/detail never says that files are kept because they are reference files.
// With the reference folder = the work folder, every file (also ones added after saving the rule) is kept as a reference file,
// yet the summary reads "저장된 내 정리 규칙을 적용했어요" + "그대로 둘 파일: N개(이미 정리된 곳에 있는 파일 등)" and 1) shows "할 일 없음".
test('pty: the guided summary says when files are kept because they are reference files', {
  skip: SKIP, todo: '요약·자세히 보기에 참고 파일 보호 이유가 표시되지 않음(검증 기록 CLI_GUIDED.md D1)',
}, async (t) => {
  const { state, work, pty, plain } = await setup(t, { '과제/물리/물리_1.pdf': 'r1', '과제/물리/물리_2.pdf': 'r2', '과제/수학/수학_1.pdf': 'r3' });
  await savePhysicsRule(plain, work, path.join(path.dirname(state), 'draft.json'));
  await writeFile(path.join(work, '물리_새보고서.pdf'), 'w1');
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `4${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.deepEqual(await snap(work), before);
  assert.match(r.transcript, /그대로 둘 파일: 4개/u, 'observed: the new file is kept too (whole reference folder protected)');
  assert.match(r.transcript, /참고/u, 'expected: the screen names reference protection as the reason');
});

test('pty: honest wording — "아직 아무것도 바꾸지 않았어요" before running, no permanent delete in the menu, trash is not shown as freed space', { skip: SKIP }, async (t) => {
  const { work, pty } = await setup(t, BASE);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `3${ENTER}` }, { expect: MENU, send: `2${ENTER}` },
    { expect: CODE, send: ENTER }]);
  assert.equal(r.exit, 4);
  assert.match(r.transcript, /파일 6개를 살펴봤어요\. \(아직 아무것도 바꾸지 않았어요\)/u);
  assert.match(r.transcript, /자세히 보기 — 분류 결과\(아직 아무것도 바꾸지 않았어요\):/u);
  assert.match(r.transcript, /이 사본들을 휴지통으로 보낼게요\(1개, 남길 파일은 그대로\):\n {2}c\.txt \(같은 내용의 'c copy\.txt' 파일은 남겨요\)/u);
  assert.match(r.transcript, /AFO 파일 정리 도우미예요\. 파일을 실제로 옮기기 전에 꼭 확인 코드를 물어봐요\./u);
  for (const banned of ['영구', '확보', '공간', ' B ', 'bytes']) assert.ok(!r.transcript.includes(banned), `no '${banned}' in the guided screens`);
});

test('pty: real symlink to the entry point (as npm link installs it) runs directly — help without a TTY, guided with a TTY', { skip: SKIP }, async (t) => {
  const { base, work, pty, plain } = await setup(t, BASE);
  const link = path.join(base, 'bin', 'afo');
  await mkdir(path.dirname(link));
  await symlink(CLI, link);
  await chmod(link, 0o755); // follows the link: the built entry file becomes executable, as npm link does
  assert.match((await readFile(CLI, 'utf8')).split('\n')[0]!, /^#!\/usr\/bin\/env node$/u, 'shebang');
  const help = plain(['--help'], [link]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /가장 쉬운 사용법: afo 를 입력하고 안내를 따르세요/u);
  const noArgs = plain([], [link]);
  assert.equal(noArgs.status, 0);
  assert.match(noArgs.stdout, /세부 명령/u, 'no TTY and no arguments: help, never questions');
  assert.ok(!noArgs.stderr.includes('끌어다'));
  const before = await snap(work);
  const r = await pty([{ expect: 'AFO 파일 정리 도우미예요' }, { expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `4${ENTER}` }], [], [link]);
  assert.equal(r.exit, 0, r.transcript);
  assert.deepEqual(await snap(work), before);
});

test('pty: menu 2 sends one synthetic afo-test- copy to the real OS trash and keeps the keeper (AFO_REAL_TRASH_TEST=1, macOS)', {
  skip: SKIP || (realTrash ? false : 'AFO_REAL_TRASH_TEST=1(macOS)일 때만 합성 사본 1개를 실제 휴지통으로 보냅니다.'),
}, async (t) => {
  const tag = `afo-test-guided-pty-${process.pid}-${Date.now()}`;
  const { work, pty } = await setup(t, { [`${tag}.txt`]: `dup ${tag}`, [`${tag} copy.txt`]: `dup ${tag}`, 'other.pdf': 'unrelated' });
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: `${work}${ENTER}` }, { expect: MENU, send: `2${ENTER}` },
    { expect: '이 사본들을 휴지통으로 보낼게요\\(1개, 남길 파일은 그대로\\):' }, { expect: CODE, send: `{1}${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.match(r.stdout, /휴지통 보내기를 마쳤어요\. .*\n {2}휴지통으로 보냄 1 · 건너뜀 0 · 실패 0/u);
  assert.match(r.stdout, /afo undo로는 되돌리지 않아요/u);
  assert.ok(!/확보|공간/u.test(r.transcript), 'trash is not reported as freed space');
  const after = await snap(work);
  const pair = [`${tag}.txt`, `${tag} copy.txt`];
  assert.equal(pair.filter((p) => after[p] !== undefined).length, 1, 'exactly one copy remains');
  for (const p of pair) if (after[p] !== undefined) assert.deepEqual(after[p], before[p], 'keeper unchanged');
  assert.deepEqual(after['other.pdf'], before['other.pdf']);
  t.diagnostic(`trashed one synthetic ${tag} copy; the trash is never read or emptied`);
});

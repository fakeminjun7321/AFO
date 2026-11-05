/*
 * Verifier: default classification table default-4 and the guided "종류를 모르는 파일" question (origin/feat/unknown-files @ 153abe2).
 * - The expected table below is written by hand from docs/CLI.md and the work packet. The product table (categoryExtensions) is NOT imported.
 * - Interactive paths run the built CLI in a REAL pseudo-terminal (Python pty.fork): Enter "\r", Ctrl+C byte 0x03.
 *   Only NUL/very long folder names go through runCli's io (a pty line discipline would not deliver a NUL byte as typed).
 * - File results come from an independent manifest written here (lstat, no link following: type, size, mtimeNs, sha256).
 * - Synthetic data only: mkdtemp(os.tmpdir()) base with a fake HOME and a temp AFO_STATE_DIR. A base inside the real home is refused
 *   unless it is under the OS temp folder (Windows runners keep %TEMP% under the home). pty tests skip on Windows with a reason.
 * D1 long folder names, D2 silent conflicts and D3 "=" names were `todo` tests; fixed in the builder commit after eda7eb2, now plain tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCategory, extensionOfName } from '../packages/engine/src/defaults.js';
import { classifyFile, confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { errorLine, exitCodeOf, runCli } from '../apps/cli/src/index.js';
import { scanFixture } from './helpers.js';

const CLI = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const REAL_HOME = homedir();

function ptySkip(): string | false {
  if (process.platform === 'win32') return 'Windows에는 POSIX pty가 없어 실제 TTY 검증을 하지 않습니다(Windows: 미검증).';
  const probe = spawnSync('python3', ['-I', '-c', 'import os, pty, select; os.close(os.openpty()[0])'], { encoding: 'utf8', timeout: 10_000 });
  return probe.status === 0 ? false : 'python3(pty 모듈)이 없어 실제 TTY 검증을 건너뜁니다.';
}
const SKIP = ptySkip();

// ---------- 1. hand-written expected table (not derived from defaults.ts) ----------
type Expect = [name: string, category: string | null, reason: 'DEFAULT_EXTENSION' | 'COMPOUND_EXTENSION' | 'INCOMPLETE_DOWNLOAD' | 'UNKNOWN_EXTENSION' | 'NO_EXTENSION'];
const D = 'DEFAULT_EXTENSION';
const TABLE: Expect[] = [
  // 문서 (upper/mixed case on purpose)
  ['Report.PDF', '문서', D], ['과제.hwp', '문서', D], ['memo.TXT', '문서', D], ['deck.pptx', '문서', D], ['sheet.XLSM', '문서', D],
  ['thesis.tex', '문서', D], ['notes.md', '문서', D], ['k1.key', '문서', D], ['한쇼.show', '문서', D], ['양식.Hwt', '문서', D],
  // 이미지
  ['IMG_1.JPG', '이미지', D], ['shot.heic', '이미지', D], ['raw1.CR2', '이미지', D], ['pic.jfif', '이미지', D], ['icon.ico', '이미지', D],
  ['p2.avif', '이미지', D], ['scan.Bmp', '이미지', D],
  // 영상 (+ subtitles)
  ['clip.MOV', '영상', D], ['lec.m4v', '영상', D], ['sub1.srt', '영상', D], ['sub2.vtt', '영상', D], ['cam.m2ts', '영상', D], ['자막.SMI', '영상', D],
  // 음악
  ['song.FLAC', '음악', D], ['v.aac', '음악', D], ['m.mid', '음악', D], ['opus1.opus', '음악', D],
  // 압축: pure archive outer extension wins whatever is inside
  ['a1.zip', '압축', D], ['a2.7z', '압축', D], ['dump.sql.gz', '압축', D], ['table.csv.bz2', '압축', D], ['photos.jpg.zip', '압축', D],
  ['setup.exe.zip', '압축', D], ['tool.exe.7z', '압축', D], ['src.tar.gz', '압축', D], ['src2.tar.zst', '압축', D], ['src3.tar.xz', '압축', D],
  ['arc.TGZ', '압축', D], ['data.json.xz', '압축', D], ['z.rar', '압축', D], ['BIG.TAR.BZ2', '압축', D], ['alz1.alz', '압축', D],
  ['old.v1.2.zip', '압축', D], ['Photo2.JPG.Zip', '압축', D], ['logs.lzma', '압축', D],
  // 설치
  ['setup.exe', '설치', D], ['app.dmg', '설치', D], ['pkg1.pkg', '설치', D], ['droid.apk', '설치', D], ['disk.iso', '설치', D], ['x.AppImage', '설치', D],
  // new categories
  ['logo.psd', '디자인', D], ['logo2.ai', '디자인', D], ['ui.fig', '디자인', D], ['model.stl', '디자인', D],
  ['font.ttf', '글꼴', D], ['font2.WOFF2', '글꼴', D],
  ['book.epub', '전자책', D], ['book2.mobi', '전자책', D],
  ['hw1.py', '코드', D], ['main.c', '코드', D], ['nb.ipynb', '코드', D], ['index.html', '코드', D], ['run.sh', '코드', D], ['stats.R', '코드', D],
  ['cfg.json', '데이터', D], ['cfg2.yml', '데이터', D], ['db1.sqlite3', '데이터', D], ['app.log', '데이터', D], ['q.sql', '데이터', D],
  // disguised double extensions: a known type before a non-archive outer extension (known or not) stays review
  ['report.pdf.exe', null, 'COMPOUND_EXTENSION'], ['REPORT2.PDF.EXE', null, 'COMPOUND_EXTENSION'], ['photo.jpg.scr', null, 'COMPOUND_EXTENSION'],
  ['letter.doc.js', null, 'COMPOUND_EXTENSION'], ['invoice.pdf.lnk', null, 'COMPOUND_EXTENSION'], ['clip2.mp4.ts', null, 'COMPOUND_EXTENSION'],
  ['a.tar.tgz', null, 'COMPOUND_EXTENSION'], ['x.gz.exe', null, 'COMPOUND_EXTENSION'], ['y.zip.exe', null, 'COMPOUND_EXTENSION'],
  ['note.txt.bat', null, 'COMPOUND_EXTENSION'],
  // unfinished downloads, whatever the inner extension
  ['movie.mp4.part', null, 'INCOMPLETE_DOWNLOAD'], ['dump2.sql.gz.part', null, 'INCOMPLETE_DOWNLOAD'], ['big.crdownload', null, 'INCOMPLETE_DOWNLOAD'],
  ['file.download', null, 'INCOMPLETE_DOWNLOAD'], ['raw.PART', null, 'INCOMPLETE_DOWNLOAD'], ['X2.CrDownload', null, 'INCOMPLETE_DOWNLOAD'],
  ['doc.pdf.download', null, 'INCOMPLETE_DOWNLOAD'],
  // left out on purpose (ambiguous) and other unknowns
  ['types.ts', null, 'UNKNOWN_EXTENSION'], ['mat.m', null, 'UNKNOWN_EXTENSION'], ['blob.bin', null, 'UNKNOWN_EXTENSION'], ['save.dat', null, 'UNKNOWN_EXTENSION'],
  ['cache.tmp', null, 'UNKNOWN_EXTENSION'], ['shortcut.lnk', null, 'UNKNOWN_EXTENSION'], ['site.url', null, 'UNKNOWN_EXTENSION'],
  ['site2.webloc', null, 'UNKNOWN_EXTENSION'], ['alias1.alias', null, 'UNKNOWN_EXTENSION'], ['data.xyz', null, 'UNKNOWN_EXTENSION'],
  ['2024.10.30', null, 'UNKNOWN_EXTENSION'], ['v1.2.3', null, 'UNKNOWN_EXTENSION'], ['보고서.한글', null, 'UNKNOWN_EXTENSION'],
  ['TYPES2.TS', null, 'UNKNOWN_EXTENSION'],
  // no extension, digits only
  ['12345', null, 'NO_EXTENSION'], ['README', null, 'NO_EXTENSION'], ['메모', null, 'NO_EXTENSION'],
];
const HIDDEN = ['.env', '.hidden.pdf', '.config.json'];

test('U1 hand table (≥60 names): defaultCategory (the website /preview fallback) = classifyFile = expected; extension = posix.extname', () => {
  assert.ok(TABLE.length >= 60, `table has ${TABLE.length} names`);
  for (const [name, category, reason] of TABLE) {
    assert.equal(extensionOfName(name), path.posix.extname(name).toLowerCase(), name);
    const web = defaultCategory(name); const cli = classifyFile(name);
    assert.deepEqual([web.category, web.reason], [category, reason], `defaultCategory ${name}`);
    assert.deepEqual([cli.category, cli.targetDirectory, cli.reasonCode], [category, category, reason], `classifyFile ${name}`);
    assert.ok(cli.reason.length > 0);
  }
  // Names starting with a dot have no extension for the table (they are excluded by the scanner, see U2).
  assert.equal(defaultCategory('.env').reason, 'NO_EXTENSION');
});

test('U1b the website /preview imports the same defaults.ts and has a sentence for every default reason (static check)', async () => {
  const src = await readFile(path.join(REPO, 'apps/website/src/features/local-preview/preview.ts'), 'utf8');
  assert.match(src, /import \{ defaultCategory, extensionOfName \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/engine\/src\/defaults";/u);
  for (const reason of ['NO_EXTENSION', 'COMPOUND_EXTENSION', 'UNKNOWN_EXTENSION', 'INCOMPLETE_DOWNLOAD', 'DEFAULT_EXTENSION'])
    assert.match(src, new RegExp(`\\b${reason}: "`, 'u'), reason);
  assert.ok(!/categoryExtensions|incompleteDownloadExtensions|archiveOuterExtensions|'hwpx'/u.test(src), 'no second copy of the table in the website');
});

test('U1c learned (reference) rules never move unfinished downloads or disguised names; they still apply to plain names', () => {
  const draft = suggestProfile(scanFixture(['받는중/a.part', '받는중/b.part', '받는중/c.part', '설치함/x.exe', '설치함/y.exe', '설치함/z.exe']));
  const profile = confirmProfile(draft, draft.rules.map((r) => r.id));
  assert.ok(profile.rules.some((r) => r.extension === '.part'), 'a .part rule was learned and confirmed');
  assert.deepEqual([classifyFile('new.exe', { profile }).targetDirectory, classifyFile('new.exe', { profile }).reasonCode], ['설치함', 'PERSONAL_RULE']);
  for (const name of ['movie.mp4.part', 'NEW.PART'])
    assert.deepEqual([classifyFile(name, { profile }).targetDirectory, classifyFile(name, { profile }).reasonCode], [null, 'INCOMPLETE_DOWNLOAD'], name);
  assert.equal(classifyFile('report.pdf.exe', { profile }).reasonCode, 'COMPOUND_EXTENSION');
});

// ---------- independent manifest ----------
interface Entry { type: 'file' | 'dir' | 'symlink' | 'other'; size: string; mtimeNs: string; sha256: string | null; target?: string }
type Snap = Record<string, Entry>;
async function snap(root: string, skip: ReadonlySet<string> = new Set()): Promise<Snap> {
  const out: Snap = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const abs = path.join(dir, name); const key = rel ? `${rel}/${name}` : name;
      if (skip.has(key)) continue;
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
/** Every file is at moves[old] (or unchanged) with the same bytes and mtime; no other file appeared or vanished. */
function assertMoved(before: Snap, after: Snap, moves: Record<string, string>): void {
  const b = filesOf(before); const a = filesOf(after);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).map((k) => moves[k] ?? k).sort());
  for (const [k, e] of Object.entries(b)) {
    const now = a[moves[k] ?? k]!;
    assert.deepEqual([now.sha256, now.size, now.mtimeNs], [e.sha256, e.size, e.mtimeNs], k);
  }
}

// ---------- pty driver (Python, standard library only) ----------
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
        time.sleep(0.12)
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

type Spec = Record<string, string>;
interface Step { expect: string; send?: string }
interface PtyResult { exit: number; transcript: string; stdout: string }
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** `child` is `parent` itself or below it (same drive on Windows). */
const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

async function setup(t: TestContext, spec: Spec) {
  const tmpRoot = await realpath(tmpdir());
  const base = await realpath(await mkdtemp(path.join(tmpRoot, 'afo-verify-unknown-')));
  // Windows runners keep the OS temp folder under the home (C:\Users\<u>\AppData\Local\Temp): allowed there, never the home itself.
  const realHome = await realpath(REAL_HOME);
  assert.ok(!isInside(realHome, base) || (tmpRoot !== realHome && isInside(tmpRoot, base)),
    'synthetic base must be under the OS temp folder (not the home itself) or outside the real home');
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); const state = path.join(base, 'state'); const work = path.join(home, '정리 대상');
  await mkdir(work, { recursive: true }); await mkdir(state);
  // A sibling outside the work root: nothing may ever appear in or vanish from home except inside the work folder.
  await mkdir(path.join(home, '옆 폴더')); await writeFile(path.join(home, '옆 폴더', 'keep.xyz'), 'sibling');
  const put = async (root: string, files: Spec) => {
    for (const [p, content] of Object.entries(files)) {
      const abs = path.join(root, p);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  };
  await put(work, spec);
  const driver = path.join(base, 'ptydrive.py');
  await writeFile(driver, DRIVER);
  // Windows: keep the system variables (SystemRoot etc.) a child node needs and point USERPROFILE (os.homedir) at the fake home.
  const env: Record<string, string> = process.platform === 'win32'
    ? { ...process.env as Record<string, string>, HOME: home, USERPROFILE: home, AFO_STATE_DIR: state, TZ: 'Asia/Seoul' }
    : { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home, AFO_STATE_DIR: state,
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TMPDIR: tmpdir(), TZ: 'Asia/Seoul' };
  let n = 0;
  const pty = async (steps: Step[], extra: string[] = []): Promise<PtyResult> => {
    n += 1;
    const specFile = path.join(base, `spec-${n}.json`); const stdoutFile = path.join(base, `stdout-${n}.txt`);
    await writeFile(specFile, JSON.stringify({ argv: [process.execPath, CLI, ...extra], env, cwd: base, steps, timeout: 60, stdout_file: stdoutFile }));
    const r = spawnSync('python3', ['-I', driver, specFile], { encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, `pty driver failed: ${String(r.stderr)}`);
    const parsed = JSON.parse(String(r.stdout)) as { exit: number; timedOut: boolean; failed: unknown; transcript: string };
    assert.equal(parsed.timedOut, false, `session timed out:\n${parsed.transcript}`);
    assert.equal(parsed.failed, null, `expected text not shown (${JSON.stringify(parsed.failed)}):\n${parsed.transcript}`);
    return { exit: parsed.exit, transcript: parsed.transcript, stdout: await readFile(stdoutFile, 'utf8').catch(() => '') };
  };
  const plain = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  /** The home folder outside the work root, as a manifest. */
  const outside = () => snap(home, new Set([path.basename(work)]));
  const stateWrites = async (): Promise<string[]> => {
    const found: string[] = [];
    for (const d of ['approvals', 'runs', 'journal']) if (await exists(path.join(state, d))) for (const f of await readdir(path.join(state, d))) found.push(`${d}/${f}`);
    return found;
  };
  /** Saved corrections read straight from the state file (not through the product loader). */
  const corrections = async (): Promise<[unknown, string][] | null> => {
    const file = path.join(state, 'profiles', 'active.json');
    if (!(await exists(file))) return null;
    const doc = JSON.parse(await readFile(file, 'utf8')) as { profile?: { corrections?: { match: unknown; targetDirectory: string }[] } };
    return (doc.profile?.corrections ?? []).map((c) => [c.match, c.targetDirectory]);
  };
  return { base, home, state, work, pty, plain, put, outside, stateWrites, corrections };
}

const FOLDER = '끌어다 놓고 Enter를 누르세요\\(경로를 붙여 넣어도 돼요, 그냥 Enter는 종료\\): ';
const MENU = '번호를 입력하세요: ';
const UNKNOWN_Q = '번호를 입력하세요\\(그냥 Enter는 3\\): ';
/** Either folder question: the second form appears once a guided run has executed in this state folder (Enter = the last folder). */
const FOLDER_ANY = '끌어다 놓고 Enter를 누르세요\\((?:경로를 붙여 넣어도 돼요, 그냥 Enter는 종료|그냥 Enter는 지난번 폴더, q는 종료)\\): ';
// Confirmations are yes/no now (organize: Enter = yes; `afo undo` in a terminal: Enter = yes); no code is shown or typed.
const ORGANIZE = '이대로 정리할까요\\? 나중에 afo undo로 되돌릴 수 있어요\\. \\(Y/n\\): ';
const UNDO = '되돌릴까요\\? \\(Y/n\\): ';
const ENTER = '\r'; const CTRL_C = '\x03';
const where = (what: string): string => `${esc(what)}를 어느 폴더로 옮길까요\\? \\(예: 데이터, 그냥 Enter는 그대로 두기\\): `;
const again = (ext: string, folder: string): string => `다음에도 '${esc(ext)}' 파일은 '${esc(folder)}' 폴더로 정리할까요\\? \\(y/N\\): `;
const REFUSED = '그 이름은 폴더로 쓸 수 없어요';

// ---------- 2. CLI preview --json on the same hand table ----------
test('U2 CLI `preview --json` on a folder holding every table name: destinations and reasons = hand table; dot names are HIDDEN', async (t) => {
  const spec: Spec = Object.fromEntries([...TABLE.map(([n]) => n), ...HIDDEN].map((n) => [n, `content of ${n}`]));
  const { work, plain } = await setup(t, spec);
  const before = await snap(work);
  const r = plain(['preview', work, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const preview = (JSON.parse(r.stdout) as { preview: { classificationVersion: string; items: { source: string; destination: string | null;
    action: string; reasonCode: string }[]; skipped: { relativePath: string; code: string }[] } }).preview;
  assert.equal(preview.classificationVersion, 'default-4');
  const got = Object.fromEntries(preview.items.map((i) => [i.source, [i.action, i.destination, i.reasonCode]]));
  const want = Object.fromEntries(TABLE.map(([n, c, reason]) => [n, c === null ? ['review', null, reason] : ['move', `${c}/${n}`, reason]]));
  assert.deepEqual(got, want);
  assert.deepEqual(preview.skipped.map((s) => [s.relativePath, s.code]).sort(), HIDDEN.map((h) => [h, 'HIDDEN']).sort());
  assert.deepEqual(await snap(work), before, 'preview changed nothing');
});

// ---------- 3. pty: 1) everything to 기타 → real move → afo undo ----------
test('U3 pty 1) 기타: really moved (manifest), unfinished downloads/disguised/hidden untouched, nothing outside the root, afo undo restores all', { skip: SKIP }, async (t) => {
  const { work, pty, outside, stateWrites } = await setup(t, {
    'a.pdf': 'pdf', 'data.xyz': 'x1', 'sub/more.XYZ': 'x2', '메모': 'memo', '2024.10.30': 'date-like', 'movie.mp4.part': 'partial',
    'dl/dump.sql.gz.part': 'partial2', 'big.crdownload': 'partial3', '.env': 'hidden', 'report.pdf.exe': 'disguised' });
  const before = await snap(work); const out0 = await outside();
  const r = await pty([{ expect: FOLDER, send: work + ENTER },
    { expect: '직접 확인이 필요한 파일: 8개' },
    { expect: '1\\) 폴더별로 정리하기\\(되돌릴 수 있어요\\) — 파일 1개\\n {5}종류를 모르는 파일 4개는 어디로 옮길지 이어서 물어봐요\\.' },
    { expect: MENU, send: `1${ENTER}` },
    { expect: '다운로드 중일 수 있는 파일 3개\\(예: [^)]+\\)는 그대로 둬요\\.' },
    { expect: '종류를 모르는 파일이 있어요: \\.xyz 2개\\(예: data\\.xyz\\), 확장자 없음 2개\\(예: 2024\\.10\\.30\\)' }, // O4: digits-only ".30" goes with 확장자 없음
    { expect: UNKNOWN_Q, send: `1${ENTER}` },
    { expect: "종류를 모르는 파일 4개를 '기타' 폴더로 옮기는 계획을 만들게요\\." },
    { expect: '이렇게 정리할게요\\(파일 5개, 덮어쓰지 않아요\\):' },
    { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.ok(!r.transcript.includes('다음에도'), '1) asks no save question');
  assert.match(r.stdout, /옮김 5 · 건너뜀 0 · 실패 0/u);
  const moved = await snap(work);
  assertMoved(before, moved, { 'a.pdf': '문서/a.pdf', 'data.xyz': '기타/data.xyz', 'sub/more.XYZ': '기타/more.XYZ', '메모': '기타/메모',
    '2024.10.30': '기타/2024.10.30' });
  for (const k of ['movie.mp4.part', 'dl/dump.sql.gz.part', 'big.crdownload', '.env', 'report.pdf.exe']) assert.deepEqual(moved[k], before[k], k);
  assert.deepEqual(await outside(), out0, 'nothing outside the work root changed');

  const u = await pty([{ expect: UNDO, send: `y${ENTER}` }], ['undo']);
  assert.equal(u.exit, 0, u.transcript);
  assert.deepEqual(await snap(work), before, 'every file (path, bytes, mtime) and folder as before: 기타/ and 문서/ removed, sub/ kept');
  assert.deepEqual(await outside(), out0);
  assert.ok((await stateWrites()).some((w) => w.startsWith('journal/')), 'the run was journaled in the state folder');
});

// ---------- 4. pty: 2) bad folder names ----------
const BAD: [ext: string, names: [string, string, string]][] = [
  ['.ea', ['.숨김', '..', '/abs/x']], ['.eb', ['C:\\x', 'a\\b', 'CON']], ['.ec', ['nul', 'aux.txt', '기타/../..']],
  ['.ed', ['../../탈출', './x', 'a//b']], ['.ee', ['abc.', 'a:b', 'a*b']],
];
test('U4 pty 2) bad folder names (hidden, .., absolute, C:\\, backslash, CON/nul/aux, 기타/../.., trailing dot, : *) are refused, 3rd keeps; spaces-only keeps; nothing changes', { skip: SKIP }, async (t) => {
  const spec: Spec = { ...Object.fromEntries(BAD.map(([e]) => [`f${e}`, e])), 'g.ef': 'spaces', 'movie.mp4.part': 'partial' };
  const { work, state, pty, outside, stateWrites, corrections } = await setup(t, spec);
  const before = await snap(work); const out0 = await outside();
  const steps: Step[] = [{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `2${ENTER}` }];
  for (const [ext, names] of BAD) {
    for (const name of names) steps.push({ expect: where(`'${ext}' 파일 1개`), send: name + ENTER }, { expect: REFUSED });
    steps.push({ expect: `'${esc(ext)}' 파일 1개는 그대로 둘게요\\.` });
  }
  steps.push({ expect: where("'.ef' 파일 1개"), send: `   ${ENTER}` });
  const r = await pty(steps);
  assert.equal(r.exit, 0, r.transcript);
  assert.equal((r.transcript.match(new RegExp(REFUSED, 'gu')) ?? []).length, 15, 'every bad name refused once');
  // Re-verification (bd0bd41): each refusal names its reason (O3).
  // 'a:b' starts with a drive letter (a drive-relative path on Windows), so it is named as an absolute path.
  const reasons: [string, number][] = [['절대 경로는 안 돼요', 3], ["'..'·'.'은 쓸 수 없어요", 4], ['점(.)으로 시작하는 숨김 폴더는 안 돼요', 1],
    ['CON·NUL·AUX 같은 Windows 예약 이름은 안 돼요', 3], ['이름 끝에 점이나 공백은 안 돼요', 1], ['빈 폴더 이름(//)은 안 돼요', 1],
    ['같은 특수 문자나 제어 문자는 안 돼요', 2]];
  for (const [reason, n] of reasons) assert.equal((r.transcript.match(new RegExp(esc(reason), 'gu')) ?? []).length, n, reason);
  assert.ok(!r.transcript.includes('다음에도'), 'no save question without a folder');
  assert.ok(!r.transcript.includes('이대로 정리할까요') && !r.transcript.includes('계속하려면 아래 코드를'), 'no plan offered');
  assert.match(r.stdout, /옮길 파일이 없어요\. 아무것도 바꾸지 않았어요\./u);
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await outside(), out0);
  assert.deepEqual(await stateWrites(), []);
  assert.equal(await corrections(), null, 'no profile written');
  assert.ok(!(await exists(path.join(state, 'profiles', 'active.json'))));
});

// ---------- 5. pty: folder named like an existing file / collisions: never overwritten ----------
test('U5 pty 2) folder = an existing file name, 1) with a file named "기타", and same-name collisions: nothing overwritten, conflicting files stay', { skip: SKIP }, async (t) => {
  const { work, pty, put, outside } = await setup(t, { 'd.xyz': 'x', 'notes.pdf.exe': 'compound stays', 'y.pdf': 'p' });
  let before = await snap(work); const out0 = await outside();
  const r = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `2${ENTER}` },
    { expect: where("'.xyz' 파일 1개"), send: `notes.pdf.exe${ENTER}` }, { expect: again('.xyz', 'notes.pdf.exe'), send: `N${ENTER}` },
    { expect: '이렇게 정리할게요\\(파일 1개, 덮어쓰지 않아요\\):\\n {2}y\\.pdf → 문서/y\\.pdf\\n' }, { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assertMoved(before, await snap(work), { 'y.pdf': '문서/y.pdf' });

  // A file literally named "기타" (no extension, so itself unknown) + 1): nothing can go into it; it is not replaced by a folder.
  await rm(work, { recursive: true }); await mkdir(work);
  await put(work, { '기타': 'a file named gita', 'e.xyz': 'e', 'sub/f.qqq': 'f' });
  before = await snap(work);
  const r2 = await pty([{ expect: FOLDER_ANY, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `1${ENTER}` }]);
  assert.equal(r2.exit, 0, r2.transcript);
  assert.ok(!r2.transcript.includes('이대로 정리할까요'), 'no question: nothing could be planned');
  assert.deepEqual(await snap(work), before, '기타 is still the same file; nothing moved');

  // Two unknown files with the same name in different folders, and one whose 기타/ destination already exists.
  await rm(work, { recursive: true }); await mkdir(work);
  await put(work, { 'a/s.xyz': '1', 'b/s.xyz': '2', 't.qqq': 'root t', '기타/t.qqq': 'already there', 'k.pdf': 'k' });
  before = await snap(work);
  const r3 = await pty([{ expect: FOLDER_ANY, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `1${ENTER}` },
    { expect: '이렇게 정리할게요\\(파일 1개, 덮어쓰지 않아요\\):' }, { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(r3.exit, 0, r3.transcript);
  const after = await snap(work);
  assertMoved(before, after, { 'k.pdf': '문서/k.pdf' });
  assert.equal(after['기타/t.qqq']!.sha256, before['기타/t.qqq']!.sha256, 'existing destination not overwritten');
  assert.deepEqual(await outside(), out0);
});

test('U5-D2 guided tells why unknown files it promised to move were left out (conflict), instead of silence / "파일이 바뀌어"', { skip: SKIP }, async (t) => {
  const { work, pty } = await setup(t, { '기타': 'a file named gita', 'e.xyz': 'e' });
  const r = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `1${ENTER}` }]);
  assert.ok(!r.stdout.includes('살펴보는 사이 파일이 바뀌어'), `files did not change; the move conflicts with the file 기타:\n${r.stdout}`);
  assert.match(r.transcript, /e\.xyz[^\n]*(충돌|겹)/u, 'e.xyz is named with a conflict reason');
});

// ---------- 6. pty: "다음에도" y / N / no extension, then Ctrl+C or no code ----------
test('U6 pty "다음에도": y saves .xyz only (applied by new processes, any case), N saves nothing, no-extension/non-ASCII get no question; Ctrl+C and "n" leave files as they were', { skip: SKIP }, async (t) => {
  const { base, work, pty, plain, outside, stateWrites, corrections } = await setup(t, {
    'data.xyz': 'x', 'k.qqq': 'q', '메모': 'm', 'b.한글': 'h', 'movie.mp4.part': 'partial' });
  const before = await snap(work); const out0 = await outside();
  const r = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `2${ENTER}` },
    { expect: where("'.qqq' 파일 1개"), send: `큐${ENTER}` }, { expect: again('.qqq', '큐'), send: `N${ENTER}` },
    { expect: where("'.xyz' 파일 1개"), send: `자료/${ENTER}` }, { expect: again('.xyz', '자료'), send: `y${ENTER}` },
    { expect: where("'.한글' 파일 1개"), send: `한글자료${ENTER}` },
    { expect: where('확장자 없는 파일 1개'), send: `메모함${ENTER}` },
    { expect: "저장했어요: 다음에도 '\\.xyz' 파일은 '자료' 폴더로 정리해요\\." },
    { expect: '이렇게 정리할게요\\(파일 4개, 덮어쓰지 않아요\\):' },
    { expect: ORGANIZE, send: CTRL_C }]);
  assert.equal(r.exit, 130, r.transcript);
  assert.match(r.transcript, /그만뒀어요\(Ctrl\+C\)\./u);
  assert.equal((r.transcript.match(/다음에도 '[^']+' 파일은 '[^']+' 폴더로 정리할까요/gu) ?? []).length, 2, 'asked for .qqq and .xyz only (not 한글, not 확장자 없음)');
  assert.deepEqual(await snap(work), before, 'Ctrl+C at the yes/no question: no file changed');
  assert.deepEqual(await stateWrites(), [], 'no approval / run / journal');
  assert.deepEqual(await corrections(), [[{ type: 'keyword', extension: '.xyz', keyword: null }, '자료']], 'the y answer stays saved; N did not save');

  // A new process applies the saved correction to another folder, whatever the case; other unknowns stay review.
  const fresh = path.join(base, '새 폴더');
  await mkdir(fresh);
  for (const n of ['NEW.XyZ', 'x.QQQ', '노트', 'z.xyz.part']) await writeFile(path.join(fresh, n), n);
  const p = plain(['preview', fresh, '--json']);
  assert.equal(p.status, 0, p.stderr);
  const items = (JSON.parse(p.stdout) as { preview: { items: { source: string; destination: string | null; reasonCode: string }[] } }).preview.items;
  assert.deepEqual(Object.fromEntries(items.map((i) => [i.source, [i.destination, i.reasonCode]])), {
    'NEW.XyZ': ['자료/NEW.XyZ', 'SAVED_CORRECTION'], 'x.QQQ': [null, 'UNKNOWN_EXTENSION'], '노트': [null, 'NO_EXTENSION'],
    'z.xyz.part': [null, 'INCOMPLETE_DOWNLOAD'] });
  assert.match(plain(['rules', 'list']).stdout, /\.xyz → 자료/u);

  // Second guided run on the same folder: .xyz is no longer "unknown" (saved correction); "n" runs nothing.
  const r2 = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` },
    { expect: '종류를 모르는 파일이 있어요: \\.qqq 1개\\(예: k\\.qqq\\), \\.한글 1개\\(예: b\\.한글\\), 확장자 없음 1개\\(예: 메모\\)' },
    { expect: UNKNOWN_Q, send: ENTER }, { expect: '종류를 모르는 파일 3개는 그대로 둬요\\.' },
    { expect: '이렇게 정리할게요\\(파일 1개, 덮어쓰지 않아요\\):\\n {2}data\\.xyz → 자료/data\\.xyz' }, { expect: ORGANIZE, send: `n${ENTER}` }]);
  assert.equal(r2.exit, 4, r2.transcript);
  assert.match(r2.transcript, /정리하지 않았어요\. 아무것도 바꾸지 않았어요\./u);
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await outside(), out0);
  assert.deepEqual(await stateWrites(), []);
});

// ---------- 7. in-process io: NUL byte and very long names (a pty cannot type NUL) ----------
interface Session { io: { stateDir: string; isTTY: true; warn: (l: string) => void; ask: (q: string) => Promise<string> }; screen: () => string }
function session(state: string, answers: (string | ((screen: string) => string))[]): Session {
  const lines: string[] = [];
  return { screen: () => lines.join('\n'), io: { stateDir: state, isTTY: true, warn: (l) => { lines.push(l); }, ask: (q) => {
    lines.push(q);
    const a = answers.shift();
    if (a === undefined) return Promise.reject(new Error(`unexpected question: ${q}`));
    return Promise.resolve(typeof a === 'function' ? a(lines.join('\n')) : a);
  } } };
}
/** "y" to the organize question (was: the approval code read from the screen); checks it is that question and no code is shown. */
const shownCode = (screen: string): string => {
  assert.ok(screen.endsWith('이대로 정리할까요? 나중에 afo undo로 되돌릴 수 있어요. (Y/n): '), 'the yes/no question');
  assert.ok(!screen.includes('계속하려면 아래 코드를'), 'no code to type');
  return 'y';
};

test('U7 io: a NUL byte in the folder name is refused; three refusals keep the files', async (t) => {
  const { work, state } = await setup(t, { 'd.xyz': 'x' });
  const before = await snap(work);
  const s = session(state, [work, '1', '2', 'a\u0000b', '\u0000', '기타\u0000/x']);
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0);
  assert.equal((s.screen().match(new RegExp(REFUSED, 'gu')) ?? []).length, 3);
  assert.match(s.screen(), /'\.xyz' 파일 1개는 그대로 둘게요\./u);
  assert.deepEqual(await snap(work), before);
});

test('U7b io: a 300-character folder name never loses or overwrites the file (refused at the question since D1; Enter keeps it)', async (t) => {
  const { work, state } = await setup(t, { 'd.xyz': 'x', 'y.pdf': 'p' });
  const before = await snap(work);
  const s = session(state, [work, '1', '2', 'a'.repeat(300), '', shownCode]);
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0, r.output);
  assertMoved(before, await snap(work), { 'y.pdf': '문서/y.pdf' });
});

test('U7b-D1 a folder name the OS cannot create (one segment > 255 bytes) is refused at the question', async (t) => {
  const { work, state } = await setup(t, { 'd.xyz': 'x' });
  const s = session(state, [work, '1', '2', 'a'.repeat(300), '', '']);
  try { await runCli([], undefined, s.io); } catch { /* reported below */ }
  assert.match(s.screen(), new RegExp(REFUSED, 'u'));
});

test('U7c-D3 file names with "=" that also prefix another file name do not crash 1) with an internal --move error', async (t) => {
  const { work, state } = await setup(t, { 'x': 'plain', 'x=y.xyz': 'eq' });
  const before = await snap(work);
  const s = session(state, [work, '1', '1', shownCode]);
  let thrown: string | undefined;
  try { await runCli([], undefined, s.io); } catch (error) { thrown = `${exitCodeOf(error)} ${errorLine(error)}`; }
  assert.deepEqual(await snap(work).then((a) => Object.keys(filesOf(a)).length), Object.keys(filesOf(before)).length, 'no file lost either way');
  assert.equal(thrown, undefined, `stopped with: ${thrown}`);
});

// =====================================================================================================================================
// Re-verification of bd0bd41 (D1~D3, O1~O6 fixes). Same rules: synthetic folders, independent manifest, real pty where interactive.
// =====================================================================================================================================
const NFC = (m: Snap): Record<string, string | null> =>
  Object.fromEntries(Object.entries(filesOf(m)).map(([k, e]) => [k.normalize('NFC'), e.sha256]));
const TOO_LONG = '이름이 너무 길어요(한 단계 255바이트까지)';

test('R1 D1 boundaries (io, real moves): 255 ASCII / 85 한글 (NFC 255 B) / 85 한글 typed as NFD accepted and really created; 256 B, 86 한글, 64 emoji, too-long total path refused', async (t) => {
  const { work, state } = await setup(t, { 'f.aa': '1', 'f.ab': '2', 'f.ac': '3', 'f.ad': '4', 'f.ae': '5' });
  const before = await snap(work);
  const a255 = 'a'.repeat(255); const h85 = '가'.repeat(85); const n85 = '나'.repeat(85).normalize('NFD');
  const deep = Array.from({ length: 4 }, () => 'b'.repeat(250)).join('/');
  const s = session(state, [work, '1', '2', a255, 'N', h85, 'N', n85, 'N', 'a'.repeat(256), '가'.repeat(86), '😀'.repeat(64), deep, '', shownCode]);
  const r = await runCli([], undefined, s.io);
  assert.equal(r.exitCode, 0, r.output);
  const screen = s.screen();
  assert.equal((screen.match(new RegExp(esc(TOO_LONG), 'gu')) ?? []).length, 3, '256 B, 86 한글 (258 B), 64 emoji (256 B)');
  assert.match(screen, /그 이름은 폴더로 쓸 수 없어요\(이름이 너무 길어요\(한 단계 255바이트까지\)\)\. '\.ad' 파일 1개는 그대로 둘게요\./u, '3rd: reason and keep on one line (O2)');
  assert.match(screen, /그 이름은 폴더로 쓸 수 없어요\(옮긴 뒤의 전체 경로가 너무 길어요\)\. 이 폴더 안에 만들 폴더 이름을 다시 입력해 주세요\./u);
  assert.match(r.output, /옮김 3 · 건너뜀 0 · 실패 0/u);
  const want = { ...NFC(before) };
  for (const [f, dir] of [['f.aa', a255], ['f.ab', h85], ['f.ac', n85]] as const) { want[`${dir}/${f}`.normalize('NFC')] = want[f]!; delete want[f]; }
  assert.deepEqual(NFC(await snap(work)), want, 'three files really in the long folders; f.ad and f.ae untouched');
});

test('R1b D1 shared schema: `plan --move` accepts a 255-byte folder and refuses 256 bytes before writing anything', async (t) => {
  const { work, state, plain, stateWrites } = await setup(t, { 'd.xyz': 'x' });
  const before = await snap(work);
  const ok = plain(['plan', work, '--move', `d.xyz=${'가'.repeat(85)}`, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const bad = plain(['plan', work, '--move', `d.xyz=${'a'.repeat(256)}`]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--move의 목적지는 작업 폴더 안의 상대 폴더여야 합니다/u);
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await stateWrites(), []);
  assert.ok(await exists(path.join(state, 'plans')), 'only the accepted plan was saved in the state folder');
});

test('R2 a stored profile whose saved correction points to a 256-byte folder is treated as corrupt: not applied, files untouched, the file kept', async (t) => {
  const { work, state, plain } = await setup(t, { 'd.xyz': 'x', 'y.pdf': 'p' });
  // Save a valid 255-byte correction through the guided flow, then make it 256 bytes (as an older build could have stored it).
  await runCli([], undefined, session(state, [work, '1', '2', 'a'.repeat(255), 'y', 'n']).io).catch(() => undefined);
  const file = path.join(state, 'profiles', 'active.json');
  const doc = JSON.parse(await readFile(file, 'utf8')) as { profile: { corrections: { targetDirectory: string }[] } };
  doc.profile.corrections[0]!.targetDirectory += 'a';
  await writeFile(file, JSON.stringify(doc, null, 2));
  const stored = await readFile(file);
  const before = await snap(work);
  const p = plain(['preview', work, '--json']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /저장된 개인 규칙 프로필이 손상돼 적용하지 않았습니다: 저장된 프로필이 계약과 다릅니다 \(profile\.corrections\.0\.targetDirectory\)/u);
  const items = (JSON.parse(p.stdout) as { preview: { items: { source: string; reasonCode: string }[] }; profile: { source: string } });
  assert.equal(items.profile.source, 'corrupt');
  assert.deepEqual(items.preview.items.map((i) => [i.source, i.reasonCode]).sort(), [['d.xyz', 'UNKNOWN_EXTENSION'], ['y.pdf', 'DEFAULT_EXTENSION']]);
  const g = session(state, [work, '1', '2', '자료', 'n']);
  await assert.rejects(runCli([], undefined, g.io), (e: unknown) => exitCodeOf(e) === 4);
  assert.match(g.screen(), /저장된 내 정리 규칙 파일이 손상돼 이번 정리에만 적용해요\./u);
  assert.ok(!g.screen().includes('다음에도'), 'no save question over a corrupt profile');
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await readFile(file), stored, 'the corrupt profile file is neither rewritten nor deleted');
});

test('R3 pty D2: the file "기타" and same-name collisions are explained by reason; "파일이 바뀌어" is not used when nothing changed', { skip: SKIP }, async (t) => {
  const { work, pty, put } = await setup(t, { '기타': 'a file named gita', 'e.xyz': 'e', 'sub/f.qqq': 'f' });
  let before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `1${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.match(r.transcript, /옮기지 못하는 파일 3개\(그대로 둬요\):\n {2}[^\n]*e\.xyz[^\n]* — '기타'라는 파일이 이미 있어 그 이름으로 폴더를 만들 수 없어요\(이름 충돌\)/u);
  assert.equal(r.stdout.trim(), '옮길 수 있는 파일이 없어요. 아무것도 바꾸지 않았어요.');
  assert.ok(!r.transcript.includes('파일이 바뀌어'));
  assert.deepEqual(await snap(work), before);

  await rm(work, { recursive: true }); await mkdir(work);
  await put(work, { 'a/s.xyz': '1', 'b/s.xyz': '2', 't.qqq': 'root t', '기타/t.qqq': 'already there', 'k.pdf': 'k' });
  before = await snap(work);
  const r2 = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `1${ENTER}` },
    { expect: "종류를 모르는 파일 3개를 '기타' 폴더로 옮기는 계획을 만들게요\\. \\('기타' 폴더에 이미 있는 1개는 그대로 둬요\\)" },
    { expect: '옮기지 못하는 파일 3개\\(그대로 둬요\\):' },
    { expect: '이렇게 정리할게요\\(파일 1개, 덮어쓰지 않아요\\):' }, { expect: ORGANIZE, send: `n${ENTER}` }]);
  assert.equal(r2.exit, 4, r2.transcript);
  assert.match(r2.transcript, /^ {2}t\.qqq — 옮길 곳에 같은 이름이 이미 있어요\(이름 충돌, 덮어쓰지 않아요\)$/mu);
  assert.match(r2.transcript, /^ {2}a\/s\.xyz, b\/s\.xyz — 옮길 곳에서 다른 파일과 이름이 겹쳐요\(덮어쓰지 않아요\)$/mu);
  assert.deepEqual(await snap(work), before);
});

test('R4 pty D3: names with "=", spaces and emoji (x and x=y.xyz together) are moved by file ID, then afo undo restores the manifest', { skip: SKIP }, async (t) => {
  const { work, pty, outside } = await setup(t, { 'x': 'plain', 'x=y.xyz': 'eq', 'a = b 😀.xyz': 'emo', 'a = b 😀': 'emo2', '=.qqq': 'eqq',
    'k=v': 'kv', 'k': 'k', 'sub dir=1/c d=2.xyz': 'deep' });
  const before = await snap(work); const out0 = await outside();
  const r = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `2${ENTER}` },
    { expect: where("'.xyz' 파일 3개"), send: `자료 = 1 😀${ENTER}` }, { expect: again('.xyz', '자료 = 1 😀'), send: `N${ENTER}` },
    { expect: where("'.qqq' 파일 1개"), send: `폴더=2${ENTER}` }, { expect: again('.qqq', '폴더=2'), send: `N${ENTER}` },
    { expect: where('확장자 없는 파일 4개'), send: `기타${ENTER}` },
    { expect: '확장자가 없는\\(또는 숫자로만 된\\) 파일은 기억할 수 없어 이번에만 옮겨요\\.' },
    { expect: '이렇게 정리할게요\\(파일 8개, 덮어쓰지 않아요\\):' }, { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.ok(!r.transcript.includes('--move'), 'no internal --move text');
  assertMoved(before, await snap(work), { 'x': '기타/x', 'x=y.xyz': '자료 = 1 😀/x=y.xyz', 'a = b 😀.xyz': '자료 = 1 😀/a = b 😀.xyz',
    'a = b 😀': '기타/a = b 😀', '=.qqq': '폴더=2/=.qqq', 'k=v': '기타/k=v', 'k': '기타/k', 'sub dir=1/c d=2.xyz': '자료 = 1 😀/c d=2.xyz' });
  const u = await pty([{ expect: UNDO, send: `y${ENTER}` }], ['undo']);
  assert.equal(u.exit, 0, u.transcript);
  assert.deepEqual(await snap(work), before, 'files and folders as before');
  assert.deepEqual(await outside(), out0);
});

test('R5 pty O6: files already inside the chosen folder are not counted and stay byte-for-byte; the others move', { skip: SKIP }, async (t) => {
  const { work, pty } = await setup(t, { '자료/x.qqq': 'inside', 'y.qqq': 'outside', '기타/z.xyz': 'in 기타', 'w.xyz': 'w' });
  const before = await snap(work);
  const r = await pty([{ expect: FOLDER, send: work + ENTER }, { expect: MENU, send: `1${ENTER}` }, { expect: UNKNOWN_Q, send: `2${ENTER}` },
    { expect: where("'.qqq' 파일 2개"), send: `자료${ENTER}` }, { expect: "'자료' 폴더에 이미 있는 1개는 그대로 둬요\\." },
    { expect: again('.qqq', '자료'), send: `N${ENTER}` },
    { expect: where("'.xyz' 파일 2개"), send: `기타${ENTER}` }, { expect: "'기타' 폴더에 이미 있는 1개는 그대로 둬요\\." },
    { expect: again('.xyz', '기타'), send: `N${ENTER}` },
    { expect: '이렇게 정리할게요\\(파일 2개, 덮어쓰지 않아요\\):' }, { expect: ORGANIZE, send: `y${ENTER}` }]);
  assert.equal(r.exit, 0, r.transcript);
  assert.ok(!r.transcript.includes('옮기지 못하는 파일'), 'files already in place are not reported as failures');
  assertMoved(before, await snap(work), { 'y.qqq': '자료/y.qqq', 'w.xyz': '기타/w.xyz' });
});

test('R6 io D3: a file renamed after the first analysis stops with FILE_CHANGED before any plan or approval; nothing moves', async (t) => {
  const { work, state, stateWrites } = await setup(t, { 'd.xyz': 'x', 'y.pdf': 'p' });
  const s = session(state, [work, '1', () => { renameSync(path.join(work, 'd.xyz'), path.join(work, 'd2.xyz')); return '1'; }]);
  let stopped: string | undefined;
  try { await runCli([], undefined, s.io); } catch (error) { stopped = errorLine(error); }
  assert.match(stopped ?? '', /분석 중 파일이 바뀌었습니다\. 다시 실행하세요\./u);
  assert.deepEqual(Object.keys(filesOf(await snap(work))).sort(), ['d2.xyz', 'y.pdf']);
  assert.deepEqual(await stateWrites(), []);
});

test('R7 O1: a rule saved in this run, then "n" → "파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요)."; without a save the old sentence', async (t) => {
  const { work, state, corrections, stateWrites } = await setup(t, { 'd.xyz': 'x' });
  const before = await snap(work);
  await assert.rejects(runCli([], undefined, session(state, [work, '1', '2', '자료', 'y', 'n']).io),
    (e: unknown) => exitCodeOf(e) === 4 && errorLine(e) === '정리하지 않았어요. 파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요).');
  assert.deepEqual(await corrections(), [[{ type: 'keyword', extension: '.xyz', keyword: null }, '자료']]);
  await assert.rejects(runCli([], undefined, session(state, [work, '1', 'n']).io),
    (e: unknown) => exitCodeOf(e) === 4 && errorLine(e) === '정리하지 않았어요. 아무것도 바꾸지 않았어요.');
  assert.deepEqual(await snap(work), before);
  assert.deepEqual(await stateWrites(), [], 'no approval, run or journal on "n"');
});

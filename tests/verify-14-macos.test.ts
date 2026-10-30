/*
 * #14 macOS CLI user path (verifier). Only the built CLI process (node dist/apps/cli/src/index.js) is driven; file results are
 * checked with an independent manifest written here (lstat without following links: type, size, mtime ns, dev, ino, sha256).
 * Product functions are not used as an oracle. Expected destinations are written by hand.
 * Synthetic data only: every test makes its own mkdtemp(os.tmpdir()) base with a fake HOME and a temp AFO_STATE_DIR.
 * The real OS trash is used only when AFO_REAL_TRASH_TEST=1, for one synthetic `afo-test-` file; the trash is never read or emptied.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS physical-path verification (#14). Elsewhere the temp folder can sit under the real home (Windows: AppData\Local\Temp),
// which the safety guard in setup() refuses, so the whole file is skipped there with a stated reason.
const test: typeof nodeTest = (process.platform === 'darwin' ? nodeTest
  : ((name: string, fn: unknown) => nodeTest(name, { skip: 'macOS 실물 경로 검증 전용(#14 macOS). Windows 실물 검증은 별도.' }, fn as never))) as typeof nodeTest;

const CLI = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const REAL_HOME = homedir();
const darwin = process.platform === 'darwin';
const realTrash = process.env['AFO_REAL_TRASH_TEST'] === '1' && darwin;

// ---------- independent manifest ----------
interface Entry { type: 'file' | 'dir' | 'symlink' | 'other'; size: string; mtimeNs: string; dev: string; ino: string; sha256: string | null }
type Snap = Record<string, Entry>;

async function snap(root: string): Promise<Snap> {
  const out: Snap = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const abs = path.join(dir, name); const r = rel ? `${rel}/${name}` : name;
      const s = await lstat(abs, { bigint: true });
      const type = s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'other';
      out[r] = { type, size: String(s.size), mtimeNs: String(s.mtimeNs), dev: String(s.dev), ino: String(s.ino),
        sha256: type === 'file' ? createHash('sha256').update(await readFile(abs)).digest('hex') : null };
      if (type === 'dir') await walk(abs, r);
    }
  };
  await walk(root, '');
  return out;
}
const filesOf = (m: Snap): Snap => Object.fromEntries(Object.entries(m).filter(([, e]) => e.type === 'file'));
const dirsOf = (m: Snap): string[] => Object.keys(m).filter((k) => m[k]!.type === 'dir').sort();
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Hand-written expectation for a move set: each source is gone, its exact bytes and inode are at the destination, all else equal. */
function assertMoves(before: Snap, after: Snap, moves: Record<string, string>, label: string): void {
  const b = filesOf(before); const a = filesOf(after);
  for (const [src, dst] of Object.entries(moves)) {
    assert.equal(a[src], undefined, `${label}: ${src} gone from its source`);
    assert.ok(a[dst], `${label}: ${dst} exists`);
    assert.equal(a[dst]!.sha256, b[src]!.sha256, `${label}: ${dst} has the bytes of ${src}`);
    assert.equal(a[dst]!.ino, b[src]!.ino, `${label}: same inode (rename-like move, not copy)`);
    assert.equal(a[dst]!.mtimeNs, b[src]!.mtimeNs, `${label}: mtime kept`);
  }
  const sources = new Set(Object.keys(moves));
  for (const [rel, e] of Object.entries(b)) if (!sources.has(rel)) assert.deepEqual(a[rel], e, `${label}: ${rel} unchanged`);
  assert.deepEqual(Object.keys(a).sort(), [...Object.keys(b).filter((r) => !sources.has(r)), ...Object.values(moves)].sort(), `${label}: file set`);
}

// ---------- fixture and CLI process ----------
type Spec = Record<string, string>;
interface Res { status: number | null; stdout: string; stderr: string }

async function setup(t: TestContext, spec: Spec) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'afo-test-v14-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.ok(!base.startsWith(REAL_HOME + path.sep) && base !== REAL_HOME, 'synthetic base is not under the real home');
  const dirs = { base, home: path.join(base, 'home'), state: path.join(base, 'state') };
  await mkdir(dirs.home); await mkdir(dirs.state);
  await write(base, spec);
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, HOME: dirs.home, AFO_STATE_DIR: dirs.state, ...extra });
  const cli = (args: string[], extra: Record<string, string> = {}): Res => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const cliAsync = (args: string[]): Promise<Res> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
  const ok = (r: Res, what: string): Res => { assert.equal(r.status, 0, `${what}: ${r.stderr}`); return r; };
  const p = (...parts: string[]): string => path.join(base, ...parts);
  return { dirs, cli, cliAsync, ok, p };
}
async function write(root: string, spec: Spec): Promise<void> {
  for (const [rel, data] of Object.entries(spec)) {
    const abs = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
}

interface Op { id: string; kind: 'move' | 'trash' | 'delete'; source: string; destination: string | null; keeper: string | null }
interface PlanOut { planId: string; plan: { operations: Op[]; profileId: string | null }; approvalChoices: { mode: string; operationIds: string[]; code: string }[] }
interface Report { runId: string; results: { opId: string; status: string; errorCode: string | null }[];
  space: { logicalBytesSelected: number; freeBytesBefore: number | null; freeBytesAfter: number | null; note: string };
  directories?: { removed: string[]; kept: { path: string; reason: string }[] } }
const planOf = (r: Res): PlanOut => JSON.parse(r.stdout) as PlanOut;
const codeOf = (pl: PlanOut, mode: string): string => {
  const c = pl.approvalChoices.find((x) => x.mode === mode); assert.ok(c, `plan has ${mode}`); return c.code;
};
const reportOf = (r: Res): Report => (JSON.parse(r.stdout) as { report: Report }).report;
const opsBySource = (pl: PlanOut): Record<string, Op> => Object.fromEntries(pl.plan.operations.map((o) => [o.source, o]));
const moveMap = (pl: PlanOut): Record<string, string> =>
  Object.fromEntries(pl.plan.operations.filter((o) => o.kind === 'move').map((o) => [o.source, o.destination!]));
const statusById = (rep: Report): Record<string, string> => Object.fromEntries(rep.results.map((x) => [x.opId, `${x.status}${x.errorCode ? `:${x.errorCode}` : ''}`]));
const journal = async (state: string, runId: string): Promise<{ opId: string; phase: string; before: { sha256: string | null; inode: string } | null;
  after: { sha256: string | null; inode: string } | null }[]> =>
  (await readFile(path.join(state, 'journal', `${runId}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const count = async (dir: string): Promise<number> => (await readdir(dir).catch(() => [])).length;

const REF: Spec = {
  'ref/과제/물리/물리_1.pdf': 'r1', 'ref/과제/물리/물리_2.pdf': 'r2', 'ref/과제/수학/수학_1.pdf': 'r3', 'ref/과제/수학/수학_2.pdf': 'r4',
  'ref/사진/여행1.jpg': 'r5', 'ref/사진/여행2.jpg': 'r6',
};
/** suggest-rules → draft file → rules save --select (only the 과제 rules; the 사진 rule stays unconfirmed). Returns rule IDs. */
async function saveRules(ctx: Awaited<ReturnType<typeof setup>>): Promise<{ physics: string; math: string; photo: string }> {
  const s = ctx.ok(ctx.cli(['suggest-rules', ctx.p('ref')]), 'suggest-rules');
  const draft = JSON.parse(s.stdout) as { status: string; rules: { id: string; targetDirectory: string }[] };
  assert.equal(draft.status, 'draft');
  const id = (dir: string): string => { const r = draft.rules.find((x) => x.targetDirectory === dir); assert.ok(r, `rule → ${dir}`); return r.id; };
  const ids = { physics: id('과제/물리'), math: id('과제/수학'), photo: id('사진') };
  await writeFile(ctx.p('draft.json'), s.stdout);
  ctx.ok(ctx.cli(['rules', 'save', ctx.p('draft.json'), '--select', `${ids.physics},${ids.math}`]), 'rules save');
  return ids;
}

// ---------- S1 + S6(recover) + S7(organize output) ----------
test('S1 reference → suggest → save → new-process preview/plan → apply organize → runs → recover → undo', async (t) => {
  const ctx = await setup(t, { ...REF, 'work/물리_보고서.pdf': 'w-physics', 'work/수학_숙제.pdf': 'w-math', 'work/IMG_1.jpg': 'w-img',
    'work/메모.txt': 'w-memo', 'work/발표 자료 🎉.pptx': 'w-slides', 'work/README': 'no ext' });
  const { cli, ok, p, dirs } = ctx;
  const ref0 = await snap(p('ref'));
  const work0 = await snap(p('work'));
  await saveRules(ctx);
  assert.deepEqual(await snap(p('ref')), ref0, 'suggest/save leave the reference untouched');

  const EXPECT = { '물리_보고서.pdf': '과제/물리/물리_보고서.pdf', '수학_숙제.pdf': '과제/수학/수학_숙제.pdf', 'IMG_1.jpg': '이미지/IMG_1.jpg',
    '메모.txt': '문서/메모.txt', '발표 자료 🎉.pptx': '문서/발표 자료 🎉.pptx' };
  const pv = JSON.parse(ok(cli(['preview', p('work'), '--json']), 'preview').stdout) as
    { profile: { source: string }; preview: { items: { source: string; action: string; destination: string | null }[] } };
  assert.equal(pv.profile.source, 'saved');
  const pvMap = Object.fromEntries(pv.preview.items.map((i) => [i.source, i.destination]));
  assert.deepEqual(pvMap, { ...EXPECT, README: null });

  const pl = planOf(ok(cli(['plan', p('work'), '--json']), 'plan'));
  assert.ok(pl.plan.profileId, 'plan bound to the saved profile');
  assert.deepEqual(moveMap(pl), EXPECT, 'plan destinations = hand-written expectation');
  assert.ok(pl.plan.operations.every((o) => o.kind === 'move'), 'no delete without --delete-*');
  assert.deepEqual(await snap(p('work')), work0, 'preview/plan change nothing');

  const r = ok(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', codeOf(pl, 'organize'), '--json']), 'apply');
  const rep = reportOf(r);
  assert.ok(rep.results.every((x) => x.status === 'moved'));
  const work1 = await snap(p('work'));
  assertMoves(work0, work1, EXPECT, 'apply organize');
  assert.deepEqual(await snap(p('ref')), ref0, 'reference originals unchanged (path, bytes, mtime, inode)');

  // Journal: every op has intent then done; before = original bytes, after inode = observed destination inode.
  const j = await journal(dirs.state, rep.runId);
  const ops = opsBySource(pl);
  for (const [src, dst] of Object.entries(EXPECT)) {
    const phases = j.filter((e) => e.opId === ops[src]!.id).map((e) => e.phase);
    assert.deepEqual(phases, ['intent', 'done'], `journal phases for ${src}`);
    const done = j.find((e) => e.opId === ops[src]!.id && e.phase === 'done')!;
    assert.equal(done.after!.sha256, work0[src]!.sha256);
    assert.equal(done.after!.inode, work1[dst]!.ino);
  }

  // runs (JSON + human) and recover after a normal run.
  const runs = JSON.parse(ok(cli(['runs', '--json']), 'runs').stdout) as { runs: { runId: string; mode: string; undoable: boolean }[] };
  assert.deepEqual(runs.runs.map((x) => [x.runId, x.mode, x.undoable]), [[rep.runId, 'organize', true]]);
  const rec = ok(cli(['recover', '--json']), 'recover');
  assert.deepEqual(JSON.parse(rec.stdout), { checked: 1, runs: [] });
  const human = ok(cli(['runs', rep.runId]), 'runs detail');
  assert.match(human.stdout, new RegExp(`undo ${rep.runId}`, 'u'), 'organize run suggests undo');
  assert.deepEqual(await snap(p('work')), work1, 'runs/recover read only');

  // undo: refused without a code, then back to the original manifest.
  assert.equal(cli(['undo', rep.runId]).status, 4);
  assert.equal(cli(['undo', rep.runId, '--confirm', 'zzzzzzzz']).status, 4);
  assert.deepEqual(await snap(p('work')), work1);
  const u = ok(cli(['undo', rep.runId, '--confirm', rep.runId.slice(0, 8), '--json']), 'undo');
  assert.ok(reportOf(u).results.every((x) => x.status === 'moved'));
  const work2 = await snap(p('work'));
  assert.deepEqual(filesOf(work2), filesOf(work0), 'files back: same paths, bytes, mtime, dev/ino');
  // Folders the run created are removed again once empty: the folder list equals the original one.
  assert.deepEqual(dirsOf(work2), dirsOf(work0), 'no folder created by the move is left behind');
  assert.deepEqual([...(reportOf(u).directories?.removed ?? [])].sort(), ['과제', '과제/물리', '과제/수학', '문서', '이미지']);
  assert.deepEqual(await snap(p('ref')), ref0);
  assert.deepEqual(JSON.parse(ok(cli(['recover', '--json']), 'recover after undo').stdout), { checked: 1, runs: [] });
});

// ---------- S2 restart: saved rules on new synthetic files in separate processes ----------
test('S2 after restart the saved rules apply to new synthetic files (separate processes, another work folder)', async (t) => {
  const ctx = await setup(t, { ...REF, 'work/물리_x.pdf': 'old' });
  const { cli, ok, p } = ctx;
  await saveRules(ctx);
  const rev = (JSON.parse(ok(cli(['rules', 'list', '--json']), 'list').stdout) as { profile: { revision: number } }).profile.revision;
  const ref0 = await snap(p('ref'));
  await write(p(), { 'work2/물리_실험보고서2.pdf': 'n1', 'work2/수학_기말.pdf': 'n2', 'work2/photo.JPG': 'n3', 'work2/여행 메모.TXT': 'n4' });
  const before = await snap(p('work2'));
  const EXPECT = { '물리_실험보고서2.pdf': '과제/물리/물리_실험보고서2.pdf', '수학_기말.pdf': '과제/수학/수학_기말.pdf',
    'photo.JPG': '이미지/photo.JPG', '여행 메모.TXT': '문서/여행 메모.TXT' };
  const pl = planOf(ok(cli(['plan', p('work2'), '--json']), 'plan'));
  assert.deepEqual(moveMap(pl), EXPECT);
  ok(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', codeOf(pl, 'organize'), '--json']), 'apply');
  assertMoves(before, await snap(p('work2')), EXPECT, 'S2');
  assert.deepEqual(await snap(p('ref')), ref0);
  const rev2 = (JSON.parse(ok(cli(['rules', 'list', '--json']), 'list').stdout) as { profile: { revision: number } }).profile.revision;
  assert.equal(rev2, rev, 'running plans/apply does not change the profile revision');
});

// ---------- S3 remembered vs one-off corrections, reset, profile change after plan ----------
test('S3 --move --remember is used by the next plan, one-off --move is not, rules reset → default; old plan refused after reset', async (t) => {
  const ctx = await setup(t, { ...REF, 'work/IMG_2.jpg': 'img', 'work/README': 'readme', 'work/물리_노트.pdf': 'note' });
  const { cli, ok, p } = ctx;
  await saveRules(ctx);
  const w0 = await snap(p('work'));

  const rem = JSON.parse(ok(cli(['preview', p('work'), '--move', 'IMG_2.jpg=사진/여행', '--remember', '--json']), 'remember').stdout) as
    { remembered: { correctionId: string }[] };
  assert.equal(rem.remembered.length, 1);
  const a = planOf(ok(cli(['plan', p('work'), '--json']), 'plan A'));
  assert.deepEqual(moveMap(a), { 'IMG_2.jpg': '사진/여행/IMG_2.jpg', '물리_노트.pdf': '과제/물리/물리_노트.pdf' });

  const once = planOf(ok(cli(['plan', p('work'), '--move', 'README=기타', '--json']), 'plan once'));
  assert.equal(opsBySource(once)['README']?.destination, '기타/README', 'one-off --move applies to this plan');
  ok(cli(['preview', p('work'), '--move', 'README=기타']), 'preview once');
  const b = planOf(ok(cli(['plan', p('work'), '--json']), 'plan B'));
  assert.equal(opsBySource(b)['README'], undefined, 'one-off --move was not saved');
  assert.deepEqual(moveMap(b), moveMap(a));

  assert.equal(cli(['rules', 'reset']).status, 2, 'non-TTY reset needs --confirm reset');
  ok(cli(['rules', 'reset', '--confirm', 'reset']), 'reset');
  const c = planOf(ok(cli(['plan', p('work'), '--json']), 'plan C'));
  assert.deepEqual(moveMap(c), { 'IMG_2.jpg': '이미지/IMG_2.jpg', '물리_노트.pdf': '문서/물리_노트.pdf' }, 'default classification after reset');
  assert.deepEqual(await snap(p('work')), w0, 'no file changed so far');

  // Plan B was bound to the saved profile; after reset its approval is refused and nothing moves.
  const old = cli(['apply', b.planId, '--mode', 'organize', '--confirm', codeOf(b, 'organize')]);
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /PROFILE_CHANGED/u);
  assert.equal(old.status, 1, 'observed: PROFILE_CHANGED maps to exit 1 (docs/CLI.md exit table)');
  assert.equal(await count(path.join(ctx.dirs.state, 'approvals')), 0, 'no approval record issued');
  t.diagnostic(`S3 apply after profile reset: exit ${old.status} ${old.stderr.trim().split("\n").pop() ?? ""}`);
  assert.deepEqual(await snap(p('work')), w0, 'refused apply changed nothing');
});

// ---------- S4 permanent delete of duplicates + S7 honesty ----------
test('S4 duplicates → --delete-mode permanent → apply permanent-delete: keepers kept, candidates gone, free space observed, undo refused', async (t) => {
  const ctx = await setup(t, { 'work/a.txt': 'same-A', 'work/a copy.txt': 'same-A', 'work/b1.bin': 'BBBB', 'work/b2.bin': 'BBBB',
    'work/b3.bin': 'BBBB', 'work/other.pdf': 'unique', 'work/a2.txt': 'same-a' /* same size, different bytes: not a duplicate */ });
  const { cli, ok, p, dirs } = ctx;
  const w0 = await snap(p('work'));
  const human = ok(cli(['plan', p('work'), '--delete-duplicates', 'all', '--delete-mode', 'permanent']), 'plan human');
  assert.match(human.stdout, /되돌릴 수 없/u);
  const pl = planOf(ok(cli(['plan', p('work'), '--delete-duplicates', 'all', '--delete-mode', 'permanent', '--json']), 'plan'));
  const dels = pl.plan.operations.filter((o) => o.kind === 'delete');
  // Hand-written grouping: {a.txt, a copy.txt} and {b1,b2,b3}. a2.txt (same size, other bytes) and other.pdf are never candidates.
  const groups = [['a.txt', 'a copy.txt'], ['b1.bin', 'b2.bin', 'b3.bin']];
  assert.equal(dels.length, 3);
  for (const g of groups) {
    const inGroup = dels.filter((o) => g.includes(o.source));
    assert.equal(inGroup.length, g.length - 1, `one keeper left in ${g.join(',')}`);
    const keeper = g.find((n) => !inGroup.some((o) => o.source === n))!;
    assert.ok(inGroup.every((o) => o.keeper === keeper), 'each candidate names the group keeper');
  }
  assert.ok(!dels.some((o) => ['a2.txt', 'other.pdf'].includes(o.source)));
  const code = codeOf(pl, 'permanent-delete');

  assert.equal(cli(['apply', pl.planId, '--mode', 'permanent-delete', '--confirm', code]).status, 4, 'no --phrase');
  assert.equal(cli(['apply', pl.planId, '--mode', 'permanent-delete', '--confirm', code, '--phrase', '영구삭제']).status, 4, 'wrong phrase');
  assert.equal(cli(['apply', pl.planId, '--mode', 'trash', '--confirm', code]).status, 4, 'no trash ops in a permanent plan (MODE_MISMATCH)');
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', code, '--phrase', '영구 삭제']).status, 2, '--phrase only with permanent-delete');
  assert.deepEqual(await snap(p('work')), w0, 'refusals changed nothing');
  assert.equal(await count(path.join(dirs.state, 'approvals')), 0, 'refusals issued no approval');

  const r = ok(cli(['apply', pl.planId, '--mode', 'permanent-delete', '--confirm', code, '--phrase', '영구 삭제']), 'apply permanent');
  assert.match(r.stdout, /영구 삭제함/u);
  assert.match(r.stdout, /되돌릴 수 없/u);
  assert.match(r.stdout, /여유 공간\(관측\): 실행 전 \d+ B → 실행 후 \d+ B|여유 공간: 관측하지 못했습니다/u);
  assert.match(r.stdout, /확보량 아님/u);
  assert.doesNotMatch(r.stdout, /undo [0-9a-f-]{36}/u, 'no undo suggestion for a permanent delete');
  const runId = /실행 ID: ([0-9a-f-]{36})/u.exec(r.stdout)![1]!;
  const w1 = await snap(p('work'));
  const gone = new Set(dels.map((o) => o.source));
  for (const n of gone) assert.equal(w1[n], undefined, `${n} deleted`);
  for (const [rel, e] of Object.entries(w0)) if (!gone.has(rel)) assert.deepEqual(w1[rel], e, `${rel} (keeper or other) unchanged`);
  assert.equal(Object.keys(filesOf(w1)).length, Object.keys(filesOf(w0)).length - 3);
  for (const g of groups) assert.equal(g.filter((n) => w1[n]).length, 1, 'exactly one copy survives per group');
  const j = await journal(dirs.state, runId);
  for (const o of dels) assert.deepEqual(j.filter((e) => e.opId === o.id).map((e) => e.phase), ['intent', 'done']);

  const detail = JSON.parse(ok(cli(['runs', runId, '--json']), 'runs').stdout) as { run: { report: Report } };
  t.diagnostic(`S4 free space observed: ${detail.run.report.space.freeBytesBefore} → ${detail.run.report.space.freeBytesAfter}`);
  assert.doesNotMatch(ok(cli(['runs', runId]), 'runs human').stdout, /undo 가능/u);
  const u = cli(['undo', runId, '--confirm', runId.slice(0, 8)]);
  assert.equal(u.status, 1, 'undo of a permanent delete is refused');
  assert.match(u.stderr, /되돌릴 수 없/u);
  assert.deepEqual(await snap(p('work')), w1);
});

test('S4 trash (AFO_REAL_TRASH_TEST=1 only): one synthetic afo-test- duplicate goes to the real OS trash, keeper and others stay', {
  skip: realTrash ? false : 'set AFO_REAL_TRASH_TEST=1 on macOS to send one synthetic afo-test- file to the real trash',
}, async (t) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [x, y] = [`afo-test-v14-${tag}.txt`, `afo-test-v14-${tag} copy.txt`];
  const ctx = await setup(t, { [`work/${x}`]: `dup-${tag}`, [`work/${y}`]: `dup-${tag}`, 'work/keep-me.pdf': 'keep' });
  const { cli, ok, p } = ctx;
  const w0 = await snap(p('work'));
  const pl = planOf(ok(cli(['plan', p('work'), '--delete-duplicates', 'all', '--json']), 'plan'));
  const trash = pl.plan.operations.filter((o) => o.kind === 'trash');
  assert.equal(trash.length, 1);
  assert.ok(trash[0]!.source.startsWith('afo-test-v14-'), 'only an afo-test- file is sent to the trash');
  const r = ok(cli(['apply', pl.planId, '--mode', 'trash', '--confirm', codeOf(pl, 'trash')]), 'apply trash');
  assert.match(r.stdout, /휴지통으로 보냄/u);
  assert.match(r.stdout, /확보량 아님/u);
  assert.doesNotMatch(r.stdout, /여유 공간\(관측\)/u, 'a trash move is not shown as reclaimed space');
  assert.doesNotMatch(r.stdout, /undo [0-9a-f-]{36}/u);
  assert.match(r.stdout, /휴지통에서 직접 복원/u);
  const runId = /실행 ID: ([0-9a-f-]{36})/u.exec(r.stdout)![1]!;
  const w1 = await snap(p('work'));
  assert.equal(w1[trash[0]!.source], undefined);
  for (const [rel, e] of Object.entries(w0)) if (rel !== trash[0]!.source) assert.deepEqual(w1[rel], e, `${rel} unchanged`);
  assert.equal(w1[trash[0]!.keeper!]!.sha256, sha(`dup-${tag}`));
  const u = cli(['undo', runId, '--confirm', runId.slice(0, 8)]);
  assert.equal(u.status, 1);
  assert.match(u.stderr, /휴지통/u);
  t.diagnostic(`S4 trash: ${trash[0]!.source} sent to the real OS trash (not read, not emptied)`);
});

// ---------- S5 approval boundaries ----------
test('S5 approval boundaries: missing/wrong/other-mode code, --yes, --only, reuse, tampered plan, changed source, taken destination', async (t) => {
  const ctx = await setup(t, { 'work/a.pdf': 'A', 'work/b.jpg': 'B-original', 'work/c.mp4': 'C', 'work/d.txt': 'D', 'work/e.png': 'E',
    'work/x.txt': 'dupX', 'work/x copy.txt': 'dupX' });
  const { cli, ok, p, dirs } = ctx;
  const w0 = await snap(p('work'));
  const pl = planOf(ok(cli(['plan', p('work'), '--delete-duplicates', 'all', '--delete-mode', 'permanent', '--json']), 'plan'));
  const org = codeOf(pl, 'organize'); const del = codeOf(pl, 'permanent-delete');
  const unchanged = async (why: string): Promise<void> => { assert.deepEqual(await snap(p('work')), w0, why); };

  assert.equal(cli(['apply', pl.planId, '--mode', 'organize']).status, 4, 'non-TTY without --confirm');
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', '00000000']).status, 4, 'wrong code');
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', del]).status, 4, 'permanent-delete code for organize');
  assert.equal(cli(['apply', pl.planId, '--mode', 'permanent-delete', '--confirm', org, '--phrase', '영구 삭제']).status, 4, 'organize code for delete');
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--yes']).status, 2, '--yes is not an option');
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', org, '--yes']).status, 2, '--yes with a valid code still refused');
  assert.equal(cli(['apply', 'f'.repeat(64), '--mode', 'organize', '--confirm', org]).status, 4, 'unknown plan');
  await unchanged('all refusals changed nothing');
  assert.equal(await count(path.join(dirs.state, 'approvals')), 0, 'no approval record was issued');
  assert.equal(await count(path.join(dirs.state, 'runs')), 0);

  // --only: the plan's full code does not cover a subset; the subset's code is shown by apply itself.
  const ops = opsBySource(pl);
  const a = ops['a.pdf']!;
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--only', a.id, '--confirm', org]).status, 4, 'full code for a subset');
  const ask = cli(['apply', pl.planId, '--mode', 'organize', '--only', a.id]);
  assert.equal(ask.status, 4);
  const sub = /승인 코드: ([0-9a-f]{8})/u.exec(ask.stderr)![1]!;
  assert.notEqual(sub, org);
  ok(cli(['apply', pl.planId, '--mode', 'organize', '--only', a.id, '--confirm', sub, '--json']), 'apply --only');
  const w1 = await snap(p('work'));
  assertMoves(w0, w1, { 'a.pdf': '문서/a.pdf' }, '--only');
  // Reuse: same subset again, or the full set that includes it → APPROVAL_USED (4), nothing changes.
  const again = cli(['apply', pl.planId, '--mode', 'organize', '--only', a.id, '--confirm', sub]);
  assert.equal(again.status, 4); assert.match(again.stderr, /APPROVAL_USED/u);
  assert.equal(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', org]).status, 4);
  assert.deepEqual(await snap(p('work')), w1, 'reuse refused, nothing changed');

  // Tampered saved plan. (a) destination escaping the root fails the plan contract (STATE_CORRUPT, 1);
  // (b) a contract-valid other destination no longer matches the plan ID hash (PLAN_CHANGED, 4). Nothing is written in either case.
  const p2 = planOf(ok(cli(['plan', p('work'), '--json']), 'plan 2'));
  const planFile = path.join(dirs.state, 'plans', `${p2.planId}.json`);
  const raw = await readFile(planFile, 'utf8');
  const compact = JSON.stringify(JSON.parse(raw));
  const baseBefore = (await readdir(p())).sort();
  const approvalsBefore = await count(path.join(dirs.state, 'approvals'));
  const tampered: [string, number, RegExp][] = [['../escaped/b.jpg', 1, /STATE_CORRUPT/u], ['다른곳/b.jpg', 4, /PLAN_CHANGED/u]];
  for (const [dest, exit, code] of tampered) {
    const hit = compact.replace('"destination":"이미지/b.jpg"', `"destination":${JSON.stringify(dest)}`);
    assert.notEqual(hit, compact, 'tamper target found');
    await writeFile(planFile, hit);
    const tam = cli(['apply', p2.planId, '--mode', 'organize', '--confirm', codeOf(p2, 'organize')]);
    assert.equal(tam.status, exit, `${dest}: ${tam.stderr}`); assert.match(tam.stderr, code);
    assert.deepEqual(await snap(p('work')), w1, `${dest}: nothing moved`);
    assert.deepEqual((await readdir(p())).sort(), baseBefore, 'nothing created beside the root');
    assert.equal(await count(path.join(dirs.state, 'approvals')), approvalsBefore, `${dest}: no approval issued`);
    t.diagnostic(`S5 tampered destination ${dest}: exit ${tam.status} ${tam.stderr.trim().split('\n').pop()}`);
  }
  await writeFile(planFile, raw);

  // After plan 3: b.jpg rewritten (same size), 영상/c.mp4 taken by another file → exit 3; those two fail, the rest move.
  const p3 = planOf(ok(cli(['plan', p('work'), '--json']), 'plan 3'));
  const o3 = opsBySource(p3);
  assert.equal(o3['b.jpg']!.destination, '이미지/b.jpg'); assert.equal(o3['c.mp4']!.destination, '영상/c.mp4');
  await writeFile(p('work', 'b.jpg'), 'B-modified'); // same length as 'B-original'
  await mkdir(p('work', '영상'));
  await writeFile(p('work', '영상', 'c.mp4'), 'someone else');
  const pre = await snap(p('work'));
  const r3 = cli(['apply', p3.planId, '--mode', 'organize', '--confirm', codeOf(p3, 'organize'), '--json']);
  assert.equal(r3.status, 3, r3.stderr);
  const st = statusById(reportOf(r3));
  assert.equal(st[o3['b.jpg']!.id], 'failed:FILE_CHANGED');
  assert.equal(st[o3['c.mp4']!.id], 'failed:DEST_EXISTS');
  const post = await snap(p('work'));
  assert.equal(post['b.jpg']!.sha256, sha('B-modified'), 'changed source left in place');
  assert.equal(post['영상/c.mp4']!.sha256, sha('someone else'), 'occupied destination not overwritten');
  assert.equal(post['c.mp4']!.sha256, sha('C'), 'blocked source left in place');
  const movedRest = Object.fromEntries(Object.entries(moveMap(p3)).filter(([s]) => s !== 'b.jpg' && s !== 'c.mp4'));
  assertMoves(pre, post, movedRest, 'rest of plan 3');
  t.diagnostic(`S5 plan 3 results: ${JSON.stringify(st)}`);
});

test('S5 permanent delete re-hashes: candidate or keeper rewritten with the same size and restored mtime → not deleted', async (t) => {
  const ctx = await setup(t, { 'work/p.txt': 'PPPP', 'work/p copy.txt': 'PPPP', 'work/q.txt': 'QQQQ', 'work/q copy.txt': 'QQQQ' });
  const { cli, ok, p } = ctx;
  const pl = planOf(ok(cli(['plan', p('work'), '--delete-duplicates', 'all', '--delete-mode', 'permanent', '--json']), 'plan'));
  const dels = pl.plan.operations.filter((o) => o.kind === 'delete');
  const pc = dels.find((o) => o.source.startsWith('p'))!; const qc = dels.find((o) => o.source.startsWith('q'))!;
  const sneaky = async (rel: string, data: string): Promise<void> => {
    const s = await lstat(p('work', rel));
    await writeFile(p('work', rel), data);
    await utimes(p('work', rel), s.atime, s.mtime); // same size and mtime: only the bytes differ
  };
  await sneaky(pc.source, 'pppp'); // candidate changed: it is no longer a copy of the keeper
  await sneaky(qc.keeper!, 'qqqq'); // keeper changed: deleting the candidate would lose the last 'QQQQ'
  const pre = await snap(p('work'));
  const r = cli(['apply', pl.planId, '--mode', 'permanent-delete', '--confirm', codeOf(pl, 'permanent-delete'), '--phrase', '영구 삭제', '--json']);
  assert.equal(r.status, 3, r.stderr);
  const st = statusById(reportOf(r));
  t.diagnostic(`S5 re-hash results: ${JSON.stringify(st)}`);
  assert.match(st[pc.id]!, /^failed:/u); assert.match(st[qc.id]!, /^failed:/u);
  assert.deepEqual(await snap(p('work')), pre, 'nothing deleted');
});

// ---------- reference inside the work root ----------
test('S1b reference folder inside the work root: its files are never planned, --delete-file on them is refused, apply leaves them', async (t) => {
  const ctx = await setup(t, { 'work/참고/과제/물리/물리_1.pdf': 'r1', 'work/참고/과제/물리/물리_2.pdf': 'r2', 'work/물리_새.pdf': 'n', 'work/z.jpg': 'z' });
  const { cli, ok, p } = ctx;
  const w0 = await snap(p('work'));
  const pl = planOf(ok(cli(['plan', p('work'), '--reference', p('work', '참고'), '--json']), 'plan'));
  assert.ok(pl.plan.operations.every((o) => !o.source.startsWith('참고/')), 'reference files not in the plan');
  const del = cli(['plan', p('work'), '--reference', p('work', '참고'), '--delete-file', '참고/과제/물리/물리_1.pdf']);
  assert.equal(del.status, 1); assert.match(del.stderr, /ROOT_FORBIDDEN/u);
  ok(cli(['apply', pl.planId, '--mode', 'organize', '--confirm', codeOf(pl, 'organize'), '--json']), 'apply');
  const w1 = await snap(p('work'));
  for (const [rel, e] of Object.entries(w0)) if (rel.startsWith('참고')) assert.deepEqual(w1[rel], e, `${rel} preserved`);
  assertMoves(w0, w1, moveMap(pl), 'S1b');
});

// ---------- S6 concurrency, state folder inside the root ----------
test('S6 two concurrent apply processes on one plan: the files move exactly once, the other process changes nothing', async (t) => {
  const spec: Spec = {};
  for (let i = 0; i < 40; i++) spec[`work/f${String(i).padStart(2, '0')}.txt`] = `content ${i}`;
  const ctx = await setup(t, spec);
  const { cli, cliAsync, ok, p, dirs } = ctx;
  const w0 = await snap(p('work'));
  const pl = planOf(ok(cli(['plan', p('work'), '--json']), 'plan'));
  const args = ['apply', pl.planId, '--mode', 'organize', '--confirm', codeOf(pl, 'organize'), '--json'];
  const [r1, r2] = await Promise.all([cliAsync(args), cliAsync(args)]);
  const outcomes = [r1, r2].map((r) => `${r.status} ${/AFO 오류\[(\w+)\]/u.exec(r.stderr)?.[1] ?? ''}`.trim());
  t.diagnostic(`S6 concurrent outcomes: ${outcomes.join(' | ')}`);
  const winners = [r1, r2].filter((r) => r.status === 0);
  assert.equal(winners.length, 1, `exactly one apply succeeds: ${outcomes.join(' | ')}`);
  const loser = r1.status === 0 ? r2 : r1;
  assert.ok(loser.status === 1 || loser.status === 4, `the other is refused (LOCKED_BY_OTHER 1 / APPROVAL_USED 4), got ${outcomes.join(' | ')}`);
  assert.match(loser.stderr, /LOCKED_BY_OTHER|APPROVAL_USED/u);
  assertMoves(w0, await snap(p('work')), moveMap(pl), 'concurrent');
  const runFiles = (await readdir(path.join(dirs.state, 'runs'))).filter((f) => /^[0-9a-f-]{36}\.json$/u.test(f));
  assert.equal(runFiles.length, 1, 'one run record');
  assert.deepEqual(JSON.parse(ok(cli(['recover', '--json']), 'recover').stdout), { checked: 1, runs: [] });
});

test('S6 a state folder inside the work root is refused before anything is written', async (t) => {
  const ctx = await setup(t, { 'work/a.pdf': 'A', 'work/b.jpg': 'B' });
  const { cli, p } = ctx;
  const w0 = await snap(p('work'));
  const inside = { AFO_STATE_DIR: p('work', '.afo-state') };
  const r = cli(['plan', p('work')], inside);
  assert.equal(r.status, 1); assert.match(r.stderr, /STATE_DIR_CONFLICT/u);
  const m = cli(['preview', p('work'), '--move', 'a.pdf=x', '--remember'], inside);
  assert.equal(m.status, 1); assert.match(m.stderr, /STATE_DIR_CONFLICT/u);
  assert.deepEqual(await snap(p('work')), w0, 'no state folder or file created inside the root');
});

// ---------- S7 output honesty without touching the trash ----------
test('S7 trash plan/apply summary does not present a trash move as reclaimed space (refused before execution)', async (t) => {
  const ctx = await setup(t, { 'work/afo-test-s7.txt': 'same', 'work/afo-test-s7 copy.txt': 'same' });
  const { cli, ok, p } = ctx;
  const w0 = await snap(p('work'));
  const human = ok(cli(['plan', p('work'), '--delete-duplicates', 'all']), 'plan');
  assert.match(human.stdout, /확보량 아님/u);
  const pl = planOf(ok(cli(['plan', p('work'), '--delete-duplicates', 'all', '--json']), 'plan json'));
  const r = cli(['apply', pl.planId, '--mode', 'trash']); // no --confirm → refused, summary on stderr
  assert.equal(r.status, 4);
  assert.match(r.stderr, /확보량 아님\. 휴지통으로 보낸 파일은 디스크에 남습니다/u);
  assert.doesNotMatch(r.stderr, /되돌릴 수 없/u);
  assert.deepEqual(await snap(p('work')), w0);
});

// ---------- permission denied during apply ----------
test('S5 permission denied: a source folder made read-only after plan → that move fails, the file stays, the rest move', {
  skip: process.getuid?.() === 0 ? 'root ignores folder permissions' : false,
}, async (t) => {
  const ctx = await setup(t, { 'work/locked/x.pdf': 'X', 'work/y.jpg': 'Y' });
  const { cli, ok, p } = ctx;
  const pl = planOf(ok(cli(['plan', p('work'), '--json']), 'plan'));
  const o = opsBySource(pl);
  t.diagnostic(`S5 permission denied: planned ${JSON.stringify(moveMap(pl))}`);
  const xDest = o['locked/x.pdf']?.destination;
  assert.ok(xDest, 'locked/x.pdf is planned to move');
  await chmod(p('work', 'locked'), 0o555);
  let pre: Snap; let r: Res;
  try { // restore before the fixture cleanup (after-hooks run in registration order)
    pre = await snap(p('work'));
    r = cli(['apply', pl.planId, '--mode', 'organize', '--confirm', codeOf(pl, 'organize'), '--json']);
  } finally { await chmod(p('work', 'locked'), 0o755); }
  assert.equal(r.status, 3, r.stderr);
  const st = statusById(reportOf(r));
  t.diagnostic(`S5 permission denied: ${JSON.stringify(st)}`);
  assert.match(st[o['locked/x.pdf']!.id]!, /^failed/u, 'not unknown: the file is verifiably still at its source');
  assert.equal(st[o['y.jpg']!.id], 'moved');
  const post = await snap(p('work'));
  assert.deepEqual(post['locked/x.pdf'], pre['locked/x.pdf'], 'x.pdf untouched at its source');
  assert.equal(Object.values(post).filter((e) => e.type === 'file' && e.sha256 === sha('X')).length, 1, 'no second copy of x.pdf');
  assertMoves(pre, post, { 'y.jpg': '이미지/y.jpg' }, 'rest');
  assert.deepEqual(JSON.parse(ok(cli(['recover', '--json']), 'recover').stdout), { checked: 1, runs: [] }, 'a clean failure needs no recovery');
});

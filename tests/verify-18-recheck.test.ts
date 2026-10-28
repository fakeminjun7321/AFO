/**
 * #18 re-verification (2026-10-28) of the builder's fixes for F-1 and O-2/O-3/O-4 on origin/feat/18-land.
 * Independent of tests/profiles.test.ts, tests/rules.test.ts, tests/cli-rules.test.ts and tests/verify-18.test.ts: own oracle, own fixtures,
 * hand-written expectations (the product's extension table is not imported). Synthetic temp data only (mkdtemp under os.tmpdir());
 * state lives in a per-test temp folder (stateDir or AFO_STATE_DIR). HOME is an empty temp folder for this process and its children.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAfoError } from '../packages/contracts/src/index.js';
import type { RuleProfile, RuleProfileV2 } from '../packages/contracts/src/index.js';
import { classifyFile, confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { defaultCategory } from '../packages/engine/src/defaults.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant, readReference } from '../packages/filesystem/src/index.js';
import { addCorrection, loadProfile, profileFile, resetProfile, saveConfirmedProfile } from '../packages/filesystem/src/profiles.js';
import type { ProfileStoreOptions } from '../packages/filesystem/src/profiles.js';
import { createFixture } from './fixtures/index.js';
import type { FixtureSpec } from './fixtures/index.js';

const REAL_DEFAULT = path.join(homedir(), 'Library', 'Application Support', 'AFO');
const REAL_DEFAULT_EXISTED = existsSync(REAL_DEFAULT);
const FAKE_HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'afo-test-home-')));
process.env['HOME'] = FAKE_HOME;
delete process.env['AFO_STATE_DIR'];
process.on('exit', () => rmSync(FAKE_HOME, { recursive: true, force: true }));

const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const code = (expected: string) => (error: unknown): boolean => isAfoError(error) && error.code === expected;
type Row = [action: string, destination: string | null, reasonCode: string | undefined];
const table = (items: { source: string; action: string; destination: string | null; reasonCode?: string | undefined }[]): Record<string, Row> =>
  Object.fromEntries(items.map((i) => [i.source, [i.action, i.destination, i.reasonCode]]));
const KEEP: Row = ['keep', null, 'PROTECTED_REFERENCE'];
const CLI = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const modUrl = (rel: string): string => JSON.stringify(new URL(rel, import.meta.url).href);

/** Own oracle: every entry with type, inode, link count, mode, size, mtime, ctime and content hash. Never follows links. */
async function oracle(root: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: [string, string][] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name); const rel = prefix ? `${prefix}/${name}` : name;
      if (skip(rel)) continue;
      const s = await lstat(full, { bigint: true });
      const id = `ino=${s.ino} nlink=${s.nlink} mode=${s.mode} mtime=${s.mtimeNs} ctime=${s.ctimeNs}`;
      if (s.isSymbolicLink()) out.push([rel, `link ${id} -> ${await readlink(full)}`]);
      else if (s.isDirectory()) { out.push([rel, `dir ${id}`]); await visit(full, rel); }
      else out.push([rel, `file ${id} size=${s.size} sha256=${sha(await readFile(full))}`]);
    }
  }
  await visit(root, '');
  return Object.fromEntries(out);
}

interface Env { base: string; state: string; o: ProfileStoreOptions; dir: (rel: string) => string }
async function env(t: TestContext, spec: FixtureSpec): Promise<Env> {
  const { root: base, cleanup } = await createFixture({ ...spec, 'state/': '' });
  t.after(cleanup);
  const state = path.join(base, 'state');
  return { base, state, o: { stateDir: state }, dir: (rel) => path.join(base, ...rel.split('/')) };
}
const prefixed = (prefix: string, files: FixtureSpec): FixtureSpec =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
const notState = (rel: string): boolean => rel === 'state' || rel.startsWith('state/');
async function confirmedFrom(reference: string): Promise<RuleProfile> {
  const draft = suggestProfile(await readReference(await issueReferenceGrant(reference)));
  return confirmProfile(draft, draft.rules.map((r) => r.id));
}
const analyze = async (work: string, options: Parameters<typeof analyzeRoot>[1] = {}) => analyzeRoot(await issueRootGrant(work), options);

/** Reference: two 수학 and two 국어 PDFs (→ 2 keyword rules), a loose memo and a single file that yield no rule. */
const REF = { '수학/수학_과제1.pdf': 'm1', '수학/수학_과제2.pdf': 'm2', '국어/국어_a.pdf': 'k1', '국어/국어_b.pdf': 'k2',
  '메모.txt': 'memo', '기타/단독.hwp': 'solo' };
const REF_NAMES = Object.keys(REF);
const NEW = { '수학_과제5.pdf': 'new5', '국어 감상.pdf': 'newk' };
/** Personal rules applied to NEW (rules active, no stale notice). */
const NEW_PERSONAL: Record<string, Row> = { '수학_과제5.pdf': ['move', '수학/수학_과제5.pdf', 'PERSONAL_RULE'],
  '국어 감상.pdf': ['move', '국어/국어 감상.pdf', 'PERSONAL_RULE'] };
/** Default rules applied to NEW (profile stale, not applied). */
const NEW_DEFAULT: Record<string, Row> = { '수학_과제5.pdf': ['move', '문서/수학_과제5.pdf', 'DEFAULT_EXTENSION'],
  '국어 감상.pdf': ['move', '문서/국어 감상.pdf', 'DEFAULT_EXTENSION'] };
const keptUnder = (prefix: string): Record<string, Row> => Object.fromEntries(REF_NAMES.map((n) => [prefix ? `${prefix}/${n}` : n, KEEP]));

/** Saves the profile of <base>/work/정리 with NEW files beside it, runs `change`, then analyzes `target` with the saved profile. */
async function afterChange(t: TestContext, change: (e: Env) => Promise<void>, target = 'work', extra: FixtureSpec = {}) {
  const e = await env(t, { ...prefixed('work/정리', REF), ...prefixed('work', NEW), ...extra });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('work/정리')), e.o);
  assert.ok(saved.referenceRootIdentity, 'dev/inode recorded at save time');
  await change(e);
  const before = await oracle(e.base);
  const { preview, protected: kept } = await analyze(e.dir(target), { profile: saved, stateDir: e.state });
  assert.deepEqual(await oracle(e.base), before, 'analysis changed nothing (files, folders, state)');
  return { e, preview, kept, rows: table(preview.items) };
}

// ---------------- F-1: reference folder inside the work root changed after saving ----------------

test('R18-01 unchanged reference inside the work root: protected, rules applied, no stale notice (control)', async (t) => {
  const { rows, preview } = await afterChange(t, async () => undefined);
  assert.deepEqual(rows, { ...keptUnder('정리'), ...NEW_PERSONAL });
  assert.equal(preview.profileNotice, undefined);
  assert.notEqual(preview.profileId, null);
});

test('R18-02 reference renamed inside the work root: originals kept, profile stale and not applied', async (t) => {
  const { rows, preview } = await afterChange(t, async (e) => rename(e.dir('work/정리'), e.dir('work/정리2')));
  assert.deepEqual(rows, { ...keptUnder('정리2'), ...NEW_DEFAULT });
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
  assert.match(preview.profileNotice.reason, /이름이나 위치가 바뀌었습니다/u);
  assert.equal(preview.profileId, null); assert.equal(preview.profileRevision, null);
  assert.equal(preview.duplicates.length, 0); assert.deepEqual(preview.largeFiles, []);
});

test('R18-03 reference moved deeper inside the work root: same protection and stale notice', async (t) => {
  const { rows, preview } = await afterChange(t, async (e) => {
    await mkdir(e.dir('work/보관/2026'), { recursive: true }); await rename(e.dir('work/정리'), e.dir('work/보관/2026/정리'));
  });
  assert.deepEqual(rows, { ...keptUnder('보관/2026/정리'), ...NEW_DEFAULT });
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
});

test('R18-04 reference copied inside the work root (new inodes): original and copy kept, stale because evidence appears elsewhere', async (t) => {
  const { rows, preview } = await afterChange(t, async (e) => cp(e.dir('work/정리'), e.dir('work/정리 사본'), { recursive: true }));
  assert.deepEqual(rows, { ...keptUnder('정리'), ...keptUnder('정리 사본'), ...NEW_DEFAULT });
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
  assert.match(preview.profileNotice.reason, /정리 사본/u);
  assert.equal(preview.duplicates.length, 0, 'protected copies are never duplicate candidates');
});

test('R18-05 reference moved out of the work root: work root gets personal rules; the moved folder is protected when analyzed', async (t) => {
  const { e, rows, preview } = await afterChange(t, async (x) => { await mkdir(x.dir('밖')); await rename(x.dir('work/정리'), x.dir('밖/정리')); });
  assert.deepEqual(rows, NEW_PERSONAL, 'nothing of the reference is left in the work root');
  assert.equal(preview.profileNotice, undefined);
  const saved = (await loadProfile(e.o)) as RuleProfileV2;
  await writeFile(e.dir('밖/새 수학_과제.pdf'), 'outside new');
  const outer = (await analyze(e.dir('밖'), { profile: saved, stateDir: e.state })).preview;
  assert.deepEqual(table(outer.items), { ...keptUnder('정리'), '새 수학_과제.pdf': ['move', '문서/새 수학_과제.pdf', 'DEFAULT_EXTENSION'] });
  assert.equal(outer.profileNotice?.code, 'PROFILE_STALE');
  const self = (await analyze(e.dir('밖/정리'), { profile: saved, stateDir: e.state })).preview;
  assert.deepEqual(table(self.items), keptUnder(''));
  assert.equal(self.profileNotice?.code, 'PROFILE_STALE');
});

test('R18-06 reference deleted and restored at the same path from a copy (new inode, like a cross-volume move back): kept and stale', async (t) => {
  const { rows, preview } = await afterChange(t, async (e) => {
    await cp(e.dir('work/정리'), e.dir('backup'), { recursive: true });
    await rm(e.dir('work/정리'), { recursive: true }); await rename(e.dir('backup'), e.dir('work/정리'));
  });
  assert.deepEqual(rows, { ...keptUnder('정리'), ...NEW_DEFAULT });
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
});

test('R18-07 only evidence files renamed (folder itself unchanged): still recognised, protected, rules applied, no notice', async (t) => {
  const { rows, preview } = await afterChange(t, async (e) => {
    await rename(e.dir('work/정리/수학/수학_과제1.pdf'), e.dir('work/정리/수학/수학_과제1_v2.pdf'));
    await rename(e.dir('work/정리/국어/국어_a.pdf'), e.dir('work/정리/국어/국어_a (수정).pdf'));
  });
  assert.deepEqual(rows, { '정리/수학/수학_과제1_v2.pdf': KEEP, '정리/수학/수학_과제2.pdf': KEEP, '정리/국어/국어_a (수정).pdf': KEEP,
    '정리/국어/국어_b.pdf': KEEP, '정리/메모.txt': KEEP, '정리/기타/단독.hwp': KEEP, ...NEW_PERSONAL });
  assert.equal(preview.profileNotice, undefined);
});

test('R18-08 renamed reference AND renamed evidence: still recognised by dev/inode', async (t) => {
  const { rows, preview } = await afterChange(t, async (e) => {
    for (const n of ['수학/수학_과제1.pdf', '수학/수학_과제2.pdf', '국어/국어_a.pdf', '국어/국어_b.pdf'])
      await rename(e.dir(`work/정리/${n}`), e.dir(`work/정리/${n.replace('.pdf', '_old.pdf')}`));
    await rename(e.dir('work/정리'), e.dir('work/예전 정리'));
  });
  for (const [source, row] of Object.entries(rows)) if (source.startsWith('예전 정리/')) assert.deepEqual(row, KEEP, source);
  assert.equal(Object.keys(rows).filter((s) => s.startsWith('예전 정리/')).length, 6);
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
});

test('R18-09 one evidence example copied elsewhere is not enough; two are (protected + stale)', async (t) => {
  const one = await afterChange(t, async (e) => {
    await mkdir(e.dir('work/다른/수학'), { recursive: true });
    await cp(e.dir('work/정리/수학/수학_과제1.pdf'), e.dir('work/다른/수학/수학_과제1.pdf'));
  });
  assert.deepEqual(one.rows, { ...keptUnder('정리'), ...NEW_PERSONAL, '다른/수학/수학_과제1.pdf': ['move', '수학/수학_과제1.pdf', 'PERSONAL_RULE'] });
  assert.equal(one.preview.profileNotice, undefined);
  const two = await afterChange(t, async (e) => {
    await mkdir(e.dir('work/다른/국어'), { recursive: true });
    await cp(e.dir('work/정리/국어/국어_a.pdf'), e.dir('work/다른/국어/국어_a.pdf'));
    await cp(e.dir('work/정리/국어/국어_b.pdf'), e.dir('work/다른/국어/국어_b.pdf'));
    await writeFile(e.dir('work/다른/새.txt'), 'unrelated');
  });
  assert.deepEqual(two.rows, { ...keptUnder('정리'), ...NEW_DEFAULT, '다른/국어/국어_a.pdf': KEEP, '다른/국어/국어_b.pdf': KEEP, '다른/새.txt': KEEP });
  assert.match(two.preview.profileNotice?.reason ?? '', /다른/u);
});

test('R18-10 draft read, folder renamed BEFORE rules save (no identity recorded): evidence fallback still protects', async (t) => {
  const e = await env(t, { ...prefixed('work/정리', REF), ...prefixed('work', NEW) });
  const confirmed = await confirmedFrom(e.dir('work/정리'));
  await rename(e.dir('work/정리'), e.dir('work/정리2'));
  const saved = await saveConfirmedProfile(confirmed, e.o);
  assert.equal(saved.referenceRootIdentity ?? null, null, 'path gone at save time: no identity');
  const { preview } = await analyze(e.dir('work'), { profile: saved, stateDir: e.state });
  assert.deepEqual(table(preview.items), { ...keptUnder('정리2'), ...NEW_DEFAULT });
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
});

test('R18-11 reference path given with different letter case / NFD at save time: no false stale notice', async (t) => {
  const e = await env(t, { ...prefixed('work/Ref정리', REF), ...prefixed('work', NEW) });
  const variant = path.join(e.base, 'work', 'REF정리'.normalize('NFD'));
  const saved = await saveConfirmedProfile(await confirmedFrom(variant), e.o);
  const { preview } = await analyze(e.dir('work'), { profile: saved, stateDir: e.state });
  assert.deepEqual(table(preview.items), { ...keptUnder('Ref정리'), ...NEW_PERSONAL });
  assert.equal(preview.profileNotice, undefined);
});

/** Observation O-5: a work root that merely contains two evidence names at its top level is treated as a copy of the reference. */
test('R18-12 unrelated work root holding two evidence names at top level: whole root protected and stale (safe-side, recorded as O-5)', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF), 'work/수학/수학_과제1.pdf': 'other bytes 1', 'work/수학/수학_과제2.pdf': 'other bytes 2',
    'work/노래.mp3': 'song', 'work/설치.dmg': 'dmg' });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  const { preview } = await analyze(e.dir('work'), { profile: saved, stateDir: e.state });
  assert.deepEqual(table(preview.items), { '수학/수학_과제1.pdf': KEEP, '수학/수학_과제2.pdf': KEEP, '노래.mp3': KEEP, '설치.dmg': KEEP });
  assert.match(preview.profileNotice?.reason ?? '', /작업 폴더 자체/u);
});

test('R18-13 V18-12a judgement: renamed external reference analysed as the work root keeps every file, including ones no rule covers', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF), 'work2/국어_c.pdf': 'c', 'ref/영상.mov': '' });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  const original = (await analyze(e.dir('ref'), { profile: saved, stateDir: e.state })).preview;
  assert.deepEqual(table(original.items), { ...keptUnder(''), '영상.mov': KEEP });
  assert.equal(original.profileNotice, undefined, 'unchanged folder: no notice');
  await rename(e.dir('ref'), e.dir('ref-renamed'));
  const before = await oracle(e.base);
  const renamed = (await analyze(e.dir('ref-renamed'), { profile: saved, stateDir: e.state })).preview;
  // Under the old expectation (ALREADY_PLACED) 메모.txt, 기타/단독.hwp and 영상.mov would have been default-rule moves.
  assert.deepEqual(table(renamed.items), { ...keptUnder(''), '영상.mov': KEEP });
  assert.equal(renamed.profileNotice?.code, 'PROFILE_STALE');
  assert.deepEqual(table((await analyze(e.dir('work2'), { profile: saved, stateDir: e.state })).preview.items),
    { '국어_c.pdf': ['move', '국어/국어_c.pdf', 'PERSONAL_RULE'] }, 'an unrelated work root still gets the rules, no notice');
  assert.deepEqual(await oracle(e.base), before);
});

test('R18-14 a stale analysis writes nothing to the store (profile stays confirmed, same bytes)', async (t) => {
  const { e } = await afterChange(t, async (x) => rename(x.dir('work/정리'), x.dir('work/정리2')));
  const raw = await readFile(profileFile(e.state));
  await analyze(e.dir('work'), { profile: (await loadProfile(e.o)) as RuleProfileV2, stateDir: e.state });
  assert.deepEqual(await readFile(profileFile(e.state)), raw);
  assert.equal(((await loadProfile(e.o)) as RuleProfileV2).status, 'confirmed');
});

// ---------------- O-2: state folder overlapping work / reference folders ----------------

test('R18-15 state folder overlap is refused before scanning: inside, equal, containing, inside reference, symlink and case variants', async (t) => {
  const e = await env(t, { 'work/a.pdf': 'a', 'work/appstate/x.json': '{}', 'ref/수학/수학_1.pdf': '1', 'ref/수학/수학_2.pdf': '2', 'outer/w/b.pdf': 'b' });
  await symlink(e.dir('work/appstate'), e.dir('link-to-appstate'));
  const before = await oracle(e.base);
  const work = await issueRootGrant(e.dir('work'));
  const reference = await issueReferenceGrant(e.dir('ref'));
  for (const stateDir of [e.dir('work/appstate'), e.dir('work/not-yet/created'), e.dir('work'), e.base, e.dir('link-to-appstate'),
    path.join(e.base, 'WORK', 'appstate')])
    await assert.rejects(analyzeRoot(work, { stateDir }), code('STATE_DIR_CONFLICT'), stateDir);
  for (const stateDir of [e.dir('ref/state'), e.dir('ref'), e.dir('ref/수학')])
    await assert.rejects(analyzeRoot(work, { stateDir, reference }), code('STATE_DIR_CONFLICT'), stateDir);
  await assert.rejects(analyzeRoot(await issueRootGrant(e.dir('outer/w')), { stateDir: e.dir('outer') }), code('STATE_DIR_CONFLICT'));
  // Control: a separate state folder is accepted.
  assert.equal((await analyzeRoot(work, { stateDir: e.state, reference })).preview.items.length, 2);
  assert.deepEqual(await oracle(e.base), before, 'nothing created (not-yet/created stays absent)');
});

test('R18-16 AFO_STATE_DIR and the default OS path are honoured when no stateDir option is given', async (t) => {
  const e = await env(t, { 'work/a.pdf': 'a', 'ref/수학/수학_1.pdf': '1' });
  const work = await issueRootGrant(e.dir('work'));
  const reference = await issueReferenceGrant(e.dir('ref'));
  const before = await oracle(e.base);
  t.after(() => { delete process.env['AFO_STATE_DIR']; process.env['HOME'] = FAKE_HOME; });
  process.env['AFO_STATE_DIR'] = e.dir('work/.afo');
  await assert.rejects(analyzeRoot(work), code('STATE_DIR_CONFLICT'));
  process.env['AFO_STATE_DIR'] = e.dir('ref/.afo');
  await assert.rejects(analyzeRoot(work, { reference }), code('STATE_DIR_CONFLICT'));
  process.env['AFO_STATE_DIR'] = e.state;
  assert.equal((await analyzeRoot(work, { reference })).preview.items.length, 1);
  // Default path: HOME/Library/Application Support/AFO. With HOME = the work root's folder it lies inside the work root.
  delete process.env['AFO_STATE_DIR'];
  process.env['HOME'] = e.dir('work');
  await assert.rejects(analyzeRoot(work), code('STATE_DIR_CONFLICT'));
  process.env['HOME'] = FAKE_HOME;
  assert.equal((await analyzeRoot(work)).preview.items.length, 1, 'default path outside the work root is accepted');
  assert.deepEqual(await oracle(e.base), before);
  assert.deepEqual(await readdir(FAKE_HOME), [], 'analysis never creates the default state folder');
});

// ---------------- O-3: one-off override destinations ----------------

test('R18-17 one-off override: hidden, .., absolute, reserved and malformed folders refused; valid folders move; nothing written', async (t) => {
  const e = await env(t, { 'work/과제.pdf': 'p', 'work/정리/수학/수학_1.pdf': '1', 'work/정리/수학/수학_2.pdf': '2' });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('work/정리')), e.o);
  const before = await oracle(e.base);
  const first = (await analyze(e.dir('work'), { stateDir: e.state })).preview;
  const id = first.items.find((i) => i.source === '과제.pdf')!.fileId;
  const bad = ['.숨김', '보관/.git', '정리/.x/y', '..', '../밖', '보관/../..', './보관', '/tmp/afo-x', e.dir('outside'), 'C:/x', 'C:\\x', '보관\\하위',
    'CON', 'nul', 'aux/하위', 'LPT1.txt', 'com9', '', '보관/', '보관.', '보관 ', 'a\u0000b', 'x'.repeat(5000)];
  for (const target of bad)
    await assert.rejects(analyze(e.dir('work'), { stateDir: e.state, overrides: { [id]: target } }), Error, JSON.stringify(target).slice(0, 40));
  const ok: [string, Row][] = [['숙제', ['move', '숙제/과제.pdf', 'USER_OVERRIDE']], ['2학기/숙제 폴더', ['move', '2학기/숙제 폴더/과제.pdf', 'USER_OVERRIDE']],
    ['a..b', ['move', 'a..b/과제.pdf', 'USER_OVERRIDE']], ['console', ['move', 'console/과제.pdf', 'USER_OVERRIDE']]];
  for (const [target, row] of ok)
    assert.deepEqual(table((await analyze(e.dir('work'), { stateDir: e.state, overrides: { [id]: target } })).preview.items)['과제.pdf'], row, target);
  // An override never moves a protected reference original, even pointing at a valid folder.
  const refId = first.items.find((i) => i.source === '정리/수학/수학_1.pdf')!.fileId;
  const withProfile = (await analyze(e.dir('work'), { stateDir: e.state, profile: saved, overrides: { [refId]: '보관' } })).preview;
  assert.deepEqual(table(withProfile.items)['정리/수학/수학_1.pdf'], KEEP);
  assert.deepEqual(await oracle(e.base), before, 'refused and accepted overrides wrote nothing (state included)');
});

test('R18-18 CLI --move refuses hidden, .., absolute and reserved folders with exit 2 and writes nothing', async (t) => {
  const e = await env(t, { 'work/과제.pdf': 'p' });
  const before = await oracle(e.base);
  for (const target of ['.숨김', '..', '../밖', '/tmp/afo-x', 'CON', '보관/.git', 'a\\b']) for (const extra of [[], ['--remember']]) {
    const r = spawnSync(process.execPath, [CLI, 'preview', e.dir('work'), '--move', `과제.pdf=${target}`, ...extra],
      { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: e.state, HOME: FAKE_HOME } });
    assert.equal(r.status, 2, `${target} ${extra.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(await oracle(e.base), before);
});

// ---------------- O-4: expectedRevision null / expectedCorrupt across processes ----------------

/** Runs `body` in `n` node processes that start the call at the same wall-clock instant. Returns each process's JSON line. */
async function race(n: number, state: string, body: (i: number) => string, pre: (i: number) => string = () => ''): Promise<{ ok: boolean; code?: string; revision?: number; id?: string }[]> {
  const startAt = Date.now() + 1200;
  const runs = Array.from({ length: n }, (_, i) => new Promise<string>((resolve, reject) => {
    const script = `import * as store from ${modUrl('../packages/filesystem/src/profiles.js')};
      const o = { stateDir: ${JSON.stringify(state)} };
      const fp = JSON.parse(process.argv[1] ?? 'null');
      ${pre(i)}
      while (Date.now() < ${startAt}) {}
      try { const r = await (async () => { ${body(i)} })(); console.log(JSON.stringify({ ok: true, revision: r?.revision, id: r?.id })); }
      catch (e) { console.log(JSON.stringify({ ok: false, code: e.code ?? e.message })); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, process.env['AFO_RACE_FP'] ?? 'null'],
      { env: { ...process.env, HOME: FAKE_HOME } });
    let out = ''; let err = '';
    child.stdout.on('data', (d: Buffer) => { out += String(d); }); child.stderr.on('data', (d: Buffer) => { err += String(d); });
    child.on('error', reject); child.on('close', (status) => status === 0 ? resolve(out) : reject(new Error(err)));
  }));
  return (await Promise.all(runs)).map((o) => JSON.parse(o.trim()) as { ok: boolean; code?: string });
}

test('R18-19 sequential pins: null on empty, revision on active, fingerprint on corrupt; any mismatch is PROFILE_CHANGED with no write', async (t) => {
  const e = await env(t, { 'ref/수학/수학_1.pdf': '1', 'ref/수학/수학_2.pdf': '2' });
  const v1 = await confirmedFrom(e.dir('ref'));
  await assert.rejects(saveConfirmedProfile(v1, { ...e.o, expectedRevision: 0 }), code('PROFILE_CHANGED'), 'empty store is null, not 0');
  await assert.rejects(resetProfile({ ...e.o, expectedCorrupt: 'a'.repeat(32) }), code('PROFILE_CHANGED'));
  assert.deepEqual(await readdir(e.state), []);
  const saved = await saveConfirmedProfile(v1, { ...e.o, expectedRevision: null });
  const raw = await readFile(profileFile(e.state));
  await assert.rejects(addCorrection({ type: 'file-name', name: 'a.pdf' }, '보관', { ...e.o, expectedRevision: null }), code('PROFILE_CHANGED'));
  await assert.rejects(resetProfile({ ...e.o, expectedRevision: saved.revision, expectedCorrupt: 'x' }), code('PROFILE_CHANGED'));
  assert.deepEqual(await readFile(profileFile(e.state)), raw);
  await writeFile(profileFile(e.state), '{"formatVersion": 2, "state": "act');
  const corrupt = await loadProfile(e.o);
  assert.ok(corrupt !== null && corrupt.status === 'corrupt');
  await assert.rejects(resetProfile({ ...e.o, expectedRevision: saved.revision }), code('PROFILE_CHANGED'));
  await assert.rejects(resetProfile({ ...e.o, expectedRevision: null }), code('PROFILE_CHANGED'));
  await writeFile(profileFile(e.state), '{"formatVersion": 2, "state": "xxx'); // replaced by another damaged file
  await assert.rejects(resetProfile({ ...e.o, expectedCorrupt: corrupt.fingerprint }), code('PROFILE_CHANGED'), 'old fingerprint');
  assert.deepEqual((await readdir(path.join(e.state, 'profiles'))).sort(), ['active.json']);
});

/** Finding F-2: no cross-process lock; both racers pass the expectedRevision check and both report success. */
test('R18-20 two processes save the first profile at once (expectedRevision: null): exactly one may succeed', { todo: 'F-2' }, async (t) => {
  const tally: string[] = [];
  for (let round = 0; round < 8; round++) {
    const e = await env(t, {});
    const results = await race(2, e.state, (i) =>
      `return store.addCorrection({ type: 'file-name', name: 'p${i}.pdf' }, '보관${i}', { ...o, expectedRevision: null });`);
    const stored = (await loadProfile(e.o)) as RuleProfileV2;
    tally.push(`${results.filter((r) => r.ok).length}ok:${results.map((r) => r.ok ? `${r.id?.slice(0, 14)}@${r.revision}` : r.code).join(',')}` +
      ` stored=${stored.id.slice(0, 14)}@${stored.revision} corrections=${stored.corrections.length}`);
  }
  t.diagnostic(tally.join(' | '));
  for (const line of tally) assert.ok(line.startsWith('1ok'), `both processes were told their first save succeeded: ${line}`);
});

test('R18-21 two processes reset the same damaged file at once: its bytes are kept exactly once, final state empty', async (t) => {
  const tally: string[] = [];
  for (let round = 0; round < 8; round++) {
    const e = await env(t, {});
    await mkdir(path.join(e.state, 'profiles'), { recursive: true });
    const damaged = `{"broken": ${round}`;
    await writeFile(profileFile(e.state), damaged);
    const seen = await loadProfile(e.o);
    assert.ok(seen !== null && seen.status === 'corrupt');
    process.env['AFO_RACE_FP'] = JSON.stringify(seen.fingerprint);
    const results = await race(2, e.state, () => 'return store.resetProfile({ ...o, expectedCorrupt: fp });');
    delete process.env['AFO_RACE_FP'];
    const names = (await readdir(path.join(e.state, 'profiles'))).sort();
    const aside = names.filter((n) => n.startsWith('corrupt-'));
    assert.equal(aside.length, 1, names.join(','));
    assert.equal(await readFile(path.join(e.state, 'profiles', aside[0]!), 'utf8'), damaged, 'damaged bytes preserved');
    assert.equal(await loadProfile(e.o), null, 'final state: empty');
    tally.push(`${results.filter((r) => r.ok).length}ok:${results.map((r) => r.ok ? 'ok' : r.code).join(',')}`);
  }
  t.diagnostic(tally.join(' | '));
});

/** Finding F-2 (same cause): a save and a reset racing over one damaged file both report success; one of them is silently lost. */
test('R18-22 save and reset race over one damaged file: exactly one may succeed', { todo: 'F-2' }, async (t) => {
  const tally: string[] = [];
  for (let round = 0; round < 8; round++) {
    const e = await env(t, { 'ref/수학/수학_1.pdf': '1', 'ref/수학/수학_2.pdf': '2' });
    const v1 = await confirmedFrom(e.dir('ref'));
    await mkdir(path.join(e.state, 'profiles'), { recursive: true });
    await writeFile(profileFile(e.state), '[1, 2');
    const seen = await loadProfile(e.o);
    assert.ok(seen !== null && seen.status === 'corrupt');
    await writeFile(path.join(e.base, 'v1.json'), JSON.stringify(v1));
    process.env['AFO_RACE_FP'] = JSON.stringify(seen.fingerprint);
    // The save input is read before the start barrier so both calls begin at the same instant.
    const results = await race(2, e.state, (i) => i === 0 ? 'return store.saveConfirmedProfile(v1, { ...o, expectedCorrupt: fp });'
      // The reset starts 0–7 ms later per round so the windows of the two calls overlap at different points.
      : `const until = Date.now() + ${round}; while (Date.now() < until) {} return store.resetProfile({ ...o, expectedCorrupt: fp });`,
    (i) => i === 0 ? `const fs = await import('node:fs/promises'); const v1 = JSON.parse(await fs.readFile(${JSON.stringify(path.join(e.base, 'v1.json'))}, 'utf8'));` : '');
    delete process.env['AFO_RACE_FP'];
    const final = await loadProfile(e.o);
    const aside = (await readdir(path.join(e.state, 'profiles'))).filter((n) => n.startsWith('corrupt-'));
    assert.equal(aside.length, 1, 'damaged file kept once');
    tally.push(`${results.filter((r) => r.ok).length}ok save=${results[0]!.ok ? 'ok' : results[0]!.code} reset=${results[1]!.ok ? 'ok' : results[1]!.code}` +
      ` final=${final === null ? 'empty' : final.status}`);
  }
  t.diagnostic(tally.join(' | '));
  for (const line of tally) assert.ok(line.startsWith('1ok'), line);
});

// ---------------- CLI process: stale warning ----------------

test('R18-23 CLI preview after renaming the saved reference: one warning line, originals kept, defaults used, store untouched', async (t) => {
  const e = await env(t, { ...prefixed('work/정리', REF), ...prefixed('work', NEW) });
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: e.state, HOME: FAKE_HOME } });
  const draft = run('suggest-rules', e.dir('work/정리'), '--json');
  assert.equal(draft.status, 0, draft.stderr);
  await writeFile(e.dir('draft.json'), draft.stdout);
  const ids = (JSON.parse(draft.stdout) as RuleProfile).rules.map((r) => r.id);
  assert.equal(ids.length, 2);
  assert.equal(run('rules', 'save', e.dir('draft.json'), '--select', ids.join(',')).status, 0);
  const fresh = run('preview', e.dir('work'));
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.ok(!fresh.stdout.includes('경고:'), 'no warning before the rename');
  assert.ok(fresh.stdout.includes('[이동 제안] 수학_과제5.pdf → 수학/수학_과제5.pdf'));
  await rename(e.dir('work/정리'), e.dir('work/정리2'));
  const raw = await readFile(profileFile(e.state));
  const before = await oracle(e.base);
  const r = run('preview', e.dir('work'));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const warnings = lines.filter((l) => l.startsWith('경고:'));
  t.diagnostic(`stdout head: ${JSON.stringify(lines.slice(0, 4))} stderr: ${JSON.stringify(r.stderr)}`);
  assert.equal(warnings.length, 1, r.stdout);
  assert.match(warnings[0]!, /이름이나 위치가 바뀌었습니다/u);
  for (const n of REF_NAMES) assert.ok(lines.includes(`[유지] 정리2/${n}`), n);
  assert.ok(!lines.some((l) => l.startsWith('[이동 제안] 정리2/')));
  assert.ok(lines.includes('[이동 제안] 수학_과제5.pdf → 문서/수학_과제5.pdf'));
  const json = run('preview', e.dir('work'), '--json');
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout) as { preview: { profileNotice?: { code: string }; profileId: string | null } };
  assert.equal(parsed.preview.profileNotice?.code, 'PROFILE_STALE');
  assert.equal(parsed.preview.profileId, null);
  assert.deepEqual(await readFile(profileFile(e.state)), raw, 'preview wrote nothing to the store');
  assert.deepEqual(await oracle(e.base), before);
});

/** Finding F-3 (minor): the profile line still says the saved profile was applied although the stale profile was not applied. */
test('R18-24 CLI preview profile line must not claim the stale profile was applied', { todo: 'F-3' }, async (t) => {
  const e = await env(t, { ...prefixed('work/정리', REF), ...prefixed('work', NEW) });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('work/정리')), e.o);
  await rename(e.dir('work/정리'), e.dir('work/정리2'));
  const r = spawnSync(process.execPath, [CLI, 'preview', e.dir('work')],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: e.state, HOME: FAKE_HOME } });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('개인 규칙:'));
  t.diagnostic(`profile line: ${line}`);
  assert.notEqual(line, `개인 규칙: 저장된 프로필 적용(revision ${saved.revision})`);
});

test('R18-25 CLI preview with AFO_STATE_DIR inside the work root or the reference: STATE_DIR_CONFLICT, exit 1, nothing created', async (t) => {
  const e = await env(t, { 'work/a.pdf': 'a', 'ref/b.pdf': 'b' });
  const before = await oracle(e.base);
  for (const [state, extra] of [[e.dir('work/.afo-state'), []], [e.dir('ref/.afo-state'), ['--reference', e.dir('ref')]]] as const) {
    const r = spawnSync(process.execPath, [CLI, 'preview', e.dir('work'), ...extra],
      { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: state, HOME: FAKE_HOME } });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /^AFO 오류\[STATE_DIR_CONFLICT\]/u);
  }
  assert.deepEqual(await oracle(e.base), before);
});

// ---------------- shared default table (.tar.gz/.tgz moved to defaults.ts) ----------------

/** [name, category, reason] written by hand from the documented default rules. */
const DEFAULTS: [string, string | null, string][] = [
  ['archive.tar.gz', '압축', 'DEFAULT_EXTENSION'], ['BIG.TAR.GZ', '압축', 'DEFAULT_EXTENSION'], ['backup.tgz', '압축', 'DEFAULT_EXTENSION'],
  ['X.TGZ', '압축', 'DEFAULT_EXTENSION'], ['a.gz', '압축', 'DEFAULT_EXTENSION'], ['a.tar', '압축', 'DEFAULT_EXTENSION'],
  ['tar.gz', '압축', 'DEFAULT_EXTENSION'], ['v1.2.zip', '압축', 'DEFAULT_EXTENSION'], ['my.report.pdf', '문서', 'DEFAULT_EXTENSION'],
  ['report.pdf.exe', null, 'COMPOUND_EXTENSION'], ['SETUP.PDF.EXE', null, 'COMPOUND_EXTENSION'], ['photo.jpg.gz', null, 'COMPOUND_EXTENSION'],
  ['data.tar.zip', null, 'COMPOUND_EXTENSION'], ['a.tar.tgz', null, 'COMPOUND_EXTENSION'], ['archive.tar.gz.exe', null, 'COMPOUND_EXTENSION'],
  ['noext', null, 'NO_EXTENSION'], ['x.zzz', null, 'UNKNOWN_EXTENSION'], ['문서.hwpx', '문서', 'DEFAULT_EXTENSION'],
];

test('R18-26 browser defaultCategory, engine classifyFile and the CLI process agree on archives and compound names', async (t) => {
  for (const [name, category, reason] of DEFAULTS) {
    assert.deepEqual(defaultCategory(name), { category, reason }, `defaults.ts ${name}`);
    const c = classifyFile(name);
    assert.deepEqual([c.category, c.reasonCode], [category, reason], `classifyFile ${name}`);
  }
  const e = await env(t, Object.fromEntries(DEFAULTS.map(([name], i) => [`work/${name}`, `content ${i}`])));
  const r = spawnSync(process.execPath, [CLI, 'preview', e.dir('work'), '--json', '--no-saved-rules'],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: e.state, HOME: FAKE_HOME } });
  assert.equal(r.status, 0, r.stderr);
  const rows = table((JSON.parse(r.stdout) as { preview: { items: Parameters<typeof table>[0] } }).preview.items);
  assert.deepEqual(rows, Object.fromEntries(DEFAULTS.map(([name, category, reason]) =>
    [name, category === null ? ['review', null, reason] : ['move', `${category}/${name}`, reason]])));
});

test('R18-27 personal rules: report.pdf.exe stays review under an .exe rule; .tar.gz follows a learned .gz rule', async (t) => {
  const e = await env(t, { 'ref/프로그램/a.exe': 'a', 'ref/프로그램/b.exe': 'b', 'ref/백업/1.tar.gz': '1', 'ref/백업/2.tar.gz': '2',
    'work/report.pdf.exe': 'r', 'work/setup.exe': 's', 'work/x.tar.gz': 'x', 'work/y.tgz': 'y' });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  assert.deepEqual(saved.rules.map((r) => [r.extension, r.keyword, r.targetDirectory]).sort(), [['.exe', null, '프로그램'], ['.gz', null, '백업']]);
  const { preview } = await analyze(e.dir('work'), { profile: saved, stateDir: e.state });
  assert.deepEqual(table(preview.items), { 'report.pdf.exe': ['review', null, 'COMPOUND_EXTENSION'], 'setup.exe': ['move', '프로그램/setup.exe', 'PERSONAL_RULE'],
    'x.tar.gz': ['move', '백업/x.tar.gz', 'PERSONAL_RULE'], 'y.tgz': ['move', '압축/y.tgz', 'DEFAULT_EXTENSION'] });
});

test('R18-28 environment guard: the real default state folder and the fake HOME were not touched', () => {
  assert.equal(existsSync(REAL_DEFAULT), REAL_DEFAULT_EXISTED);
});

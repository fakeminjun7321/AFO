/**
 * #18 verifier tests (independent of the builder's tests/profiles.test.ts and tests/rules.test.ts).
 * Synthetic temp data only (mkdtemp under os.tmpdir()). State lives in a per-test temp folder passed as stateDir or AFO_STATE_DIR.
 * HOME is replaced by an empty temp folder for this process and its children, so a stray default state path lands there (and is detected)
 * instead of the real ~/Library/Application Support/AFO. Every expected value is written by hand; the product's extension table is not imported.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { isAfoError } from '../packages/contracts/src/index.js';
import type { RuleProfile, RuleProfileV2 } from '../packages/contracts/src/index.js';
import { buildPreview, confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant, readReference } from '../packages/filesystem/src/index.js';
import { addCorrection, disableProfile, enableProfile, loadProfile, profileFile, removeCorrection, resetProfile, saveConfirmedProfile,
  setRuleEnabled } from '../packages/filesystem/src/profiles.js';
import type { ProfileStoreOptions } from '../packages/filesystem/src/profiles.js';
import { createFixture } from './fixtures/index.js';
import type { FixtureSpec } from './fixtures/index.js';

// ---- environment guard (evaluated before anything resolves a default state folder) ----
const REAL_DEFAULT = path.join(homedir(), 'Library', 'Application Support', 'AFO');
const REAL_DEFAULT_EXISTED = existsSync(REAL_DEFAULT);
const REAL_HOME = homedir();
const FAKE_HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'afo-test-home-')));
process.env['HOME'] = FAKE_HOME;
process.on('exit', () => rmSync(FAKE_HOME, { recursive: true, force: true }));

const posix = process.platform !== 'win32';
const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const code = (expected: string) => (error: unknown): boolean => isAfoError(error) && error.code === expected;
type Row = [action: string, destination: string | null, reasonCode: string | undefined];
const table = (items: { source: string; action: string; destination: string | null; reasonCode?: string | undefined }[]): Record<string, Row> =>
  Object.fromEntries(items.map((i) => [i.source, [i.action, i.destination, i.reasonCode]]));
const asSaved = (value: Awaited<ReturnType<typeof loadProfile>>): RuleProfileV2 => {
  assert.ok(value !== null && value.status !== 'corrupt', `expected a saved profile, got ${JSON.stringify(value)}`);
  return value as RuleProfileV2;
};

/**
 * Independent oracle: every entry (hidden included) with type, inode, link count, mode, size, mtime, ctime and content hash;
 * directories with inode/mtime/ctime; links with their target. Never follows links. Unreadable files are recorded as such.
 */
async function oracle(root: string): Promise<Record<string, string>> {
  const out: [string, string][] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name); const rel = prefix ? `${prefix}/${name}` : name;
      const s = await lstat(full, { bigint: true });
      const id = `ino=${s.ino} nlink=${s.nlink} mode=${s.mode} mtime=${s.mtimeNs} ctime=${s.ctimeNs}`;
      if (s.isSymbolicLink()) out.push([rel, `link ${id} -> ${await readlink(full)}`]);
      else if (s.isDirectory()) { out.push([rel, `dir ${id}`]); await visit(full, rel); }
      else if (s.isFile()) {
        let hash: string;
        try { hash = sha(await readFile(full)); } catch (error) { hash = `unreadable:${String((error as NodeJS.ErrnoException).code)}`; }
        out.push([rel, `file ${id} size=${s.size} sha256=${hash}`]);
      } else out.push([rel, `other ${id}`]);
    }
  }
  await visit(root, '');
  return Object.fromEntries(out);
}

interface Env { base: string; state: string; o: ProfileStoreOptions; dir: (rel: string) => string }
/** One temp base folder per test: arbitrary sub-folders from `spec` plus an empty state folder. */
async function env(t: TestContext, spec: FixtureSpec): Promise<Env> {
  const { root: base, cleanup } = await createFixture({ ...spec, 'state/': '' });
  t.after(async () => { if (posix) await chmodAll(base); await cleanup(); });
  const state = path.join(base, 'state');
  return { base, state, o: { stateDir: state }, dir: (rel) => path.join(base, ...rel.split('/')) };
}
async function chmodAll(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name); const s = await lstat(full);
    if (s.isSymbolicLink()) continue;
    await chmod(full, s.isDirectory() ? 0o755 : 0o644).catch(() => undefined);
    if (s.isDirectory()) await chmodAll(full);
  }
}
const prefixed = (prefix: string, files: FixtureSpec): FixtureSpec =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
const without = (o: Record<string, string>, prefix: string): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== prefix && !k.startsWith(`${prefix}/`)));

async function confirmedFrom(reference: string, keep?: (r: RuleProfile['rules'][number]) => boolean): Promise<RuleProfile> {
  const draft = suggestProfile(await readReference(await issueReferenceGrant(reference)));
  return confirmProfile(draft, draft.rules.filter((r) => keep ? keep(r) : true).map((r) => r.id));
}
const analyze = async (work: string, options: Parameters<typeof analyzeRoot>[1] = {}) => analyzeRoot(await issueRootGrant(work), options);
const ruleIdFor = (profile: RuleProfileV2, target: string): string => {
  const rule = profile.rules.find((r) => r.targetDirectory === target);
  assert.ok(rule, `rule for ${target}`); return rule.id;
};

// ---- hand-written fixtures and expectations ----
/** Subject-named reference folder. 과학 has one file (not enough evidence); 메모.txt is loose; misc/x.txt is alone. */
const REF_SUBJECT = { '수학/수학_과제1.pdf': 'm1', '수학/수학_과제2.pdf': 'm2', '국어/국어_독후감.pdf': 'k1', '국어/국어 요약.pdf': 'k2',
  '과학/실험보고서.pdf': 's1', '사진/a.png': 'p1', '사진/b.png': 'p2', '메모.txt': 'memo', 'misc/x.txt': 'x' };
/** (extension, keyword, target, evidence) the reference must yield, nothing more. */
const SUBJECT_RULES = [
  ['.pdf', '국어', '국어', ['국어/국어 요약.pdf', '국어/국어_독후감.pdf']],
  ['.pdf', '수학', '수학', ['수학/수학_과제1.pdf', '수학/수학_과제2.pdf']],
  ['.png', null, '사진', ['사진/a.png', '사진/b.png']],
];
const WORK_SUBJECT = { '수학_과제3.pdf': 'w1', '국어 감상문.pdf': 'w2', '수학국어_통합.pdf': 'w3', '과학_실험2.pdf': 'w4', '스크린샷.PNG': 'w5',
  '노래.mp3': 'w6', '설치.dmg': 'w7', 'backup.tgz': 'w8', '영상.MOV': 'w9', 'README': 'w10', 'data.xyz': 'w11', 'report.pdf.exe': 'w12',
  '수학/수학_기존.pdf': 'w13' };
/** No reference / no profile: default rules only. */
const DEFAULT_SUBJECT: Record<string, Row> = {
  '수학_과제3.pdf': ['move', '문서/수학_과제3.pdf', 'DEFAULT_EXTENSION'], '국어 감상문.pdf': ['move', '문서/국어 감상문.pdf', 'DEFAULT_EXTENSION'],
  '수학국어_통합.pdf': ['move', '문서/수학국어_통합.pdf', 'DEFAULT_EXTENSION'], '과학_실험2.pdf': ['move', '문서/과학_실험2.pdf', 'DEFAULT_EXTENSION'],
  '스크린샷.PNG': ['move', '이미지/스크린샷.PNG', 'DEFAULT_EXTENSION'], '노래.mp3': ['move', '음악/노래.mp3', 'DEFAULT_EXTENSION'],
  '설치.dmg': ['move', '설치/설치.dmg', 'DEFAULT_EXTENSION'], 'backup.tgz': ['move', '압축/backup.tgz', 'DEFAULT_EXTENSION'],
  '영상.MOV': ['move', '영상/영상.MOV', 'DEFAULT_EXTENSION'], 'README': ['review', null, 'NO_EXTENSION'],
  'data.xyz': ['review', null, 'UNKNOWN_EXTENSION'], 'report.pdf.exe': ['review', null, 'COMPOUND_EXTENSION'],
  '수학/수학_기존.pdf': ['move', '문서/수학_기존.pdf', 'DEFAULT_EXTENSION'],
};
/** Every SUBJECT rule confirmed. */
const PERSONAL_SUBJECT: Record<string, Row> = { ...DEFAULT_SUBJECT,
  '수학_과제3.pdf': ['move', '수학/수학_과제3.pdf', 'PERSONAL_RULE'], '국어 감상문.pdf': ['move', '국어/국어 감상문.pdf', 'PERSONAL_RULE'],
  '수학국어_통합.pdf': ['review', null, 'RULE_CONFLICT'], '스크린샷.PNG': ['move', '사진/스크린샷.PNG', 'PERSONAL_RULE'],
  '수학/수학_기존.pdf': ['keep', '수학/수학_기존.pdf', 'ALREADY_PLACED'],
};

test('V18-01 reference skipped: an empty store gives null and the default classification; nothing is written anywhere', async (t) => {
  const e = await env(t, prefixed('work', WORK_SUBJECT));
  const before = await oracle(e.base);
  assert.equal(await loadProfile(e.o), null);
  const { preview, suggestedProfile, reference, protected: kept } = await analyze(e.dir('work'));
  assert.deepEqual(table(preview.items), DEFAULT_SUBJECT);
  assert.equal(preview.profileId, null); assert.equal(preview.profileRevision, null);
  assert.equal(suggestedProfile, null); assert.equal(reference, null); assert.deepEqual(kept, []);
  assert.deepEqual(await oracle(e.base), before, 'work and state folders unchanged');
  assert.deepEqual(await readdir(e.state), []);
});

test('V18-02 reference reading uses names only: unreadable files still count, links and hidden folders are not followed', { skip: !posix }, async (t) => {
  const e = await env(t, { ...prefixed('ref', { '보고서/보고서_1.pdf': 'a', '보고서/보고서_2.pdf': 'b', '.숨김/c.pdf': 'c', '.숨김/d.pdf': 'd' }),
    'outside/수학/수학_x.pdf': 'o1', 'outside/수학/수학_y.pdf': 'o2' });
  await symlink(e.dir('outside/수학'), e.dir('ref/링크폴더'));
  await chmod(e.dir('ref/보고서/보고서_2.pdf'), 0o000);
  const before = await oracle(e.base);
  const scan = await readReference(await issueReferenceGrant(e.dir('ref')));
  assert.deepEqual(scan.files.map((f) => f.relativePath).sort(), ['보고서/보고서_1.pdf', '보고서/보고서_2.pdf']);
  const draft = suggestProfile(scan);
  assert.deepEqual(draft.rules.map((r) => [r.extension, r.keyword, r.targetDirectory, r.evidence]),
    [['.pdf', null, '보고서', ['보고서/보고서_1.pdf', '보고서/보고서_2.pdf']]]);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(await oracle(e.base), before, 'reference (incl. unreadable file, link, hidden folder) and outside folder unchanged');
});

test('V18-03 subject folders: suggest → confirm → save → load → new files match the hand-written table; drafts never apply', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), ...prefixed('work', WORK_SUBJECT) });
  const before = await oracle(e.base);
  const draft = suggestProfile(await readReference(await issueReferenceGrant(e.dir('ref'))));
  assert.deepEqual(draft.rules.map((r) => [r.extension, r.keyword, r.targetDirectory, r.evidence]), SUBJECT_RULES);
  // A draft is shown, not applied, and cannot be saved.
  assert.deepEqual(table((await analyze(e.dir('work'), { profile: draft })).preview.items), DEFAULT_SUBJECT);
  await assert.rejects(saveConfirmedProfile(draft, e.o));
  await assert.rejects(saveConfirmedProfile({ ...confirmProfile(draft, [draft.rules[0]!.id]), status: 'disabled' }, e.o));
  assert.deepEqual(await readdir(e.state), [], 'refused saves write nothing');
  // Only the confirmed subset applies.
  const onlyMath = await confirmedFrom(e.dir('ref'), (r) => r.keyword === '수학');
  const partial = await saveConfirmedProfile(onlyMath, e.o);
  assert.deepEqual(table((await analyze(e.dir('work'), { profile: asSaved(await loadProfile(e.o)) })).preview.items), { ...DEFAULT_SUBJECT,
    '수학_과제3.pdf': ['move', '수학/수학_과제3.pdf', 'PERSONAL_RULE'], '수학국어_통합.pdf': ['move', '수학/수학국어_통합.pdf', 'PERSONAL_RULE'],
    '수학/수학_기존.pdf': ['keep', '수학/수학_기존.pdf', 'ALREADY_PLACED'] });
  // All three confirmed.
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  assert.ok(saved.revision > partial.revision);
  const loaded = asSaved(await loadProfile(e.o));
  assert.deepEqual(loaded, saved);
  assert.deepEqual(loaded.rules.map((r) => [r.extension, r.keyword, r.targetDirectory, r.evidence, r.evidenceCount, r.enabled]),
    SUBJECT_RULES.map((r) => [...r, 2, true]));
  const { preview } = await analyze(e.dir('work'), { profile: loaded });
  assert.deepEqual(table(preview.items), PERSONAL_SUBJECT);
  assert.equal(preview.profileId, saved.id); assert.equal(preview.profileRevision, saved.revision);
  const after = await oracle(e.base);
  assert.deepEqual(without(after, 'state'), without(before, 'state'), 'reference and work originals unchanged');
});

test('V18-04 date folders: date-named files follow their month folder; months without matching names give no rule', async (t) => {
  const ref = { '2026-09/2026-09-03 회의록.hwp': 'a', '2026-09/2026-09-17 회의록.hwp': 'b', '2026-10/2026-10-01 회의록.hwp': 'c',
    '2026-10/2026-10-15 회의록.hwp': 'd', '2026-11/회의.hwp': 'e', '2026-11/메모.hwp': 'f' };
  const work = { '2026-10-22 회의록.hwp': '1', '2026-09-30 회의록.hwp': '2', '2026-11-02 회의.hwp': '3', '회의.hwp': '4',
    '2026-09-10_2026-10-10 비교.hwp': '5', '2026-10-05.HWP': '6' };
  const e = await env(t, { ...prefixed('ref', ref), ...prefixed('work', work) });
  const before = await oracle(e.base);
  const draft = suggestProfile(await readReference(await issueReferenceGrant(e.dir('ref'))));
  assert.deepEqual(draft.rules.map((r) => [r.extension, r.keyword, r.targetDirectory, r.evidence]), [
    ['.hwp', '2026-09', '2026-09', ['2026-09/2026-09-03 회의록.hwp', '2026-09/2026-09-17 회의록.hwp']],
    ['.hwp', '2026-10', '2026-10', ['2026-10/2026-10-01 회의록.hwp', '2026-10/2026-10-15 회의록.hwp']]]);
  const saved = await saveConfirmedProfile(confirmProfile(draft, draft.rules.map((r) => r.id)), e.o);
  assert.deepEqual(table((await analyze(e.dir('work'), { profile: asSaved(await loadProfile(e.o)) })).preview.items), {
    '2026-10-22 회의록.hwp': ['move', '2026-10/2026-10-22 회의록.hwp', 'PERSONAL_RULE'],
    '2026-09-30 회의록.hwp': ['move', '2026-09/2026-09-30 회의록.hwp', 'PERSONAL_RULE'],
    '2026-11-02 회의.hwp': ['move', '문서/2026-11-02 회의.hwp', 'DEFAULT_EXTENSION'],
    '회의.hwp': ['move', '문서/회의.hwp', 'DEFAULT_EXTENSION'],
    '2026-09-10_2026-10-10 비교.hwp': ['review', null, 'RULE_CONFLICT'],
    '2026-10-05.HWP': ['move', '2026-10/2026-10-05.HWP', 'PERSONAL_RULE'],
  });
  assert.equal(saved.referenceRootLabel, 'ref');
  assert.deepEqual(without(await oracle(e.base), 'state'), without(before, 'state'));
});

test('V18-05 review instead of forcing: blocked destination, impossible path, hidden target, unknown IDs', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), ...prefixed('work', { '사진': 'a file where the folder would go', '스크린샷.png': 's',
    'long-name.pdf': 'l', '수학_과제3.pdf': 'm', '수학/수학_과제3.pdf': 'already there, other content' }) });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  const deep = [...Array.from({ length: 20 }, () => 'a'.repeat(200)), 'b'.repeat(70)].join('/');
  assert.equal(deep.length, 4090);
  const withLong = await addCorrection({ type: 'keyword', extension: '.pdf', keyword: 'long-name' }, deep, e.o);
  const rows = table((await analyze(e.dir('work'), { profile: withLong })).preview.items);
  assert.deepEqual(rows['스크린샷.png'], ['review', null, 'DEST_CONFLICT'], '사진 exists as a file');
  assert.deepEqual(rows['long-name.pdf'], ['review', null, 'DEST_INVALID']);
  assert.deepEqual(rows['수학_과제3.pdf'], ['review', null, 'DEST_CONFLICT'], 'never overwrite an existing file');
  assert.deepEqual(rows['수학/수학_과제3.pdf'], ['keep', '수학/수학_과제3.pdf', 'ALREADY_PLACED']);
  const bytes = await readFile(profileFile(e.state));
  for (const target of ['.숨김', '수학/.git', '../밖', '/절대', '']) await assert.rejects(addCorrection({ type: 'file-name', name: 'x.pdf' }, target, e.o), target);
  await assert.rejects(addCorrection({ type: 'file-name', name: 'a/b.pdf' }, '문서', e.o));
  await assert.rejects(setRuleEnabled('no-such-rule', false, e.o));
  await assert.rejects(removeCorrection('0123456789abcdef', e.o));
  assert.deepEqual(await readFile(profileFile(e.state)), bytes, 'refused changes write nothing');
  assert.ok(withLong.revision > saved.revision);
});

test('V18-06 disabled rules and a disabled profile are never applied; enabling restores them', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), ...prefixed('work', WORK_SUBJECT) });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  const rows = async (): Promise<Record<string, Row>> => {
    const loaded = await loadProfile(e.o);
    return table((await analyze(e.dir('work'), loaded === null ? {} : { profile: asSaved(loaded) })).preview.items);
  };
  const off = await setRuleEnabled(ruleIdFor(saved, '수학'), false, e.o);
  assert.equal(off.rules.find((r) => r.targetDirectory === '수학')?.enabled, false);
  assert.deepEqual(await rows(), { ...PERSONAL_SUBJECT, '수학_과제3.pdf': ['move', '문서/수학_과제3.pdf', 'DEFAULT_EXTENSION'],
    '수학국어_통합.pdf': ['move', '국어/수학국어_통합.pdf', 'PERSONAL_RULE'], '수학/수학_기존.pdf': ['move', '문서/수학_기존.pdf', 'DEFAULT_EXTENSION'] });
  await disableProfile(e.o);
  const disabled = asSaved(await loadProfile(e.o));
  assert.equal(disabled.status, 'disabled');
  const { preview } = await analyze(e.dir('work'), { profile: disabled });
  assert.deepEqual(table(preview.items), DEFAULT_SUBJECT);
  assert.equal(preview.profileId, null); assert.equal(preview.profileRevision, null);
  await enableProfile(e.o); await setRuleEnabled(ruleIdFor(saved, '수학'), true, e.o);
  assert.deepEqual(await rows(), PERSONAL_SUBJECT);
});

test('V18-07 one-off override vs "from now on" correction, removal, re-apply, reset; revisions only rise; no-ops do not write', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), ...prefixed('work', { ...WORK_SUBJECT, '실험 결과.pdf': 'r' }) });
  const file = profileFile(e.state);
  const revisions: number[] = [];
  const keep = (p: RuleProfileV2): RuleProfileV2 => { revisions.push(p.revision); return p; };
  const rows = async (extra: Parameters<typeof analyzeRoot>[1] = {}): Promise<Record<string, Row>> => {
    const loaded = await loadProfile(e.o);
    return table((await analyze(e.dir('work'), { ...(loaded === null ? {} : { profile: asSaved(loaded) }), ...extra })).preview.items);
  };
  const unchanged = async (action: () => Promise<unknown>): Promise<void> => {
    const [bytes, s] = [await readFile(file), await stat(file, { bigint: true })];
    await action();
    const s2 = await stat(file, { bigint: true });
    assert.deepEqual(await readFile(file), bytes); assert.equal(s2.mtimeNs, s.mtimeNs); assert.equal(s2.ino, s.ino);
  };
  const saved = keep(await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o));
  const base = { ...PERSONAL_SUBJECT, '실험 결과.pdf': ['move', '문서/실험 결과.pdf', 'DEFAULT_EXTENSION'] as Row };
  assert.deepEqual(await rows(), base);
  // One-off: applies to this analysis only and never touches the store.
  const { preview } = await analyze(e.dir('work'), { profile: saved });
  const idOf = (source: string): string => preview.items.find((i) => i.source === source)!.fileId;
  await unchanged(async () => {
    const once = await rows({ overrides: { [idOf('과학_실험2.pdf')]: '과학', [idOf('수학_과제3.pdf')]: '임시' } });
    assert.deepEqual(once['과학_실험2.pdf'], ['move', '과학/과학_실험2.pdf', 'USER_OVERRIDE']);
    assert.deepEqual(once['수학_과제3.pdf'], ['move', '임시/수학_과제3.pdf', 'USER_OVERRIDE'], 'one-off beats a personal rule');
  });
  assert.deepEqual(await rows(), base, 'the one-off correction is gone next time');
  // "From now on": exact name beats keyword, keyword beats personal rule, one-off beats both.
  const byName = keep(await addCorrection({ type: 'file-name', name: '과학_실험2.pdf' }, '과학', e.o));
  const byKeyword = keep(await addCorrection({ type: 'keyword', extension: '.pdf', keyword: '실험' }, '실험실', e.o));
  const nameId = byName.corrections[0]!.id; const keywordId = byKeyword.corrections.find((c) => c.id !== nameId)!.id;
  await unchanged(() => addCorrection({ type: 'file-name', name: '과학_실험2.pdf' }, '과학', e.o));
  await unchanged(() => addCorrection({ type: 'file-name', name: '과학_실험2.PDF' }, '과학', e.o)); // same match, case-insensitive
  const remembered = { ...base, '과학_실험2.pdf': ['move', '과학/과학_실험2.pdf', 'SAVED_CORRECTION'] as Row,
    '실험 결과.pdf': ['move', '실험실/실험 결과.pdf', 'SAVED_CORRECTION'] as Row };
  assert.deepEqual(await rows(), remembered);
  assert.deepEqual((await rows({ overrides: { [idOf('과학_실험2.pdf')]: '임시' } }))['과학_실험2.pdf'], ['move', '임시/과학_실험2.pdf', 'USER_OVERRIDE']);
  // Two keyword corrections with different targets matching one file: review, not a pick.
  const clash = keep(await addCorrection({ type: 'keyword', extension: '.pdf', keyword: '결과' }, '결과물', e.o));
  assert.deepEqual((await rows())['실험 결과.pdf'], ['review', null, 'RULE_CONFLICT']);
  keep(await removeCorrection(clash.corrections.find((c) => c.targetDirectory === '결과물')!.id, e.o));
  // Removing the name correction lets the keyword correction apply; removing both returns to the default.
  keep(await removeCorrection(nameId, e.o));
  assert.deepEqual((await rows())['과학_실험2.pdf'], ['move', '실험실/과학_실험2.pdf', 'SAVED_CORRECTION']);
  keep(await removeCorrection(keywordId, e.o));
  assert.deepEqual(await rows(), base);
  // Re-applying gives the same correction ID and the same result.
  const again = keep(await addCorrection({ type: 'file-name', name: '과학_실험2.pdf' }, '과학', e.o));
  assert.equal(again.corrections[0]!.id, nameId);
  assert.deepEqual((await rows())['과학_실험2.pdf'], ['move', '과학/과학_실험2.pdf', 'SAVED_CORRECTION']);
  // Same match, different destination: the old correction is replaced (new revision).
  keep(await addCorrection({ type: 'file-name', name: '과학_실험2.pdf' }, '과학/2학기', e.o));
  assert.deepEqual((await rows())['과학_실험2.pdf'], ['move', '과학/2학기/과학_실험2.pdf', 'SAVED_CORRECTION']);
  keep(await disableProfile(e.o));
  await unchanged(() => disableProfile(e.o)); // second disable is a no-op
  keep(await enableProfile(e.o));
  const last = revisions.at(-1)!;
  // Reset forgets everything (default classification) but keeps the revision counter.
  await resetProfile(e.o);
  assert.equal(await loadProfile(e.o), null);
  assert.deepEqual(await rows(), { ...DEFAULT_SUBJECT, '실험 결과.pdf': ['move', '문서/실험 결과.pdf', 'DEFAULT_EXTENSION'] });
  await unchanged(() => resetProfile(e.o));
  await assert.rejects(setRuleEnabled(ruleIdFor(saved, '수학'), false, e.o));
  const resaved = keep(await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o));
  assert.equal(resaved.id, saved.id, 'same reference, same profile ID ...');
  assert.ok(resaved.revision > last, '... so the revision must not repeat');
  await resetProfile(e.o);
  const local = keep(await addCorrection({ type: 'file-name', name: 'README' }, '기타', e.o));
  assert.equal(local.referenceRootId, null); assert.deepEqual(local.rules, []);
  assert.deepEqual((await rows())['README'], ['move', '기타/README', 'SAVED_CORRECTION']);
  for (let i = 1; i < revisions.length; i++) assert.ok(revisions[i]! > revisions[i - 1]!, `revision ${i}: ${revisions.join(',')}`);
  assert.ok(revisions.length >= 12);
});

test('V18-08 expectedRevision: every change refuses a profile that changed in between (PROFILE_CHANGED) and writes nothing', async (t) => {
  const e = await env(t, prefixed('ref', REF_SUBJECT));
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  const withName = await addCorrection({ type: 'file-name', name: 'a.pdf' }, '가', e.o);
  const stale = { ...e.o, expectedRevision: saved.revision };
  const bytes = await readFile(profileFile(e.state));
  const attempts: [string, () => Promise<unknown>][] = [
    ['setRuleEnabled', () => setRuleEnabled(ruleIdFor(saved, '수학'), false, stale)], ['disableProfile', () => disableProfile(stale)],
    ['enableProfile', () => enableProfile(stale)], ['removeCorrection', () => removeCorrection(withName.corrections[0]!.id, stale)],
    ['addCorrection', () => addCorrection({ type: 'file-name', name: 'b.pdf' }, '나', stale)], ['resetProfile', () => resetProfile(stale)],
    ['saveConfirmedProfile', async () => saveConfirmedProfile(await confirmedFrom(e.dir('ref')), stale)],
  ];
  for (const [name, attempt] of attempts) await assert.rejects(attempt(), code('PROFILE_CHANGED'), name);
  assert.deepEqual(await readFile(profileFile(e.state)), bytes);
  assert.deepEqual(await readdir(path.join(e.state, 'profiles')), ['active.json']);
  const ok = await disableProfile({ ...e.o, expectedRevision: withName.revision });
  assert.equal(ok.revision, withName.revision + 1);
});

test('V18-09 damaged stores: reported as corrupt, never applied, bytes kept, changes refused; explicit save/reset keeps a corrupt copy', { skip: !posix }, async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), 'outside/': '' });
  const draft = suggestProfile(await readReference(await issueReferenceGrant(e.dir('ref'))));
  const confirmed = confirmProfile(draft, draft.rules.map((r) => r.id));
  const goodState = path.join(e.base, 'good'); await mkdir(goodState);
  await saveConfirmedProfile(confirmed, { stateDir: goodState });
  const good = await readFile(profileFile(goodState), 'utf8');
  const broken = (mutate: (store: { profile: Record<string, unknown> }) => void): string => {
    const store = JSON.parse(good) as { profile: Record<string, unknown> }; mutate(store); return JSON.stringify(store);
  };
  await writeFile(e.dir('outside/valid.json'), good);
  type Maker = (file: string) => Promise<void>;
  const cases: [string, Maker][] = [
    ['truncated JSON', (f) => writeFile(f, good.slice(0, Math.floor(good.length / 2)))],
    ['schema: extra field', (f) => writeFile(f, broken((s) => { s.profile['extra'] = 1; }))],
    ['schema: path as label', (f) => writeFile(f, broken((s) => { s.profile['referenceRootLabel'] = '/Users/someone/ref'; }))],
    ['schema: revision 0', (f) => writeFile(f, broken((s) => { s.profile['revision'] = 0; }))],
    ['v1 draft', (f) => writeFile(f, JSON.stringify(draft))],
    ['v1 confirmed', (f) => writeFile(f, JSON.stringify(confirmed))],
    ['not UTF-8', (f) => writeFile(f, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))],
    ['empty file', (f) => writeFile(f, '')],
    ['oversized', (f) => writeFile(f, good.trimEnd() + ' '.repeat(1024 * 1024 + 10))],
    ['directory at path', async (f) => { await mkdir(f); await writeFile(path.join(f, 'inside.txt'), 'keep me'); }],
    ['symlink to a valid profile', (f) => symlink(e.dir('outside/valid.json'), f)],
  ];
  const work = e.dir('work'); await mkdir(work); await writeFile(path.join(work, '수학_과제3.pdf'), 'w');
  for (const [name, make] of cases) for (const finish of ['save', 'reset'] as const) {
    const state = path.join(e.base, `s-${cases.findIndex(([n]) => n === name)}-${finish}`);
    const o = { stateDir: state }; const file = profileFile(state);
    await mkdir(path.dirname(file), { recursive: true }); await make(file);
    const profilesDir = path.dirname(file);
    const before = await oracle(profilesDir); const outsideBefore = await oracle(e.dir('outside'));
    const loaded = await loadProfile(o);
    assert.ok(loaded !== null && loaded.status === 'corrupt', `${name}: ${JSON.stringify(loaded)}`);
    assert.equal(typeof (loaded as { reason: unknown }).reason, 'string');
    assert.ok(!('rules' in loaded), `${name}: no rules handed out`);
    assert.throws(() => buildPreview({ root: { id: 'a'.repeat(64), canonicalPath: '/x', readOnly: true }, files: [], directories: [],
      skipped: [], complete: true }, { profile: loaded }), `${name}: the corrupt marker is not a usable profile`);
    for (const [label, change] of [['setRuleEnabled', () => setRuleEnabled('x', false, o)], ['disableProfile', () => disableProfile(o)],
      ['enableProfile', () => enableProfile(o)], ['removeCorrection', () => removeCorrection('0123456789abcdef', o)],
      ['addCorrection', () => addCorrection({ type: 'file-name', name: 'a.pdf' }, '가', o)]] as const)
      await assert.rejects(change(), `${name}: ${label} refused`);
    assert.deepEqual(await oracle(profilesDir), before, `${name}: bytes untouched`);
    if (finish === 'save') {
      const saved = await saveConfirmedProfile(confirmed, o);
      assert.deepEqual(asSaved(await loadProfile(o)), saved);
    } else {
      await resetProfile(o);
      assert.equal(await loadProfile(o), null);
    }
    const names = (await readdir(profilesDir)).sort();
    const aside = names.filter((n) => /^corrupt-.+\.json$/u.test(n));
    assert.deepEqual(names.filter((n) => !aside.includes(n)), ['active.json'], `${name}: ${names.join(',')}`);
    assert.equal(aside.length, 1, `${name}: one corrupt copy`);
    const kept = await oracle(profilesDir);
    // The copy is the original entry (same inode, same bytes / contents / link target), renamed only.
    const rewrite = (o2: Record<string, string>, from: string, to: string): Record<string, string> => Object.fromEntries(
      Object.entries(o2).filter(([k]) => k === from || k.startsWith(`${from}/`)).map(([k, v]) => [to + k.slice(from.length), v.replace(/ ctime=\d+/u, '')]));
    assert.deepEqual(rewrite(kept, aside[0]!, 'X'), rewrite(before, 'active.json', 'X'), `${name}: corrupt copy preserved`);
    assert.deepEqual(await oracle(e.dir('outside')), outsideBefore, `${name}: link target untouched`);
    // The new store applies again.
    if (finish === 'save') assert.deepEqual(table((await analyze(work, { profile: asSaved(await loadProfile(o)) })).preview.items)['수학_과제3.pdf'],
      ['move', '수학/수학_과제3.pdf', 'PERSONAL_RULE']);
  }
});

/** Reference originals: kept as-is, never move/duplicate candidates, never a destination. */
function assertReferenceKept(preview: Awaited<ReturnType<typeof analyzeRoot>>['preview'], referencePaths: string[]): void {
  const rows = table(preview.items);
  for (const p of referencePaths) assert.deepEqual(rows[p], ['keep', null, 'PROTECTED_REFERENCE'], p);
  const lower = new Set(referencePaths.map((p) => p.normalize('NFC').toLowerCase()));
  for (const item of preview.items) if (item.destination !== null && item.action === 'move')
    assert.ok(!lower.has(item.destination.normalize('NFC').toLowerCase()), `destination ${item.destination}`);
  for (const group of preview.duplicates) {
    for (const c of group.candidates) assert.ok(!lower.has(c.normalize('NFC').toLowerCase()), `duplicate candidate ${c}`);
  }
  assert.ok(preview.largeFiles.every((f) => !lower.has(f.normalize('NFC').toLowerCase())));
}
const REF_IN = { '수학/수학_과제1.pdf': 'same-bytes', '수학/수학_과제2.pdf': 'm2', '국어/국어_a.pdf': 'k1', '국어/국어_b.pdf': 'k2' };

test('V18-10 overlapping roots in one session: reference ⊂ work, work ⊂ reference, same folder', async (t) => {
  const e = await env(t, { ...prefixed('w1/정리', REF_IN), 'w1/수학_과제5.pdf': 'n', 'w1/수학_과제1.pdf': 'other', 'w1/국어 메모.pdf': 'n2', 'w1/사본.pdf': 'same-bytes',
    ...prefixed('r2', REF_IN), ...prefixed('r3', REF_IN) });
  const before = await oracle(e.base);
  // reference ⊂ work, live reference grant, nothing saved yet.
  const live = await analyze(e.dir('w1'), { reference: await issueReferenceGrant(e.dir('w1/정리')) });
  const inRef = Object.keys(REF_IN).map((p) => `정리/${p}`);
  assertReferenceKept(live.preview, inRef);
  assert.deepEqual(table(live.preview.items)['수학_과제5.pdf'], ['move', '문서/수학_과제5.pdf', 'DEFAULT_EXTENSION']);
  // Saved v2 profile, no live grant: the folder is recognised by ID, destinations are relative to the work root.
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('w1/정리')), e.o);
  const again = await analyze(e.dir('w1'), { profile: saved });
  assertReferenceKept(again.preview, inRef);
  const rows = table(again.preview.items);
  assert.deepEqual(rows['수학_과제5.pdf'], ['move', '수학/수학_과제5.pdf', 'PERSONAL_RULE']);
  assert.deepEqual(rows['국어 메모.pdf'], ['move', '국어/국어 메모.pdf', 'PERSONAL_RULE']);
  assert.deepEqual(rows['사본.pdf'], ['move', '문서/사본.pdf', 'DEFAULT_EXTENSION']);
  // A one-off correction aimed at an existing reference file never overwrites it; the reference file itself cannot be overridden.
  const ids = Object.fromEntries(again.preview.items.map((i) => [i.source, i.fileId]));
  const forced = table((await analyze(e.dir('w1'), { profile: saved, overrides: { [ids['사본.pdf']!]: '정리/수학', [ids['정리/수학/수학_과제2.pdf']!]: '밖' } })).preview.items);
  assert.deepEqual(forced['사본.pdf'], ['move', '정리/수학/사본.pdf', 'USER_OVERRIDE'], 'new name inside the work root is allowed');
  assert.deepEqual(forced['정리/수학/수학_과제2.pdf'], ['keep', null, 'PROTECTED_REFERENCE']);
  const clash = table((await analyze(e.dir('w1'), { profile: saved, overrides: { [ids['수학_과제1.pdf']!]: '정리/수학' } })).preview.items);
  assert.deepEqual(clash['수학_과제1.pdf'], ['review', null, 'DEST_CONFLICT'], 'same name as a reference original: never a destination');
  // work ⊂ reference and work = reference: every work file is a reference original.
  const s2 = await saveConfirmedProfile(await confirmedFrom(e.dir('r2')), { stateDir: path.join(e.base, 'state2') });
  const sub = await analyze(e.dir('r2/수학'), { profile: s2 });
  assertReferenceKept(sub.preview, ['수학_과제1.pdf', '수학_과제2.pdf']);
  const liveSub = await analyze(e.dir('r2/수학'), { reference: await issueReferenceGrant(e.dir('r2')) });
  assertReferenceKept(liveSub.preview, ['수학_과제1.pdf', '수학_과제2.pdf']);
  const s3 = await saveConfirmedProfile(await confirmedFrom(e.dir('r3')), { stateDir: path.join(e.base, 'state3') });
  assertReferenceKept((await analyze(e.dir('r3'), { profile: s3 })).preview, Object.keys(REF_IN));
  assertReferenceKept((await analyze(e.dir('r3'), { reference: await issueReferenceGrant(e.dir('r3')) })).preview, Object.keys(REF_IN));
  const after = await oracle(e.base);
  for (const key of Object.keys(before)) if (!key.startsWith('state')) assert.equal(after[key], before[key], key);
});

test('V18-11 restart: one node process saves, two others load and analyze; same result, reference originals untouched', async (t) => {
  const e = await env(t, { ...prefixed('work/정리', REF_IN), 'work/수학_과제5.pdf': 'n', 'work/국어 메모.pdf': 'n2', 'work/설치.dmg': 'd',
    ...prefixed('ref2', REF_IN) });
  const before = await oracle(e.base);
  const url = (rel: string): string => JSON.stringify(new URL(rel, import.meta.url).href);
  const child = (state: string, body: string, ...args: string[]): string => {
    const script = `import * as fsx from ${url('../packages/filesystem/src/index.js')};
      import * as store from ${url('../packages/filesystem/src/profiles.js')};
      import * as engine from ${url('../packages/engine/src/index.js')};
      const args = process.argv.slice(1);
      ${body}`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, AFO_STATE_DIR: state, HOME: FAKE_HOME } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const save = `const draft = engine.suggestProfile(await fsx.readReference(await fsx.issueReferenceGrant(args[0])));
    const saved = await store.saveConfirmedProfile(engine.confirmProfile(draft, draft.rules.map((r) => r.id)));
    await store.addCorrection({ type: 'file-name', name: '설치.dmg' }, '프로그램');
    console.log(JSON.stringify(saved));`;
  const look = `const profile = await store.loadProfile();
    const { preview } = await fsx.analyzeRoot(await fsx.issueRootGrant(args[0]), { profile });
    console.log(JSON.stringify({ profile, preview: { ...preview, id: undefined, root: undefined } }));`;
  child(e.state, save, e.dir('work/정리'));
  const first = JSON.parse(child(e.state, look, e.dir('work'))) as { profile: RuleProfileV2; preview: Awaited<ReturnType<typeof analyzeRoot>>['preview'] };
  const second = JSON.parse(child(e.state, look, e.dir('work'))) as typeof first;
  assert.deepEqual(second, first);
  assertReferenceKept(first.preview, Object.keys(REF_IN).map((p) => `정리/${p}`));
  assert.deepEqual(table(first.preview.items), {
    ...Object.fromEntries(Object.keys(REF_IN).map((p) => [`정리/${p}`, ['keep', null, 'PROTECTED_REFERENCE'] as Row])),
    '수학_과제5.pdf': ['move', '수학/수학_과제5.pdf', 'PERSONAL_RULE'], '국어 메모.pdf': ['move', '국어/국어 메모.pdf', 'PERSONAL_RULE'],
    '설치.dmg': ['move', '프로그램/설치.dmg', 'SAVED_CORRECTION'] });
  assert.equal(first.preview.profileRevision, first.profile.revision); assert.equal(first.preview.profileId, first.profile.id);
  // work ⊂ reference after restart.
  const state2 = path.join(e.base, 'state2');
  child(state2, save, e.dir('ref2'));
  const sub = JSON.parse(child(state2, look, e.dir('ref2/국어'))) as typeof first;
  assertReferenceKept(sub.preview, ['국어_a.pdf', '국어_b.pdf']);
  // This process reads the same store and agrees.
  assert.deepEqual(asSaved(await loadProfile(e.o)), first.profile);
  const after = await oracle(e.base);
  for (const key of Object.keys(before)) if (!key.startsWith('state')) assert.equal(after[key], before[key], key);
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before)).sort(),
    ['state/profiles', 'state/profiles/active.json', 'state2', 'state2/profiles', 'state2/profiles/active.json']);
});

test('V18-12a a separate reference folder renamed after saving: rules still apply relative to the work root', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_IN), 'work2/국어_c.pdf': 'c' });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  await rename(e.dir('ref'), e.dir('ref-renamed'));
  assert.deepEqual(table((await analyze(e.dir('work2'), { profile: saved })).preview.items)['국어_c.pdf'], ['move', '국어/국어_c.pdf', 'PERSONAL_RULE']);
  // After the F-1 fix the renamed folder is recognised by dev/inode: every file is a protected reference original and the
  // profile is reported stale (not applied) for this analysis. Previously this passed only via ALREADY_PLACED.
  const renamed = (await analyze(e.dir('ref-renamed'), { profile: saved })).preview;
  assert.deepEqual(table(renamed.items)['수학/수학_과제1.pdf'], ['keep', null, 'PROTECTED_REFERENCE'], 'files of the renamed reference stay put');
  assert.equal(renamed.profileNotice?.code, 'PROFILE_STALE');
});

/** Finding F-1 (docs/verification/ISSUE_18.md): expected behaviour, recorded as todo so the suite reports it without failing. */
test('V18-12b reference folder inside the work root renamed after saving: its originals must not become move proposals', async (t) => {
  const e = await env(t, { ...prefixed('work/정리', REF_IN), 'work/수학_과제5.pdf': 'n' });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('work/정리')), e.o);
  await rename(e.dir('work/정리'), e.dir('work/정리2'));
  const before = await oracle(e.base);
  const rows = table((await analyze(e.dir('work'), { profile: saved })).preview.items);
  const status = Object.fromEntries(Object.keys(REF_IN).map((p) => [`정리2/${p}`, rows[`정리2/${p}`]]));
  t.diagnostic(`renamed reference originals: ${JSON.stringify(status)}`);
  assert.deepEqual(await oracle(e.base), before, 'preview only: nothing moved');
  const flagged = await loadProfile(e.o);
  t.diagnostic(`profile after rename: ${flagged === null ? 'null' : flagged.status}`);
  for (const [p, row] of Object.entries(status)) assert.notEqual(row?.[0], 'move', `${p} is a reference original`);
});

test('V18-13 saved file holds no absolute path, home path or full reference listing', async (t) => {
  const many = { '자료/자료_1.pdf': '1', '자료/자료_2.pdf': '2', '자료/자료_3.pdf': '3', '자료/자료_4.pdf': '4', '자료/자료_5.pdf': '5',
    '비밀 메모.txt': 'loose', '혼자/단독파일.hwp': 'single', '사진/여행.jpg': 'a', '사진/가족.jpg': 'b' };
  const e = await env(t, prefixed('참고 폴더', many));
  const reference = e.dir('참고 폴더');
  const saved = await saveConfirmedProfile(await confirmedFrom(reference), e.o);
  await addCorrection({ type: 'file-name', name: '과제.pdf' }, '숙제', e.o);
  const raw = await readFile(profileFile(e.state), 'utf8');
  const parsed = JSON.parse(raw) as { profile: RuleProfileV2 };
  for (const secret of [e.base, reference, realpathSync(tmpdir()), tmpdir(), REAL_HOME, FAKE_HOME, '/Users/', '/private/', '/var/folders',
    '비밀 메모', '단독파일', '자료_4', '자료_5', 'referenceFiles', 'canonicalPath'])
    assert.ok(!raw.includes(secret) && !raw.normalize('NFD').includes(secret.normalize('NFD')), `stored file contains ${JSON.stringify(secret)}`);
  assert.equal(parsed.profile.referenceRootLabel, '참고 폴더');
  assert.equal(parsed.profile.referenceRootId, sha(realpathSync(reference)), 'only a hash of the real path identifies the folder');
  const rule = parsed.profile.rules.find((r) => r.targetDirectory === '자료')!;
  assert.deepEqual([rule.evidence, rule.evidenceCount], [['자료/자료_1.pdf', '자료/자료_2.pdf', '자료/자료_3.pdf'], 5]);
  assert.deepEqual(parsed.profile.rules.map((r) => r.targetDirectory).sort(), ['사진', '자료']);
  assert.equal(saved.referenceRootLabel, '참고 폴더');
  // Every string in the file is a hand-checked kind of value: no '/'-rooted or drive-rooted path anywhere.
  const strings: string[] = [];
  JSON.parse(raw, (_k, v: unknown) => { if (typeof v === 'string') strings.push(v); return v; });
  assert.ok(strings.every((s) => !s.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(s) && !s.startsWith('~')), strings.join(' | '));
});

test('V18-14 classification rules never create deletion candidates; duplicates and large files are the same with or without a profile', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), ...prefixed('work', { '수학_과제3.pdf': 'dup', '수학/수학_과제3 사본.pdf': 'dup',
    '국어 감상문.pdf': 'unique', '오래된 수학_정리.pdf': { data: 'old', modified: new Date('2001-01-01T00:00:00Z') },
    '빈 수학.pdf': '', '빈 국어.pdf': '' }) });
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o);
  const plain = (await analyze(e.dir('work'))).preview;
  const personal = (await analyze(e.dir('work'), { profile: saved })).preview;
  assert.deepEqual(personal.duplicates, plain.duplicates);
  assert.deepEqual(personal.largeFiles, plain.largeFiles);
  assert.deepEqual(personal.space, plain.space);
  assert.equal(plain.duplicates.length, 1, 'only identical non-empty content is a duplicate (empty files and old files are not)');
  assert.deepEqual([...plain.duplicates[0]!.candidates, plain.duplicates[0]!.suggestedKeep].sort(), ['수학/수학_과제3 사본.pdf', '수학_과제3.pdf']);
  assert.ok(personal.items.every((i) => i.action === 'move' || i.action === 'keep' || i.action === 'review'));
  assert.equal(personal.executionAvailable, false);
  assert.deepEqual(table(personal.items)['오래된 수학_정리.pdf'], ['move', '수학/오래된 수학_정리.pdf', 'PERSONAL_RULE'], 'age is not a delete reason');
});

test('V18-15 every profile change gives a new preview identity and revision (approvals bound to the old one cannot carry over)', async (t) => {
  const e = await env(t, { ...prefixed('ref', REF_SUBJECT), ...prefixed('work', { '수학_과제3.pdf': 'a', '국어 감상문.pdf': 'b' }) });
  const seen = new Map<string, number | null>();
  const record = async (): Promise<void> => {
    const loaded = await loadProfile(e.o);
    const { preview } = await analyze(e.dir('work'), loaded === null ? {} : { profile: asSaved(loaded) });
    assert.ok(!seen.has(preview.id), `preview id repeated at revision ${preview.profileRevision}`);
    seen.set(preview.id, preview.profileRevision);
  };
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), e.o); await record();
  await setRuleEnabled(ruleIdFor(saved, '국어'), false, e.o); await record();
  await addCorrection({ type: 'file-name', name: '수학_과제3.pdf' }, '수학/숙제', e.o); await record();
  await disableProfile(e.o); await record();
  await enableProfile(e.o); await record();
  await resetProfile(e.o); await record();
  const revisions = [...seen.values()];
  assert.deepEqual(revisions.map((r) => r === null), [false, false, false, true, false, true]);
  const numbers = revisions.filter((r): r is number => r !== null);
  for (let i = 1; i < numbers.length; i++) assert.ok(numbers[i]! > numbers[i - 1]!);
});

test('V18-17 Unicode and case: NFD folder/file names and a case-variant reference path are still recognised', async (t) => {
  const nfd = (s: string): string => s.normalize('NFD');
  const e = await env(t, { [`work/${nfd('정리')}/${nfd('수학')}/${nfd('수학_과제1.pdf')}`]: 'a', [`work/${nfd('정리')}/${nfd('수학')}/${nfd('수학_과제2.pdf')}`]: 'b',
    [`work/${nfd('수학_과제9.pdf')}`]: 'c', [`work/${nfd('과학_보고.pdf')}`]: 'd', 'Ref/Docs/report_a.pdf': 'x', 'Ref/Docs/report_b.pdf': 'y' });
  const before = await oracle(e.base);
  await saveConfirmedProfile(await confirmedFrom(path.join(e.dir('work'), nfd('정리'))), e.o);
  const withName = await addCorrection({ type: 'file-name', name: '과학_보고.pdf' }, '과학', e.o); // NFC spelling
  const rows = table((await analyze(e.dir('work'), { profile: withName })).preview.items);
  const ref = Object.keys(rows).filter((k) => k.startsWith(nfd('정리')));
  assert.equal(ref.length, 2);
  for (const k of ref) assert.deepEqual(rows[k], ['keep', null, 'PROTECTED_REFERENCE'], k);
  assert.deepEqual(rows[nfd('수학_과제9.pdf')], ['move', `${nfd('수학')}/${nfd('수학_과제9.pdf')}`, 'PERSONAL_RULE']);
  assert.deepEqual(rows[nfd('과학_보고.pdf')], ['move', `과학/${nfd('과학_보고.pdf')}`, 'SAVED_CORRECTION']);
  if (process.platform === 'darwin') {
    // Case-insensitive default APFS: the same folder typed in another case is the same reference (real path is canonical).
    const s2 = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')), { stateDir: path.join(e.base, 'state2') });
    assert.equal(s2.referenceRootLabel, 'Ref');
    assertReferenceKept((await analyze(e.dir('Ref'), { profile: s2 })).preview, ['Docs/report_a.pdf', 'Docs/report_b.pdf']);
  }
  const after = await oracle(e.base);
  for (const key of Object.keys(before)) if (!key.startsWith('state')) assert.equal(after[key], before[key], key);
});

test('V18-16 AFO_STATE_DIR is honoured when no stateDir is given; the default app-data folder is never created by these tests', async (t) => {
  const e = await env(t, prefixed('ref', REF_SUBJECT));
  const previous = process.env['AFO_STATE_DIR'];
  process.env['AFO_STATE_DIR'] = e.state;
  t.after(() => { if (previous === undefined) delete process.env['AFO_STATE_DIR']; else process.env['AFO_STATE_DIR'] = previous; });
  assert.equal(await loadProfile(), null);
  const saved = await saveConfirmedProfile(await confirmedFrom(e.dir('ref')));
  assert.deepEqual(asSaved(await loadProfile({ stateDir: e.state })), saved);
  assert.ok(existsSync(path.join(e.state, 'profiles', 'active.json')));
  await resetProfile();
  assert.equal(await loadProfile({ stateDir: e.state }), null);
  // Runs last in this file: the fake HOME stayed empty and the real default folder was not created.
  assert.deepEqual(readdirSync(FAKE_HOME), [], 'nothing resolved a default state folder under HOME');
  if (process.platform === 'darwin' && !REAL_DEFAULT_EXISTED) assert.equal(existsSync(REAL_DEFAULT), false, 'real default state folder absent');
  t.diagnostic(`real default state folder existed before: ${REAL_DEFAULT_EXISTED}, after: ${existsSync(REAL_DEFAULT)}`);
});

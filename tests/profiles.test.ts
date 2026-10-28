import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AfoError, ProfileStoreSchema } from '../packages/contracts/src/index.js';
import type { ErrorCode, RuleProfile, RuleProfileV2 } from '../packages/contracts/src/index.js';
import { confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant, readReference } from '../packages/filesystem/src/index.js';
import { PROFILE_LOCK_WAIT_MS, addCorrection, disableProfile, enableProfile, loadProfile, profileFile, removeCorrection, resetProfile,
  saveConfirmedProfile, setRuleEnabled } from '../packages/filesystem/src/profiles.js';
import { withRootLock } from '../packages/filesystem/src/lock.js';
import type { ProfileStoreOptions } from '../packages/filesystem/src/profiles.js';
import { createFixture, manifest } from './helpers.js';
import type { TestContext } from 'node:test';

/* #18 profile store. State lives only in a fresh temp folder per test (stateDir / AFO_STATE_DIR); never the default app-data folder. */
const code = (expected: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === expected;
const REFERENCE = { '수학/수학_과제1.pdf': 'm1', '수학/수학_과제2.pdf': 'm2', '영어/영어_과제1.pdf': 'e1', '영어/영어_과제2.pdf': 'e2',
  '2026-10/사진1.jpg': 'p1', '2026-10/사진2.jpg': 'p2', '메모.txt': 'loose' };
const WORK = { '수학_과제3.pdf': 'new math', '영어 단어장.pdf': 'words', 'IMG_0001.JPG': 'photo', '수학영어_통합.pdf': 'both',
  '과학_보고서.pdf': 'science', 'backup.tar.gz': 'archive', '애매한파일': 'no extension' };
/** Hand-written expected destinations for WORK with every REFERENCE rule confirmed. */
const EXPECTED: Record<string, [string, string | null]> = {
  '수학_과제3.pdf': ['move', '수학/수학_과제3.pdf'], '영어 단어장.pdf': ['move', '영어/영어 단어장.pdf'],
  'IMG_0001.JPG': ['move', '2026-10/IMG_0001.JPG'], '수학영어_통합.pdf': ['review', null], '과학_보고서.pdf': ['move', '문서/과학_보고서.pdf'],
  'backup.tar.gz': ['move', '압축/backup.tar.gz'], '애매한파일': ['review', null],
};

async function setup(t: TestContext): Promise<{ base: string; reference: string; work: string; state: string; o: ProfileStoreOptions }> {
  const spec: Record<string, string> = { 'state/': '' };
  for (const [k, v] of Object.entries(REFERENCE)) spec[`reference/${k}`] = v;
  for (const [k, v] of Object.entries(WORK)) spec[`work/${k}`] = v;
  const { root: base } = await createFixture(spec, t);
  const state = path.join(base, 'state');
  return { base, reference: path.join(base, 'reference'), work: path.join(base, 'work'), state, o: { stateDir: state } };
}
async function confirmedFrom(reference: string): Promise<RuleProfile> {
  const draft = suggestProfile(await readReference(await issueReferenceGrant(reference)));
  return confirmProfile(draft, draft.rules.map((r) => r.id));
}
const outcome = (items: { source: string; action: string; destination: string | null }[]): Record<string, [string, string | null]> =>
  Object.fromEntries(items.map((i) => [i.source, [i.action, i.destination]]));
const asProfile = (value: Awaited<ReturnType<typeof loadProfile>>): RuleProfileV2 => {
  assert.ok(value !== null && value.status !== 'corrupt', 'expected a saved profile');
  return value as RuleProfileV2;
};

test('confirmed rules are saved in app state only; reference originals and work files keep paths and hashes', async (t) => {
  const { base, reference, work, state, o } = await setup(t);
  const before = await manifest(base);
  assert.equal(await loadProfile(o), null);
  const draft = suggestProfile(await readReference(await issueReferenceGrant(reference)));
  await assert.rejects(saveConfirmedProfile(draft, o), /확인한/u);
  assert.deepEqual(await readdir(state), [], 'a refused draft writes nothing');
  const saved = await saveConfirmedProfile(await confirmedFrom(reference), o);
  assert.equal(saved.status, 'confirmed'); assert.equal(saved.referenceRootLabel, 'reference');
  const raw = await readFile(profileFile(state), 'utf8');
  ProfileStoreSchema.parse(JSON.parse(raw));
  assert.ok(!raw.includes(base) && !raw.includes('메모.txt'), 'no absolute path or full reference listing is stored');
  assert.deepEqual(asProfile(await loadProfile(o)), saved);
  const { preview } = await analyzeRoot(await issueRootGrant(work), { profile: saved });
  assert.deepEqual(outcome(preview.items), EXPECTED);
  assert.equal(preview.profileId, saved.id); assert.equal(preview.profileRevision, saved.revision);
  const after = await manifest(base);
  for (const key of Object.keys(before)) if (!key.startsWith('state')) assert.deepEqual(after[key], before[key], key);
  // locks/ is the profile lock folder (#18 F-2); no lock file is left behind.
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before)).sort(), ['state/locks', 'state/profiles', 'state/profiles/active.json']);
});

test('restart: a separate node process saves, another reloads and reproduces the same classification', async (t) => {
  const { reference, work, state, o } = await setup(t);
  const url = (rel: string): string => new URL(rel, import.meta.url).href;
  const script = (body: string): string => `
    import * as fsx from ${JSON.stringify(url('../packages/filesystem/src/index.js'))};
    import * as store from ${JSON.stringify(url('../packages/filesystem/src/profiles.js'))};
    import * as engine from ${JSON.stringify(url('../packages/engine/src/index.js'))};
    const [reference, work] = process.argv.slice(1);
    ${body}`;
  const run = (body: string): string => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script(body), reference, work],
      { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AFO_STATE_DIR: state } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  run(`const draft = engine.suggestProfile(await fsx.readReference(await fsx.issueReferenceGrant(reference)));
    await store.saveConfirmedProfile(engine.confirmProfile(draft, draft.rules.map((r) => r.id)));
    await store.addCorrection({ type: 'file-name', name: '과학_보고서.pdf' }, '과학');`);
  const analyze = `const profile = await store.loadProfile();
    const { preview } = await fsx.analyzeRoot(await fsx.issueRootGrant(work), { profile });
    console.log(JSON.stringify({ profile, items: preview.items, id: preview.profileId, revision: preview.profileRevision }));`;
  const first = JSON.parse(run(analyze)) as { profile: RuleProfileV2; items: { source: string; action: string; destination: string | null }[] };
  const second = JSON.parse(run(analyze)) as typeof first;
  assert.deepEqual(second, first);
  assert.deepEqual(outcome(first.items), { ...EXPECTED, '과학_보고서.pdf': ['move', '과학/과학_보고서.pdf'] });
  // This (third) process reads the same file and gets the same answer.
  const profile = asProfile(await loadProfile(o));
  assert.deepEqual(profile, first.profile);
  const { preview } = await analyzeRoot(await issueRootGrant(work), { profile });
  assert.deepEqual(preview.items, first.items);
});

test('every change raises the revision, no-ops do not write, reset forgets rules but never reuses a revision', async (t) => {
  const { reference, work, state, o } = await setup(t);
  const v1 = await confirmedFrom(reference);
  const saved = await saveConfirmedProfile(v1, o);
  const math = saved.rules.find((r) => r.keyword === '수학')!.id;
  const off = await setRuleEnabled(math, false, o);
  assert.equal(off.revision, saved.revision + 1);
  const bytes = await readFile(profileFile(state), 'utf8');
  assert.equal((await setRuleEnabled(math, false, o)).revision, off.revision);
  assert.equal(await readFile(profileFile(state), 'utf8'), bytes, 'no-op leaves the file as it was');
  await assert.rejects(setRuleEnabled('missing', true, o));
  const grant = await issueRootGrant(work);
  const items = async (): Promise<Record<string, [string, string | null]>> => {
    const loaded = await loadProfile(o);
    assert.ok(loaded === null || loaded.status !== 'corrupt');
    return outcome((await analyzeRoot(grant, loaded ? { profile: loaded } : {})).preview.items);
  };
  assert.deepEqual((await items())['수학_과제3.pdf'], ['move', '문서/수학_과제3.pdf']);
  const disabled = await disableProfile(o);
  assert.equal(disabled.revision, off.revision + 1);
  assert.deepEqual((await items())['IMG_0001.JPG'], ['move', '이미지/IMG_0001.JPG']);
  assert.equal((await analyzeRoot(grant, { profile: disabled })).preview.profileRevision, null);
  const enabled = await enableProfile(o);
  const corrected = await addCorrection({ type: 'keyword', extension: '.pdf', keyword: '과학' }, '과학', o);
  assert.deepEqual([enabled.revision, corrected.revision], [disabled.revision + 1, disabled.revision + 2]);
  assert.deepEqual((await items())['과학_보고서.pdf'], ['move', '과학/과학_보고서.pdf']);
  const uncorrected = await removeCorrection(corrected.corrections[0]!.id, o);
  assert.equal(uncorrected.revision, corrected.revision + 1);
  await resetProfile(o);
  assert.equal(await loadProfile(o), null);
  const emptied = ProfileStoreSchema.parse(JSON.parse(await readFile(profileFile(state), 'utf8')));
  assert.deepEqual(emptied.state === 'empty' && [emptied.formatVersion, emptied.lastRevision], [2, uncorrected.revision]);
  await assert.rejects(setRuleEnabled(math, true, o), /없습니다/u);
  assert.deepEqual((await items())['수학_과제3.pdf'], ['move', '문서/수학_과제3.pdf']);
  const again = await saveConfirmedProfile(v1, o);
  assert.equal(again.id, saved.id);
  assert.ok(again.revision > uncorrected.revision, 'same profile ID after reset gets a new, higher revision');
  // A correction with no saved profile creates a correction-only profile above the old revisions too.
  await resetProfile(o);
  const fresh = await addCorrection({ type: 'file-name', name: '애매한파일' }, '기타', o);
  assert.ok(fresh.revision > again.revision); assert.equal(fresh.rules.length, 0); assert.equal(fresh.referenceRootLabel, null);
  assert.deepEqual((await items())['애매한파일'], ['move', '기타/애매한파일']);
});

test('corrupt profiles are reported for re-confirmation, never applied or deleted; explicit save sets them aside', async (t) => {
  const { reference, state, o } = await setup(t);
  const v1 = await confirmedFrom(reference);
  const draft = suggestProfile(await readReference(await issueReferenceGrant(reference)));
  const good = JSON.stringify({ formatVersion: 2, state: 'active', profile: await saveConfirmedProfile(v1, o) });
  const file = profileFile(state);
  const cases: [string, string | Uint8Array, RegExp][] = [
    ['truncated JSON', good.slice(0, Math.floor(good.length / 2)), /JSON/u],
    ['schema violation', good.replace(/"revision": ?\d+/u, '"revision":-1'), /계약/u],
    ['hidden target', good.replace(/"targetDirectory":"수학"/u, '"targetDirectory":".수학"'), /계약/u],
    ['v1 draft', JSON.stringify(draft), /초안/u],
    ['bare v1 confirmed', JSON.stringify(v1), /이전 형식/u],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), /JSON/u],
  ];
  for (const [label, content, reason] of cases) {
    await writeFile(file, content);
    const loaded = await loadProfile(o);
    assert.ok(loaded !== null && loaded.status === 'corrupt', label);
    assert.match((loaded as { reason: string }).reason, reason, label);
    await assert.rejects(setRuleEnabled(v1.rules[0]!.id, false, o), code('STATE_CORRUPT'), label);
    await assert.rejects(disableProfile(o), code('STATE_CORRUPT'), label);
    await assert.rejects(addCorrection({ type: 'file-name', name: 'a.pdf' }, 'x', o), code('STATE_CORRUPT'), label);
    assert.deepEqual(new Uint8Array(await readFile(file)), typeof content === 'string' ? new TextEncoder().encode(content) : content,
      `${label}: damaged file is left exactly as found`);
  }
  // A directory in place of the file is also corrupt, not "no profile".
  const dirState = path.join(state, 'other');
  await mkdir(path.join(dirState, 'profiles', 'active.json'), { recursive: true });
  assert.equal((await loadProfile({ stateDir: dirState }) as { status: string }).status, 'corrupt');
  // Explicit save over the damaged file keeps it under profiles/corrupt-*.json.
  const damaged = await readFile(file);
  const saved = await saveConfirmedProfile(v1, o);
  assert.equal(asProfile(await loadProfile(o)).revision, saved.revision);
  const aside = (await readdir(path.dirname(file))).filter((n) => n.startsWith('corrupt-'));
  assert.equal(aside.length, 1);
  assert.deepEqual(await readFile(path.join(path.dirname(file), aside[0]!)), damaged);
  // Reset over a damaged file also sets it aside instead of deleting it.
  await writeFile(file, '{');
  await resetProfile(o);
  assert.equal(await loadProfile(o), null);
  assert.equal((await readdir(path.dirname(file))).filter((n) => n.startsWith('corrupt-')).length, 2);
});

test('expectedRevision refuses a profile that changed in between, without writing', async (t) => {
  const { reference, state, o } = await setup(t);
  const saved = await saveConfirmedProfile(await confirmedFrom(reference), o);
  const ruleId = saved.rules[0]!.id;
  await setRuleEnabled(ruleId, false, o); // another process
  const bytes = await readFile(profileFile(state), 'utf8');
  await assert.rejects(setRuleEnabled(ruleId, true, { ...o, expectedRevision: saved.revision }), code('PROFILE_CHANGED'));
  await assert.rejects(saveConfirmedProfile(await confirmedFrom(reference), { ...o, expectedRevision: saved.revision }), code('PROFILE_CHANGED'));
  await assert.rejects(resetProfile({ ...o, expectedRevision: saved.revision }), code('PROFILE_CHANGED'));
  assert.equal(await readFile(profileFile(state), 'utf8'), bytes);
  assert.equal((await setRuleEnabled(ruleId, true, { ...o, expectedRevision: saved.revision + 1 })).revision, saved.revision + 2);
});

test('overlapping roots after restart: the saved reference folder is recognised by ID and its files are kept', async (t) => {
  const { root } = await createFixture({ '정리/수학/수학_과제1.pdf': 'm1', '정리/수학/수학_과제2.pdf': 'm2', '정리/영어/영어_과제1.pdf': 'e1',
    '정리/영어/영어_과제2.pdf': 'e2', '정리/섞임.pdf': 'loose ref', 'inbox/수학_과제3.pdf': 'new' }, t);
  const o = { stateDir: (await createFixture({}, t)).root };
  const before = await manifest(root);
  await saveConfirmedProfile(await confirmedFrom(path.join(root, '정리')), o);
  const profile = asProfile(await loadProfile(o));
  // Reference folder inside the work root: its files are protected, only the new file moves.
  const outer = await analyzeRoot(await issueRootGrant(root), { profile });
  assert.deepEqual(outcome(outer.preview.items), {
    'inbox/수학_과제3.pdf': ['move', '수학/수학_과제3.pdf'], '정리/섞임.pdf': ['keep', null],
    '정리/수학/수학_과제1.pdf': ['keep', null], '정리/수학/수학_과제2.pdf': ['keep', null],
    '정리/영어/영어_과제1.pdf': ['keep', null], '정리/영어/영어_과제2.pdf': ['keep', null],
  });
  assert.ok(outer.protected.every((p) => p.relativePath.startsWith('정리/')) && outer.protected.length === 5);
  // Work root equal to or inside the reference folder: everything there is the reference's own content.
  for (const inner of ['정리', '정리/수학']) {
    const { preview } = await analyzeRoot(await issueRootGrant(path.join(root, ...inner.split('/'))), { profile });
    assert.ok(preview.items.every((i) => i.action === 'keep' && i.reasonCode === 'PROTECTED_REFERENCE'), inner);
  }
  // A different work root: same relative targets, nothing protected there.
  const { preview } = await analyzeRoot(await issueRootGrant(path.join(root, 'inbox')), { profile });
  assert.deepEqual(outcome(preview.items), { '수학_과제3.pdf': ['move', '수학/수학_과제3.pdf'] });
  assert.deepEqual(await manifest(root), before);
});

/* ---- verifier follow-ups: F-1, O-2, O-3, O-4 ---- */
const IN_WORK = { '정리/수학/수학_과제1.pdf': 'm1', '정리/수학/수학_과제2.pdf': 'm2', '정리/국어/국어_a.pdf': 'k1', '정리/국어/국어_b.pdf': 'k2',
  '수학_과제5.pdf': 'new' };
const ORIGINALS = ['수학/수학_과제1.pdf', '수학/수학_과제2.pdf', '국어/국어_a.pdf', '국어/국어_b.pdf'];
async function savedInside(t: TestContext): Promise<{ root: string; o: ProfileStoreOptions; profile: RuleProfileV2 }> {
  const { root } = await createFixture(IN_WORK, t);
  const o = { stateDir: (await createFixture({}, t)).root };
  return { root, o, profile: await saveConfirmedProfile(await confirmedFrom(path.join(root, '정리')), o) };
}

test('F-1 saved profiles record the reference folder dev/inode; an unchanged reference is not stale', async (t) => {
  const { root, o, profile } = await savedInside(t);
  const s = await lstat(path.join(root, '정리'), { bigint: true });
  assert.deepEqual(profile.referenceRootIdentity, { device: String(s.dev), inode: String(s.ino) });
  const { preview } = await analyzeRoot(await issueRootGrant(root), { profile, ...o });
  assert.equal(preview.profileNotice, undefined);
  assert.equal(preview.profileId, profile.id);
  assert.deepEqual(outcome(preview.items)['수학_과제5.pdf'], ['move', '수학/수학_과제5.pdf']);
});

test('F-1 reference folder renamed or moved inside the work root: originals kept, profile stale and not applied', async (t) => {
  const { root, o, profile } = await savedInside(t);
  await mkdir(path.join(root, '보관'));
  for (const [from, to] of [['정리', '정리2'], ['정리2', '보관/정리3']] as const) {
    await rename(path.join(root, ...from.split('/')), path.join(root, ...to.split('/')));
    const before = await manifest(root);
    const { preview, protected: kept } = await analyzeRoot(await issueRootGrant(root), { profile, ...o });
    const rows = outcome(preview.items);
    for (const p of ORIGINALS) assert.deepEqual(rows[`${to}/${p}`], ['keep', null], `${to}/${p}`);
    assert.deepEqual(kept.map((k) => k.relativePath).sort(), ORIGINALS.map((p) => `${to}/${p}`).sort());
    assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
    assert.equal(preview.profileId, null, 'stale profile is not applied');
    assert.deepEqual(rows['수학_과제5.pdf'], ['move', '문서/수학_과제5.pdf'], 'default rules only until re-confirmed');
    assert.deepEqual(await manifest(root), before);
    assert.equal(asProfile(await loadProfile(o)).status, 'confirmed', 'analysis never writes the store');
  }
});

test('F-1 dev/inode alone recognises a renamed reference whose example files were also renamed', async (t) => {
  const { root, o, profile } = await savedInside(t);
  await rename(path.join(root, '정리'), path.join(root, '새이름'));
  // Only one saved example keeps its name, so evidence matching alone could not find the folder.
  for (const [from, to] of [['수학/수학_과제1.pdf', '수학/수학_과제1_v2.pdf'], ['국어/국어_a.pdf', '국어/국어_a2.pdf'], ['국어/국어_b.pdf', '국어/국어_b2.pdf']] as const)
    await rename(path.join(root, '새이름', ...from.split('/')), path.join(root, '새이름', ...to.split('/')));
  const { preview } = await analyzeRoot(await issueRootGrant(root), { profile, ...o });
  const kept = preview.items.filter((i) => i.source.startsWith('새이름/'));
  assert.equal(kept.length, 4);
  assert.ok(kept.every((i) => i.action === 'keep' && i.reasonCode === 'PROTECTED_REFERENCE'));
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
  assert.match(preview.profileNotice!.reason, /이름이나 위치/u);
});

test('F-1 a copy of the reference (new inode) is caught by its evidence examples, with or without a stored identity', async (t) => {
  const { root, o, profile } = await savedInside(t);
  await cp(path.join(root, '정리'), path.join(root, '사본'), { recursive: true });
  const { referenceRootIdentity: _unused, ...legacy } = profile;
  for (const candidate of [profile, { ...profile, referenceRootIdentity: null }, legacy]) {
    const { preview } = await analyzeRoot(await issueRootGrant(root), { profile: candidate, ...o });
    const rows = outcome(preview.items);
    for (const p of ORIGINALS) {
      assert.deepEqual(rows[`사본/${p}`], ['keep', null], `사본/${p}`);
      assert.deepEqual(rows[`정리/${p}`], ['keep', null], `정리/${p}`);
    }
    assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
    assert.match(preview.profileNotice!.reason, /사본/u);
  }
  // A work root that is itself a copy of the reference folder: everything kept.
  const { preview } = await analyzeRoot(await issueRootGrant(path.join(root, '사본')), { profile, ...o });
  assert.ok(preview.items.every((i) => i.action === 'keep' && i.reasonCode === 'PROTECTED_REFERENCE'));
  assert.equal(preview.profileNotice?.code, 'PROFILE_STALE');
});

test('O-2 analysis refuses a state folder inside, equal to or containing the work root, and inside the reference folder', async (t) => {
  const { root } = await createFixture({ 'work/a.pdf': 'a', 'work/appstate/': '', 'ref/수학/x.pdf': 'x', 'ref/수학/y.pdf': 'y' }, t);
  const work = path.join(root, 'work');
  const grant = await issueRootGrant(work);
  for (const stateDir of [path.join(work, 'appstate'), work, root])
    await assert.rejects(analyzeRoot(grant, { stateDir }), code('STATE_DIR_CONFLICT'), stateDir);
  const reference = await issueReferenceGrant(path.join(root, 'ref'));
  await assert.rejects(analyzeRoot(grant, { stateDir: path.join(root, 'ref', '.afo'), reference }), code('STATE_DIR_CONFLICT'));
  const outside = (await createFixture({}, t)).root;
  assert.equal((await analyzeRoot(grant, { stateDir: outside, reference })).preview.items.length, 1);
  // AFO_STATE_DIR is the default when no stateDir is passed.
  const previous = process.env['AFO_STATE_DIR'];
  process.env['AFO_STATE_DIR'] = path.join(work, 'appstate');
  try { await assert.rejects(analyzeRoot(grant), code('STATE_DIR_CONFLICT')); }
  finally { if (previous === undefined) delete process.env['AFO_STATE_DIR']; else process.env['AFO_STATE_DIR'] = previous; }
});

test('O-3 one-off override destinations follow the saved-correction rule: hidden, escaping or absolute folders are refused', async (t) => {
  const { root } = await createFixture({ 'a.pdf': 'a' }, t);
  const o = { stateDir: (await createFixture({}, t)).root };
  const grant = await issueRootGrant(root);
  const id = (await analyzeRoot(grant, o)).preview.items[0]!.fileId;
  for (const bad of ['.숨김', '보관/.git', '../밖', '/abs', ''])
    await assert.rejects(analyzeRoot(grant, { ...o, overrides: { [id]: bad } }), Error, bad);
  assert.deepEqual(outcome((await analyzeRoot(grant, { ...o, overrides: { [id]: '보관/2026' } })).preview.items), { 'a.pdf': ['move', '보관/2026/a.pdf'] });
});

test('O-4 expectedRevision null pins an empty store; expectedCorrupt pins the damaged file seen', async (t) => {
  const { reference, state, o } = await setup(t);
  const v1 = await confirmedFrom(reference);
  const file = profileFile(state);
  // Empty store: null passes for a first correction or save; another writer in between is refused.
  const first = await addCorrection({ type: 'file-name', name: 'a.pdf' }, '보관', { ...o, expectedRevision: null });
  await assert.rejects(addCorrection({ type: 'file-name', name: 'b.pdf' }, '보관', { ...o, expectedRevision: null }), code('PROFILE_CHANGED'));
  await assert.rejects(saveConfirmedProfile(v1, { ...o, expectedRevision: null }), code('PROFILE_CHANGED'));
  assert.equal(asProfile(await loadProfile(o)).revision, first.revision);
  await resetProfile({ ...o, expectedRevision: first.revision });
  const saved = await saveConfirmedProfile(v1, { ...o, expectedRevision: null });
  await assert.rejects(resetProfile({ ...o, expectedRevision: null }), code('PROFILE_CHANGED'));
  // Damaged store: only the fingerprint of the file that was seen allows save/reset over it.
  await writeFile(file, '{ broken');
  const seen = await loadProfile(o);
  assert.ok(seen !== null && seen.status === 'corrupt');
  const fp = (seen as { fingerprint: string }).fingerprint;
  await assert.rejects(resetProfile({ ...o, expectedRevision: saved.revision }), code('PROFILE_CHANGED'));
  await assert.rejects(resetProfile({ ...o, expectedRevision: null }), code('PROFILE_CHANGED'));
  await writeFile(file, '{ broken differently');
  await assert.rejects(resetProfile({ ...o, expectedCorrupt: fp }), code('PROFILE_CHANGED'));
  await assert.rejects(saveConfirmedProfile(v1, { ...o, expectedCorrupt: fp }), code('PROFILE_CHANGED'));
  assert.equal(await readFile(file, 'utf8'), '{ broken differently', 'refused calls leave the damaged file in place');
  assert.deepEqual((await readdir(path.dirname(file))).filter((n) => n.startsWith('corrupt-')), []);
  const now = await loadProfile(o) as { fingerprint: string };
  await resetProfile({ ...o, expectedCorrupt: now.fingerprint });
  assert.equal(await loadProfile(o), null);
  // A fingerprint is not accepted for a healthy store.
  await assert.rejects(saveConfirmedProfile(v1, { ...o, expectedCorrupt: now.fingerprint }), code('PROFILE_CHANGED'));
});

test('F-2 changes wait for the profile lock: released soon → the change runs; still held → LOCKED_BY_OTHER, nothing written', async (t) => {
  const { state, o } = await setup(t);
  const profiles = path.join(state, 'profiles');
  await mkdir(profiles);
  const s = await lstat(profiles, { bigint: true });
  const identity = { device: String(s.dev), inode: String(s.ino) };
  let release!: () => void;
  const held = withRootLock(state, identity, () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((r) => setTimeout(r, 50));
  const waiting = addCorrection({ type: 'file-name', name: 'a.pdf' }, '보관', { ...o, expectedRevision: null });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await loadProfile(o), null, 'nothing written while the lock is held');
  release(); await held;
  assert.equal((await waiting).corrections.length, 1);
  const started = Date.now();
  await withRootLock(state, identity, async () => {
    await assert.rejects(addCorrection({ type: 'file-name', name: 'b.pdf' }, '보관', o), code('LOCKED_BY_OTHER'));
    assert.ok(Date.now() - started >= PROFILE_LOCK_WAIT_MS, 'retried for the whole wait');
    assert.equal(asProfile(await loadProfile(o)).corrections.length, 1);
  });
  assert.deepEqual(await readdir(path.join(state, 'locks')), [], 'no lock file left behind');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AfoError, ProfileStoreSchema } from '../packages/contracts/src/index.js';
import type { ErrorCode, RuleProfile, RuleProfileV2 } from '../packages/contracts/src/index.js';
import { confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant, readReference } from '../packages/filesystem/src/index.js';
import { addCorrection, disableProfile, enableProfile, loadProfile, profileFile, removeCorrection, resetProfile, saveConfirmedProfile,
  setRuleEnabled } from '../packages/filesystem/src/profiles.js';
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
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before)).sort(), ['state/profiles', 'state/profiles/active.json']);
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

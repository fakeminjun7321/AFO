import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewSchema, RuleProfileV2Schema } from '../packages/contracts/src/index.js';
import type { RuleProfileV2 } from '../packages/contracts/src/index.js';
import { buildPreview, classifyFile, confirmProfile, makeCorrection, profileFromV1, suggestProfile, withCorrection, withRuleEnabled,
  withStatus, withoutCorrection } from '../packages/engine/src/index.js';
import { scanFixture } from './helpers.js';

/* #18 personal rules, pure engine. Expected answers are written by hand from the reference examples. */
const NOW = new Date('2026-10-26T03:00:00.000Z');
const LATER = new Date('2026-10-26T04:00:00.000Z');
const saved = (reference: string[]): RuleProfileV2 => {
  const draft = suggestProfile(scanFixture(reference));
  return profileFromV1(confirmProfile(draft, draft.rules.map((r) => r.id)), NOW);
};
const subjects = (): RuleProfileV2 => saved(['수학/수학_과제1.pdf', '수학/수학_과제2.pdf', '영어/영어_과제1.pdf', '영어/영어_과제2.pdf']);
const rows = (names: string[], options: Parameters<typeof buildPreview>[1] = {}): [string, string, string | null, string | undefined][] =>
  buildPreview(scanFixture(names), options).items.map((i) => [i.source, i.action, i.destination, i.reasonCode]);
const ruleId = (p: RuleProfileV2, keyword: string | null): string => p.rules.find((r) => r.keyword === keyword)!.id;

test('subject-named reference folders become keyword rules; ambiguous and unmatched files are not forced', () => {
  const profile = subjects();
  assert.deepEqual(profile.rules.map((r) => [r.extension, r.keyword, r.targetDirectory, r.enabled]).sort(),
    [['.pdf', '수학', '수학', true], ['.pdf', '영어', '영어', true]]);
  assert.deepEqual(rows(['수학_과제3.pdf', '영어 단어장.pdf', '과학_보고서.pdf', '수학영어_통합.pdf', 'memo.txt'], { profile }), [
    ['수학_과제3.pdf', 'move', '수학/수학_과제3.pdf', 'PERSONAL_RULE'],
    ['영어 단어장.pdf', 'move', '영어/영어 단어장.pdf', 'PERSONAL_RULE'],
    ['과학_보고서.pdf', 'move', '문서/과학_보고서.pdf', 'DEFAULT_EXTENSION'],
    ['수학영어_통합.pdf', 'review', null, 'RULE_CONFLICT'],
    ['memo.txt', 'move', '문서/memo.txt', 'DEFAULT_EXTENSION'],
  ]);
});

test('date-named folders: one folder per extension is a rule, several unexplained date folders are not evidence', () => {
  const profile = saved(['2026-10/사진1.jpg', '2026-10/사진2.jpg']);
  assert.deepEqual(profile.rules.map((r) => [r.keyword, r.targetDirectory]), [[null, '2026-10']]);
  assert.deepEqual(rows(['IMG_0001.JPG'], { profile }), [['IMG_0001.JPG', 'move', '2026-10/IMG_0001.JPG', 'PERSONAL_RULE']]);
  const weak = suggestProfile(scanFixture(['2026-09/a.jpg', '2026-09/b.jpg', '2026-10/c.jpg', '2026-10/d.jpg']));
  assert.deepEqual(weak.rules, []);
  assert.deepEqual(rows(['IMG_0002.jpg']), [['IMG_0002.jpg', 'move', '이미지/IMG_0002.jpg', 'DEFAULT_EXTENSION']]);
});

test('priority: one-off override > saved correction (exact name > keyword) > personal rule > default', () => {
  let profile = subjects();
  profile = withCorrection(profile, makeCorrection({ type: 'file-name', name: '수학_과제3.PDF' }, '보관', NOW), NOW);
  profile = withCorrection(profile, makeCorrection({ type: 'keyword', extension: '.pdf', keyword: '영어' }, '영어자료', NOW), NOW);
  profile = withCorrection(profile, makeCorrection({ type: 'file-name', name: '영어 단어장.pdf' }, '단어', NOW), NOW);
  const scan = scanFixture(['수학_과제3.pdf', '수학_과제4.pdf', '영어_과제3.pdf', '영어 단어장.pdf', 'x.hwp']);
  const preview = buildPreview(scan, { profile, overrides: { [scan.files[0]!.id]: '이번만' } });
  assert.deepEqual(preview.items.map((i) => [i.destination, i.reasonCode]), [
    ['이번만/수학_과제3.pdf', 'USER_OVERRIDE'], ['수학/수학_과제4.pdf', 'PERSONAL_RULE'],
    ['영어자료/영어_과제3.pdf', 'SAVED_CORRECTION'], ['단어/영어 단어장.pdf', 'SAVED_CORRECTION'], ['문서/x.hwp', 'DEFAULT_EXTENSION'],
  ]);
  // Without the one-off override the saved correction applies.
  assert.deepEqual(rows(['수학_과제3.pdf'], { profile }), [['수학_과제3.pdf', 'move', '보관/수학_과제3.pdf', 'SAVED_CORRECTION']]);
  // Two keyword corrections with different targets: review, not an arbitrary pick.
  const clash = withCorrection(profile, makeCorrection({ type: 'keyword', extension: '.pdf', keyword: '통합' }, '통합본', NOW), NOW);
  assert.deepEqual(rows(['영어_통합.pdf'], { profile: clash }), [['영어_통합.pdf', 'review', null, 'RULE_CONFLICT']]);
});

test('one-off overrides never change the profile; "from now on" corrections are explicit, versioned and removable', () => {
  const profile = subjects();
  const snapshot = JSON.stringify(profile);
  const scan = scanFixture(['과학.pdf']);
  assert.equal(buildPreview(scan, { profile, overrides: { [scan.files[0]!.id]: '과학' } }).items[0]!.destination, '과학/과학.pdf');
  assert.equal(JSON.stringify(profile), snapshot);
  assert.equal(buildPreview(scan, { profile }).items[0]!.destination, '문서/과학.pdf');
  const c = makeCorrection({ type: 'keyword', extension: '.pdf', keyword: '과학' }, '과학', NOW);
  const remembered = withCorrection(profile, c, LATER);
  assert.equal(remembered.revision, profile.revision + 1);
  assert.equal(remembered.updatedAt, LATER.toISOString());
  assert.equal(buildPreview(scan, { profile: remembered }).items[0]!.destination, '과학/과학.pdf');
  assert.equal(withCorrection(remembered, c, LATER), remembered, 'same correction again is not a change');
  const moved = withCorrection(remembered, makeCorrection(c.match, '자연과학', NOW), LATER);
  assert.equal(moved.corrections.length, 1, 'same match replaces the earlier correction');
  assert.equal(buildPreview(scan, { profile: moved }).items[0]!.destination, '자연과학/과학.pdf');
  const removed = withoutCorrection(moved, moved.corrections[0]!.id, LATER);
  assert.equal(removed.revision, moved.revision + 1);
  assert.equal(buildPreview(scan, { profile: removed }).items[0]!.destination, '문서/과학.pdf');
  assert.throws(() => withoutCorrection(removed, 'ffffffffffffffff'));
});

test('disabled rules and disabled profiles are never applied; every change raises the revision', () => {
  const profile = subjects();
  const off = withRuleEnabled(profile, ruleId(profile, '수학'), false, LATER);
  assert.equal(off.revision, profile.revision + 1);
  assert.equal(withRuleEnabled(off, ruleId(profile, '수학'), false, LATER), off);
  assert.deepEqual(rows(['수학_과제3.pdf', '영어_과제3.pdf'], { profile: off }).map((r) => r[2]), ['문서/수학_과제3.pdf', '영어/영어_과제3.pdf']);
  assert.throws(() => withRuleEnabled(profile, 'missing', false));
  const disabled = withStatus(off, 'disabled', LATER);
  const preview = buildPreview(scanFixture(['영어_과제3.pdf']), { profile: disabled });
  assert.equal(preview.items[0]!.destination, '문서/영어_과제3.pdf');
  assert.equal(preview.profileId, null); assert.equal(preview.profileRevision, null);
  const again = withStatus(disabled, 'confirmed', LATER);
  assert.deepEqual([off.revision, disabled.revision, again.revision], [profile.revision + 1, profile.revision + 2, profile.revision + 3]);
  assert.equal(buildPreview(scanFixture(['영어_과제3.pdf']), { profile: again }).items[0]!.destination, '영어/영어_과제3.pdf');
});

test('previews carry profileId/revision and change identity with every revision, so old approvals cannot carry over', () => {
  const profile = subjects();
  const scan = scanFixture(['수학_과제3.pdf']);
  const preview = PreviewSchema.parse(buildPreview(scan, { profile }));
  assert.equal(preview.profileId, profile.id); assert.equal(preview.profileRevision, profile.revision);
  const changed = withRuleEnabled(profile, ruleId(profile, '영어'), false, LATER);
  const next = buildPreview(scan, { profile: changed });
  assert.equal(next.profileRevision, profile.revision + 1);
  assert.notEqual(next.id, preview.id);
  assert.equal(buildPreview(scan).profileId, null);
});

test('files already inside a personal folder stay put (overlapping or re-used roots); loose files still move', () => {
  const profile = subjects();
  assert.deepEqual(rows(['수학/수학_과제1.pdf', '수학/영어_메모.pdf', '수학/2025/old.hwp', 'inbox/수학_과제5.pdf'], { profile }), [
    ['수학/수학_과제1.pdf', 'keep', '수학/수학_과제1.pdf', 'ALREADY_PLACED'],
    ['수학/영어_메모.pdf', 'keep', '수학/영어_메모.pdf', 'ALREADY_PLACED'],
    ['수학/2025/old.hwp', 'keep', '수학/2025/old.hwp', 'ALREADY_PLACED'],
    ['inbox/수학_과제5.pdf', 'move', '수학/수학_과제5.pdf', 'PERSONAL_RULE'],
  ]);
  assert.match(buildPreview(scanFixture(['수학/영어_메모.pdf']), { profile }).items[0]!.reason, /개인 정리 폴더\(수학\)/u);
  // A disabled rule no longer marks its folder as personal.
  const off = withRuleEnabled(profile, ruleId(profile, '수학'), false, LATER);
  assert.deepEqual(rows(['수학/영어_메모.pdf'], { profile: off }), [['수학/영어_메모.pdf', 'move', '영어/영어_메모.pdf', 'PERSONAL_RULE']]);
});

test('missing or blocked destinations and impossible paths are review items', () => {
  const profile = subjects();
  // '수학' exists as a file in the work root: the folder cannot be created there.
  assert.deepEqual(rows(['수학', '수학_과제3.pdf'], { profile })[1], ['수학_과제3.pdf', 'review', null, 'DEST_CONFLICT']);
  const long = withCorrection(profile, makeCorrection({ type: 'keyword', extension: '.pdf', keyword: null }, 'a'.repeat(4090), NOW), NOW);
  assert.deepEqual(rows(['long-name.pdf'], { profile: long }), [['long-name.pdf', 'review', null, 'DEST_INVALID']]);
});

test('.tar.gz and .tgz are archives; other double extensions stay review even when a learned rule matches', () => {
  assert.equal(classifyFile('backup.tar.gz').targetDirectory, '압축');
  assert.equal(classifyFile('backup.TAR.GZ').targetDirectory, '압축');
  assert.equal(classifyFile('backup.tgz').targetDirectory, '압축');
  assert.equal(classifyFile('invoice.pdf.exe').reasonCode, 'COMPOUND_EXTENSION');
  // default-3: a pure archive outer extension is an archive whatever is inside.
  for (const name of ['photo.jpg.zip', 'a.tar.zip']) assert.equal(classifyFile(name).targetDirectory, '압축', name);
  let profile = saved(['설치파일/a.exe', '설치파일/b.exe']);
  assert.equal(classifyFile('setup.exe', { profile }).targetDirectory, '설치파일');
  assert.equal(classifyFile('invoice.pdf.exe', { profile }).reasonCode, 'COMPOUND_EXTENSION');
  profile = withCorrection(profile, makeCorrection({ type: 'file-name', name: 'invoice.pdf.exe' }, '검사', NOW), NOW);
  assert.equal(classifyFile('invoice.pdf.exe', { profile }).targetDirectory, '검사');
});

test('personal rules never create deletion candidates or change duplicate detection', () => {
  const scan = scanFixture(['수학_과제3.pdf', 'copy/수학_과제3.pdf', '영어.pdf']);
  scan.files[0]!.sha256 = 'c'.repeat(64); scan.files[1]!.sha256 = 'c'.repeat(64); scan.files[2]!.sha256 = 'd'.repeat(64);
  const plain = buildPreview(scan); const personal = buildPreview(scan, { profile: subjects() });
  assert.deepEqual(personal.duplicates, plain.duplicates);
  assert.deepEqual(personal.largeFiles, plain.largeFiles);
  assert.ok(personal.items.every((i) => ['move', 'keep', 'review'].includes(i.action)));
});

test('v1 → v2 keeps confirmed rules only, drops absolute paths and the full reference list', () => {
  const reference = ['자료/1.pdf', '자료/2.pdf', '자료/3.pdf', '자료/4.pdf', '자료/5.pdf', 'loose.txt'];
  const draft = suggestProfile(scanFixture(reference));
  assert.throws(() => profileFromV1(draft), /확인한/u);
  const confirmed = confirmProfile(draft, [draft.rules[0]!.id]);
  assert.throws(() => profileFromV1({ ...confirmed, status: 'disabled' }), /확인한/u);
  const v2 = profileFromV1(confirmed, NOW);
  assert.equal(v2.formatVersion, 2); assert.equal(v2.id, confirmed.id); assert.equal(v2.revision, confirmed.revision);
  assert.equal(v2.referenceRootLabel, 'afo-fixture'); assert.equal(v2.referenceRootId, confirmed.referenceRoot.id);
  assert.deepEqual(v2.rules[0]!.evidence, ['자료/1.pdf', '자료/2.pdf', '자료/3.pdf']);
  assert.equal(v2.rules[0]!.evidenceCount, 5);
  const json = JSON.stringify(v2);
  assert.ok(!json.includes('/afo-fixture') && !json.includes('loose.txt') && !json.includes('canonicalPath'));
  const windows = profileFromV1({ ...confirmed, referenceRoot: { ...confirmed.referenceRoot, canonicalPath: 'C:\\Users\\u\\정리된 자료' } }, NOW);
  assert.equal(windows.referenceRootLabel, '정리된 자료');
});

test('v2 contract rejects drafts, hidden targets, duplicate matches, path labels and oversized evidence', () => {
  const ok = subjects();
  assert.equal(RuleProfileV2Schema.safeParse(ok).success, true);
  const bad: [string, unknown][] = [
    ['draft status', { ...ok, status: 'draft' }],
    ['format 1', { ...ok, formatVersion: 1 }],
    ['revision 0', { ...ok, revision: 0 }],
    ['hidden target', { ...ok, rules: [{ ...ok.rules[0]!, targetDirectory: '수학/.secret' }] }],
    ['escaping target', { ...ok, rules: [{ ...ok.rules[0]!, targetDirectory: '../밖' }] }],
    ['path as label', { ...ok, referenceRootLabel: '/Users/u/정리' }],
    ['evidence over limit', { ...ok, rules: [{ ...ok.rules[0]!, evidence: ['a/1.pdf', 'a/2.pdf', 'a/3.pdf', 'a/4.pdf'], evidenceCount: 4 }] }],
    ['count below examples', { ...ok, rules: [{ ...ok.rules[0]!, evidenceCount: 1 }] }],
    ['missing enabled', { ...ok, rules: [{ ...ok.rules[0]!, enabled: undefined }] }],
    ['extra field', { ...ok, referenceRoot: { canonicalPath: '/x' } }],
    ['duplicate match', { ...ok, corrections: [makeCorrection({ type: 'file-name', name: 'A.pdf' }, 'x', NOW),
      { ...makeCorrection({ type: 'file-name', name: 'a.PDF' }, 'y', NOW) }] }],
    ['name with folder', { ...ok, corrections: [{ ...makeCorrection({ type: 'file-name', name: 'a.pdf' }, 'x', NOW),
      match: { type: 'file-name', name: 'sub/a.pdf' } }] }],
  ];
  for (const [label, value] of bad) assert.equal(RuleProfileV2Schema.safeParse(value).success, false, label);
});

test('O-3 one-off overrides use the same destination rule as saved corrections (no hidden folders)', () => {
  const scan = scanFixture(['a.pdf']);
  for (const bad of ['.숨김', '보관/.cache', '../밖'])
    assert.throws(() => buildPreview(scan, { overrides: { [scan.files[0]!.id]: bad } }), Error, bad);
  assert.throws(() => classifyFile('a.pdf', { override: '.숨김' }));
  assert.equal(classifyFile('a.pdf', { override: '보관/숨김아님' }).targetDirectory, '보관/숨김아님');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewSchema, ProfileSchema, isAfoError } from '../packages/contracts/src/index.js';
import type { ScanResult } from '../packages/contracts/src/index.js';
import { CLASSIFICATION_VERSION, LARGE_FILE_BYTES, buildPreview, chooseKeeper, classifyFile, confirmProfile, suggestProfile }
  from '../packages/engine/src/index.js';
import { scanFixture } from './helpers.js';

/** Independent expected answers (written for default-2, unchanged in default-3), by hand (not derived from the engine tables). */
const oracle: [string, 'move' | 'keep' | 'review', string | null, string][] = [
  ['보고서.PDF', 'move', '문서/보고서.PDF', 'DEFAULT_EXTENSION'],
  ['사진.JPEG', 'move', '이미지/사진.JPEG', 'DEFAULT_EXTENSION'],
  ['Clip.Mp4', 'move', '영상/Clip.Mp4', 'DEFAULT_EXTENSION'],
  ['노래.flac', 'move', '음악/노래.flac', 'DEFAULT_EXTENSION'],
  ['setup.MSI', 'move', '설치/setup.MSI', 'DEFAULT_EXTENSION'],
  ['자료.zip', 'move', '압축/자료.zip', 'DEFAULT_EXTENSION'],
  ['v1.2 보고서.최종.hwpx', 'move', '문서/v1.2 보고서.최종.hwpx', 'DEFAULT_EXTENSION'],
  ['backup.tar.gz', 'move', '압축/backup.tar.gz', 'DEFAULT_EXTENSION'],
  ['backup.TGZ', 'move', '압축/backup.TGZ', 'DEFAULT_EXTENSION'],
  ['invoice.pdf.exe', 'review', null, 'COMPOUND_EXTENSION'],
  ['README', 'review', null, 'NO_EXTENSION'],
  ['data.xyz', 'review', null, 'UNKNOWN_EXTENSION'],
  ['문서/기존.pdf', 'keep', '문서/기존.pdf', 'ALREADY_PLACED'],
];
const hashed = (entries: [string, number, string | null, number | null][]): ScanResult => {
  const scan = scanFixture(entries.map(([name]) => name));
  entries.forEach(([, size, sha, allocated], i) => Object.assign(scan.files[i]!, { size, sha256: sha, allocatedBytes: allocated }));
  return scan;
};

test('basic classification is explainable, deterministic and preview only', () => {
  const scan = scanFixture(['사진.JPEG', '보고서.hwpx', 'unknown', '문서/기존.pdf']);
  const result = buildPreview(scan);
  assert.deepEqual(result.items.map((x) => [x.action, x.destination]), [
    ['move', '이미지/사진.JPEG'], ['move', '문서/보고서.hwpx'], ['review', null], ['keep', '문서/기존.pdf'],
  ]);
  assert.equal(result.id, buildPreview(scan).id);
  assert.equal(result.executionAvailable, false);
  assert.equal(result.mode, 'preview-only');
});
test('existing destinations and parent files are never overwritten', () => {
  assert.equal(buildPreview(scanFixture(['a.pdf', '문서/a.pdf'])).items[0]!.action, 'review');
  assert.equal(buildPreview(scanFixture(['a.pdf', '문서'])).items[0]!.action, 'review');
});
test('case and Unicode destination collisions affect every proposed source', () => {
  const scan = scanFixture(['a/REPORT.pdf', 'b/report.PDF', 'c/가.pdf', 'd/가.pdf']);
  assert.deepEqual(buildPreview(scan).items.map((x) => x.action), ['review', 'review', 'review', 'review']);
});
test('a proposed file cannot also become another proposed file parent folder', () => {
  const scan = scanFixture(['a.pdf', 'b.txt']);
  const result = buildPreview(scan, { overrides: {
    [scan.files[0]!.id]: '자료', [scan.files[1]!.id]: '자료/a.pdf',
  } });
  assert.deepEqual(result.items.map((x) => x.action), ['review', 'review']);
});
test('equal names are not duplicates without matching content hashes', () => {
  const scan = scanFixture(['a/report.pdf', 'b/report.pdf']);
  scan.files[0]!.sha256 = '1'.repeat(64); scan.files[1]!.sha256 = '2'.repeat(64);
  assert.deepEqual(buildPreview(scan).duplicates, []);
});
test('duplicate candidates preserve protected references and label logical bytes', () => {
  const scan = scanFixture(['copy.pdf', '참고/original.pdf', 'other.pdf']);
  for (const file of scan.files) file.sha256 = 'b'.repeat(64);
  const result = buildPreview(scan, { protectedPaths: ['참고/original.pdf'] });
  assert.equal(result.duplicates[0]!.suggestedKeep, '참고/original.pdf');
  assert.deepEqual(result.duplicates[0]!.candidates, ['copy.pdf', 'other.pdf']);
  assert.equal(result.duplicates[0]!.logicalCandidateBytes, 40);
  assert.equal(result.items[1]!.action, 'keep');
});
test('reference metadata proposes only draft rules with independent examples', () => {
  const p = suggestProfile(scanFixture(['자료/first.pdf', '자료/second.pdf', '사진/one.jpg']));
  assert.equal(p.status, 'draft'); assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]!.targetDirectory, '자료');
  assert.equal(p.rules[0]!.evidence.length, 2);
});
test('ambiguous extension-only references need supporting filename keywords', () => {
  const unknown = suggestProfile(scanFixture(['A/a.pdf', 'A/b.pdf', 'B/c.pdf', 'B/d.pdf']));
  assert.equal(unknown.rules.length, 0);
  const p = suggestProfile(scanFixture(['과제/물리/물리_1.pdf', '과제/물리/물리_2.pdf', '과제/화학/화학_1.pdf', '과제/화학/화학_2.pdf']));
  assert.deepEqual(p.rules.map((r) => r.keyword).sort(), ['물리', '화학']);
});
test('unconfirmed or disabled rules never replace default classification', () => {
  const p = suggestProfile(scanFixture(['개인/first.pdf', '개인/second.pdf']));
  const scan = scanFixture(['new.pdf']);
  assert.equal(buildPreview(scan, { profile: p }).items[0]!.destination, '문서/new.pdf');
  assert.equal(buildPreview(scan, { profile: { ...p, status: 'disabled' } }).items[0]!.destination, '문서/new.pdf');
});
test('confirmation is explicit; unknown, repeated or empty selection is rejected', () => {
  const p = suggestProfile(scanFixture(['개인/a.pdf', '개인/b.pdf']));
  assert.throws(() => confirmProfile(p, []));
  assert.throws(() => confirmProfile(p, ['missing']));
  assert.throws(() => confirmProfile(p, [p.rules[0]!.id, p.rules[0]!.id]));
  const confirmed = confirmProfile(p, [p.rules[0]!.id]);
  assert.equal(confirmed.status, 'confirmed'); assert.equal(p.status, 'draft');
  assert.equal(buildPreview(scanFixture(['new.pdf']), { profile: confirmed }).items[0]!.destination, '개인/new.pdf');
});
test('explicit one-off edits override personal rules without modifying the profile', () => {
  const draft = suggestProfile(scanFixture(['개인/a.pdf', '개인/b.pdf']));
  const profile = confirmProfile(draft, [draft.rules[0]!.id]);
  const scan = scanFixture(['new.pdf']);
  const original = JSON.stringify(profile);
  assert.equal(buildPreview(scan, { profile, overrides: { [scan.files[0]!.id]: '이번만' } }).items[0]!.destination, '이번만/new.pdf');
  assert.equal(JSON.stringify(profile), original);
  assert.throws(() => buildPreview(scan, { overrides: { [scan.files[0]!.id]: '../bad' } }));
});
test('conflicting confirmed rules require review rather than arbitrary selection', () => {
  const p = suggestProfile(scanFixture(['개인/a.pdf', '개인/b.pdf']));
  const r = p.rules[0]!;
  const profile = { ...p, status: 'confirmed', rules: [r, { ...r, id: 'different', targetDirectory: '다른곳' }] };
  assert.equal(buildPreview(scanFixture(['new.pdf']), { profile }).items[0]!.action, 'review');
});
test('profile revisions change the plan identity and corrupt evidence is rejected', () => {
  const p = suggestProfile(scanFixture(['개인/a.pdf', '개인/b.pdf']));
  const confirmed = confirmProfile(p, [p.rules[0]!.id]);
  const scan = scanFixture(['new.pdf']);
  assert.notEqual(buildPreview(scan, { profile: confirmed }).id, buildPreview(scan, { profile: { ...confirmed, revision: 3 } }).id);
  assert.throws(() => ProfileSchema.parse({ ...p, rules: [{ ...p.rules[0], evidence: ['no.pdf', 'no2.pdf'] }] }));
  assert.throws(() => ProfileSchema.parse({ ...p, rules: [{ ...p.rules[0], evidence: ['개인/a.pdf', '개인/a.pdf'] }] }));
});
test('partial scans cannot create reference rules; hash failures require review', () => {
  const scan = scanFixture(['a.pdf']); scan.complete = false;
  scan.skipped.push({ relativePath: 'a.pdf', reason: 'hash failed' });
  assert.throws(() => suggestProfile(scan));
  assert.equal(buildPreview(scan).items[0]!.action, 'review');
});

/* ---- #7 classification and duplicates ---- */
test('default-3 classification matches an independent oracle with reasons and a rule version', () => {
  const preview = buildPreview(scanFixture(oracle.map(([name]) => name)));
  assert.equal(preview.classificationVersion, CLASSIFICATION_VERSION);
  assert.equal(CLASSIFICATION_VERSION, 'default-3');
  assert.deepEqual(preview.items.map((i) => [i.source, i.action, i.destination, i.reasonCode]), oracle);
  for (const item of preview.items) assert.ok(item.reason.length > 0);
  assert.match(preview.items[0]!.reason, /default-3/u);
});
test('identical input gives identical output and id; changed input changes the id', () => {
  const names = ['a.pdf', 'b.jpg', 'c', 'd/e.tar.gz'];
  const first = buildPreview(scanFixture(names)); const second = buildPreview(scanFixture(names));
  assert.deepEqual(first, second);
  const changed = scanFixture(names); changed.files[0]!.modifiedNs = '999';
  assert.notEqual(buildPreview(changed).id, first.id);
});
test('classifyFile is the shared interface: explicit override > confirmed personal rule > default; drafts ignored', () => {
  const draft = suggestProfile(scanFixture(['개인/a.pdf', '개인/b.pdf']));
  const confirmed = confirmProfile(draft, [draft.rules[0]!.id]);
  assert.deepEqual(classifyFile('new.pdf'), { targetDirectory: '문서', category: '문서', ruleId: null, source: 'default',
    reasonCode: 'DEFAULT_EXTENSION', reason: '확장자(.pdf)에 따른 기본 분류(default-3)입니다.' });
  assert.equal(classifyFile('new.pdf', { profile: draft }).source, 'default');
  assert.equal(classifyFile('new.pdf', { profile: confirmed }).targetDirectory, '개인');
  assert.equal(classifyFile('new.pdf', { profile: confirmed, override: '이번만' }).targetDirectory, '이번만');
  assert.equal(classifyFile('archive.pdf.exe', { profile: confirmed }).reasonCode, 'COMPOUND_EXTENSION');
  assert.throws(() => classifyFile('../x.pdf'));
  assert.throws(() => classifyFile('a.pdf', { override: '/abs' }));
});
test('large files are informational only: never duplicate candidates without equal content', () => {
  const scan = hashed([['huge.mov', LARGE_FILE_BYTES + 1, '1'.repeat(64), null], ['huge2.mov', LARGE_FILE_BYTES + 1, '2'.repeat(64), null]]);
  const preview = buildPreview(scan);
  assert.deepEqual(preview.largeFiles, ['huge.mov', 'huge2.mov']);
  assert.deepEqual(preview.duplicates, []);
  assert.ok(preview.items.every((i) => i.action === 'move'));
});
test('empty files are never duplicate candidates and the reason is shown', () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const preview = buildPreview(hashed([['a.txt', 0, empty, 0], ['b.txt', 0, empty, 0]]));
  assert.deepEqual(preview.duplicates, []);
  assert.deepEqual(preview.duplicateNotes!.map((n) => [n.relativePath, n.code]), [['a.txt', 'EMPTY_FILE'], ['b.txt', 'EMPTY_FILE']]);
});
test('logical, allocated and reclaimable estimates are kept apart and protected files never count', () => {
  const sha = 'c'.repeat(64);
  const preview = buildPreview(hashed([['ref/orig.pdf', 1000, sha, 4096], ['copy1.pdf', 1000, sha, 4096], ['copy2.pdf', 1000, sha, null]]),
    { protectedPaths: ['ref/orig.pdf'] });
  const group = preview.duplicates[0]!;
  assert.equal(group.suggestedKeep, 'ref/orig.pdf');
  assert.deepEqual(group.candidates, ['copy1.pdf', 'copy2.pdf']);
  assert.equal(group.logicalCandidateBytes, 2000);
  assert.equal(group.allocatedCandidateBytes, null, 'unknown allocation is not guessed');
  assert.equal(group.reclaimableEstimateBytes, 4096 + 1000);
  assert.deepEqual(preview.space, { logicalCandidateBytes: 2000, allocatedCandidateBytes: null, reclaimableEstimateBytes: 5096,
    note: preview.space!.note });
  assert.match(preview.space!.note, /추정/u); assert.match(preview.space!.note, /휴지통/u);
  const known = buildPreview(hashed([['a.pdf', 10, sha, 4096], ['b.pdf', 10, sha, 4096]]));
  assert.equal(known.duplicates[0]!.allocatedCandidateBytes, 4096);
  assert.equal(known.space!.allocatedCandidateBytes, 4096);
});
test('chooseKeeper returns a new preview with the chosen original kept and totals recomputed', () => {
  const sha = 'd'.repeat(64);
  const preview = buildPreview(hashed([['a.pdf', 100, sha, 4096], ['b.pdf', 100, sha, 8192], ['c.pdf', 100, sha, 4096]]));
  const snapshot = JSON.stringify(preview);
  assert.equal(preview.duplicates[0]!.suggestedKeep, 'a.pdf');
  const changed = chooseKeeper(preview, sha, 'b.pdf');
  assert.equal(JSON.stringify(preview), snapshot, 'input is not modified');
  assert.equal(changed.duplicates[0]!.suggestedKeep, 'b.pdf');
  assert.deepEqual(changed.duplicates[0]!.candidates, ['a.pdf', 'c.pdf']);
  assert.equal(changed.duplicates[0]!.reclaimableEstimateBytes, 8192);
  assert.notEqual(changed.id, preview.id);
  assert.deepEqual(chooseKeeper(preview, sha, 'b.pdf'), changed, 'deterministic');
  const keepTwo = chooseKeeper(preview, sha, 'b.pdf', { candidates: ['c.pdf'] });
  assert.deepEqual(keepTwo.duplicates[0]!.candidates, ['c.pdf']);
  assert.equal(keepTwo.space!.logicalCandidateBytes, 100);
  PreviewSchema.parse(keepTwo);
});
test('chooseKeeper refuses paths outside the group, protected candidates and unknown groups', () => {
  const sha = 'e'.repeat(64);
  const preview = buildPreview(hashed([['ref/orig.pdf', 100, sha, null], ['a.pdf', 100, sha, null], ['b.pdf', 100, sha, null],
    ['other.pdf', 100, 'f'.repeat(64), null]]), { protectedPaths: ['ref/orig.pdf'] });
  const rejects = (fn: () => unknown): void => assert.throws(fn, (e: unknown) => isAfoError(e, 'KEEPER_INVALID'));
  rejects(() => chooseKeeper(preview, '0'.repeat(64), 'a.pdf'));
  rejects(() => chooseKeeper(preview, sha, 'other.pdf'));
  rejects(() => chooseKeeper(preview, sha, 'missing.pdf'));
  rejects(() => chooseKeeper(preview, sha, 'a.pdf', { candidates: ['ref/orig.pdf'] }));
  rejects(() => chooseKeeper(preview, sha, 'a.pdf', { candidates: ['a.pdf'] }));
  rejects(() => chooseKeeper(preview, sha, 'a.pdf', { candidates: ['other.pdf'] }));
  rejects(() => chooseKeeper(preview, sha, 'a.pdf', { candidates: ['b.pdf', 'b.pdf'] }));
  assert.throws(() => chooseKeeper(preview, sha, '../a.pdf'));
  // Keeping something other than the protected original never makes the original a candidate.
  const kept = chooseKeeper(preview, sha, 'a.pdf');
  assert.deepEqual(kept.duplicates[0]!.candidates, ['b.pdf']);
  const forged = structuredClone(preview); forged.duplicates[0]!.candidates.push('ref/orig.pdf');
  assert.throws(() => PreviewSchema.parse(forged));
  assert.throws(() => chooseKeeper(forged, sha, 'a.pdf'));
});

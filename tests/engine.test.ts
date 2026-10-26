import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileSchema } from '../packages/contracts/src/index.js';
import { buildPreview, confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { scanFixture } from './helpers.js';

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

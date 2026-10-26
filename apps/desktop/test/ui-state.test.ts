import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/*
 * The browser screen's selection state (public/state.js, plain JS shared with app.js), tested in Node.
 * Logic only: real rendering, focus and screen-reader output still need a browser check.
 */
// Compiled to apps/desktop/dist/apps/desktop/test/; public/ stays in apps/desktop/public/.
const stateUrl = pathToFileURL(path.join(import.meta.dirname, '..', '..', '..', '..', 'public', 'state.js')).href;
const ui: any = await import(stateUrl);
const work = { type: 'selected', grantId: 'a'.repeat(64), path: '/tmp/work' };
const ref = { type: 'selected', grantId: 'b'.repeat(64), path: '/tmp/ref' };

test('a refused work choice clears the work folder and disables analysis (no silent fallback)', () => {
  let s = ui.applySelection(ui.initialState(), 'work', work).state;
  assert.equal(ui.canAnalyze(s), true);
  const refusedResult = ui.applySelection(s, 'work', { type: 'refused', code: 'ROOT_FORBIDDEN', message: '홈 전체…' });
  s = refusedResult.state;
  assert.equal(s.work, null); assert.equal(ui.canAnalyze(s), false); assert.equal(refusedResult.error, true);
  assert.match(refusedResult.message, /선택한 작업 폴더가 없습니다/u);
  assert.equal(ui.analysisRequest(s).rootGrantId, null);
});

test('a refused reference choice clears the reference folder; work stays', () => {
  let s = ui.applySelection(ui.applySelection(ui.initialState(), 'work', work).state, 'reference', ref).state;
  const r = ui.applySelection(s, 'reference', { type: 'refused', code: 'ROOT_FORBIDDEN', message: 'x' });
  s = r.state;
  assert.equal(s.reference, null); assert.equal(s.work.grantId, work.grantId);
  assert.match(r.message, /참고 폴더 없음/u);
  assert.deepEqual(ui.analysisRequest(s), { rootGrantId: work.grantId, referenceGrantId: null, profileId: null });
});

test('cancel and non-choice errors (dialog busy/unavailable, offline) keep the current selection and say so', () => {
  const s = ui.applySelection(ui.initialState(), 'work', work).state;
  const cancelled = ui.applySelection(s, 'work', { type: 'cancelled' });
  assert.equal(cancelled.state, s); assert.match(cancelled.message, /현재 작업 폴더: \/tmp\/work/u);
  for (const code of ['PICKER_BUSY', 'PICKER_UNAVAILABLE', 'OFFLINE', 'INVALID_RESPONSE']) {
    const r = ui.applySelection(s, 'work', { type: 'refused', code, message: 'm' });
    assert.equal(r.state, s, code); assert.match(r.message, /현재 작업 폴더/u);
  }
});

test('confirmed rules carry into every analysis of the same selection and are released when a folder changes', () => {
  let s = ui.applySelection(ui.applySelection(ui.initialState(), 'work', work).state, 'reference', ref).state;
  s = ui.confirmRules(s, 'profile-0001', ['r1']);
  assert.equal(ui.analysisRequest(s).profileId, 'profile-0001');
  assert.equal(ui.analysisRequest(s).profileId, 'profile-0001'); // a second analysis keeps it
  const changes: Array<[string, unknown]> = [['work', work], ['reference', ref], ['reference', { type: 'skipped' }],
    ['work', { type: 'refused', code: 'ROOT_FORBIDDEN', message: 'x' }]];
  for (const [kind, outcome] of changes) {
    const r = ui.applySelection(s, kind, outcome);
    assert.equal(r.state.profileId, null, `${kind} ${JSON.stringify(outcome)}`); assert.deepEqual(r.state.appliedRuleIds, []);
    assert.match(r.message, /확인한 규칙은 폴더가 바뀌어 해제/u);
  }
  assert.equal(ui.applySelection(s, 'work', { type: 'cancelled' }).state.profileId, 'profile-0001');
  assert.equal(ui.releaseRules(s).profileId, null);
});

test('rule checkbox names describe the rule; the duplicate text does not promise a keeper control', () => {
  assert.equal(ui.ruleText({ extension: '.pdf', keyword: null, targetDirectory: '수업자료/물리' }), '.pdf 파일 → 수업자료/물리');
  assert.equal(ui.ruleText({ extension: '.jpg', keyword: '여름', targetDirectory: '사진/여름' }), '.jpg 파일(이름에 "여름" 포함) → 사진/여름');
  const shown = ui.keepReasonForScreen('경로 순서상 첫 파일을 기본으로 남깁니다. 남길 파일은 바꿀 수 있습니다.');
  assert.doesNotMatch(shown, /바꿀 수 있습니다/u);
  assert.match(shown, /^경로 순서상 첫 파일을 기본으로 남깁니다\. 이 화면에서는 남길 파일을 바꿀 수 없습니다/u);
  assert.match(ui.keepReasonForScreen(undefined), /^이 화면에서는/u);
});

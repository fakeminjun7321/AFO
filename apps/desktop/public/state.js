// Screen selection state (pure, no DOM): what the screen holds after each user choice. Imported by app.js and by
// apps/desktop/test so the rules below are tested without a browser. Mirrors the server: a refused choice clears that folder.

/** Errors that are not a folder choice (dialog could not open/is busy, network): the previous selection stays. */
export const NOT_A_CHOICE = new Set(['PICKER_BUSY', 'PICKER_UNAVAILABLE', 'OFFLINE', 'INVALID_RESPONSE']);

export const initialState = () => ({ work: null, reference: null, profileId: null, appliedRuleIds: [] });

/**
 * outcome: { type: 'selected', grantId, path } | { type: 'cancelled' } | { type: 'refused', code, message } | { type: 'skipped' }
 * Returns { state, message, error }. Changing either folder (including a refusal or skipping the reference)
 * releases confirmed rules: they were confirmed for the previous pair.
 */
export function applySelection(state, kind, outcome) {
  const label = kind === 'work' ? '작업 폴더' : '참고 폴더(읽기 전용)';
  if (outcome.type === 'cancelled')
    return { state, error: false, message: `선택을 취소했습니다. ${current(state, kind)}` };
  if (outcome.type === 'refused' && NOT_A_CHOICE.has(outcome.code))
    return { state, error: true, message: `${outcome.message} (${outcome.code}) — ${current(state, kind)}` };
  const released = state.profileId !== null ? ' 확인한 규칙은 폴더가 바뀌어 해제했습니다.' : '';
  const next = { ...state, profileId: null, appliedRuleIds: [] };
  if (outcome.type === 'selected') {
    next[kind] = { grantId: outcome.grantId, path: outcome.path };
    return { state: next, error: false, message: `${label}: ${outcome.path}${released}` };
  }
  next[kind] = null;
  if (outcome.type === 'skipped') return { state: next, error: false, message: `참고 폴더 없음(건너뜀).${released}` };
  // refused: the server has also dropped the previous folder of this kind.
  const after = kind === 'work' ? '선택한 작업 폴더가 없습니다. 분석하려면 폴더를 다시 선택하세요.'
    : '참고 폴더 없음(이전 참고 폴더 선택도 해제했습니다).';
  return { state: next, error: true, message: `선택하지 못했습니다: ${outcome.message} (${outcome.code}). ${after}${released}` };
}
function current(state, kind) {
  const held = state[kind];
  if (kind === 'work') return held ? `현재 작업 폴더: ${held.path}` : '선택한 작업 폴더가 없습니다.';
  return held ? `현재 참고 폴더: ${held.path}` : '참고 폴더 없음(건너뜀).';
}

export const canAnalyze = (state) => state.work !== null;
/** Confirmed rules stay applied to every analysis of the same work + reference selection. */
export const analysisRequest = (state) => ({ rootGrantId: state.work ? state.work.grantId : null,
  referenceGrantId: state.reference ? state.reference.grantId : null, profileId: state.profileId });
export const confirmRules = (state, profileId, ruleIds) => ({ ...state, profileId, appliedRuleIds: [...ruleIds] });
export const releaseRules = (state) => ({ ...state, profileId: null, appliedRuleIds: [] });

/* ---- Display text ---- */
/** Accessible name and visible text of a rule checkbox. */
export const ruleText = (rule) => `${rule.extension} 파일${rule.keyword ? `(이름에 "${rule.keyword}" 포함)` : ''} → ${rule.targetDirectory}`;
/** The shared engine's default keepReason says the keeper can be changed; this screen has no control for that yet. */
export const keepReasonForScreen = (reason) =>
  [String(reason ?? '').replace(/\s*남길 파일은 바꿀 수 있습니다\.?/u, '').trim(), '이 화면에서는 남길 파일을 바꿀 수 없습니다(제안만 표시).']
    .filter(Boolean).join(' ');
